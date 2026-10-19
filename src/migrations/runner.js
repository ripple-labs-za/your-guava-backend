const mongoose = require('mongoose');
const Migration = require('../models/Migration.model');
const logger = require('../utils/logger');
const registry = require('./index');
const { isDraining } = require('../utils/lifecycle');

const KIND_ORDER = { expand: 0, data: 1, contract: 2 };
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const MAX_RUNS_KEPT = 20;

const ordered = (migrations) =>
  migrations
    .map((migration, index) => ({ migration, index }))
    .sort((a, b) => (KIND_ORDER[a.migration.kind] - KIND_ORDER[b.migration.kind]) || (a.index - b.index))
    .map(({ migration }) => migration);

const contextFor = (dryRun) => ({ connection: mongoose.connection, db: mongoose.connection.db, dryRun });

// A lease, not a flag: a runner that dies mid-migration frees it when lockedUntil passes.
const acquire = async (migration, { by, leaseMs }) => {
  const now = new Date();
  try {
    return await Migration.findOneAndUpdate(
      { _id: migration.name, $or: [{ status: { $ne: 'running' } }, { lockedUntil: { $lt: now } }] },
      {
        $set: {
          status: 'running',
          kind: migration.kind,
          mode: migration.mode,
          startedAt: now,
          lockedUntil: new Date(now.getTime() + leaseMs),
          lockedBy: by,
        },
        $inc: { attempts: 1 },
      },
      { upsert: true, new: true, lean: true }
    );
  } catch (error) {
    if (error.code === 11000) return null; // another runner holds a live lease
    throw error;
  }
};

const ownership = (migration, lock) => ({ _id: migration.name, status: 'running', attempts: lock.attempts });

const finish = (migration, { status, lock, by, stats, error }) => {
  const { startedAt } = lock;
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - new Date(startedAt).getTime();
  const run = { status, by, startedAt, finishedAt, durationMs, ...(stats ? { stats } : {}), ...(error ? { error } : {}) };
  return Migration.updateOne(
    ownership(migration, lock),
    {
      $set: { status, finishedAt, durationMs, ...(stats ? { stats } : {}), ...(error ? { lastError: error } : {}) },
      $unset: { lockedUntil: 1, lockedBy: 1, ...(error ? {} : { lastError: 1 }) },
      $push: { runs: { $each: [run], $slice: -MAX_RUNS_KEPT } },
    }
  );
};

const selectMigrations = (migrations, names) => {
  const unknown = names.filter((name) => !migrations.some((migration) => migration.name === name));
  if (unknown.length > 0) throw new Error(`unknown migration: ${unknown.join(', ')}`);
  return ordered(migrations).filter((migration) =>
    (names.length > 0 ? names.includes(migration.name) : migration.mode === 'auto'));
};

const runOne = async (migration, { by, leaseMs, result, warnedLocks }) => {
  const ctx = contextFor(false);
  const before = await migration.check(ctx);
  if (!before.pending) {
    const ledger = await Migration.findById(migration.name).select('status').lean();
    if (ledger?.status === 'applied') {
      result.skipped.push(migration.name);
      logger.info('migration_skipped', { name: migration.name, reason: 'up_to_date' });
      return true;
    }
  }
  const lock = await acquire(migration, { by, leaseMs });
  if (!lock) {
    result.locked.push(migration.name);
    const level = warnedLocks.has(migration.name) ? 'debug' : 'warn';
    logger[level]('migration_locked', { name: migration.name });
    warnedLocks.add(migration.name);
    return false;
  }
  let renewal = Promise.resolve();
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    renewal = renewal.then(async () => {
      const updated = await Migration.updateOne(ownership(migration, lock), {
        $set: { lockedUntil: new Date(Date.now() + leaseMs) },
      });
      if (updated.modifiedCount === 0) leaseLost = true;
    }).catch(() => { leaseLost = true; });
  }, Math.max(10, Math.min(30000, Math.floor(leaseMs / 3))));
  heartbeat.unref();
  try {
    // Another runner may have completed after our preflight but before we
    // acquired the lease. Never act on a stale index/data snapshot.
    const current = await migration.check(ctx);
    if (!current.pending) {
      const saved = await finish(migration, { status: 'applied', lock, by,
        stats: { alreadyInTargetState: true, detail: current.detail } });
      if (saved.modifiedCount === 0) throw new Error('migration lease lost');
      result.verified.push(migration.name);
      logger.info('migration_verified', { name: migration.name, detail: current.detail });
      return true;
    }
    logger.info('migration_started', { name: migration.name, kind: migration.kind, by, detail: current.detail });
    const stats = (await migration.up(ctx)) || {};
    const after = await migration.check(ctx);
    // An explicit rescore can always be repeated. All convergent repairs and
    // automatic migrations must reach their target before we record success.
    if (after.pending && !(migration.mode === 'manual' && migration.repeatable)) {
      throw new Error(`ran but is still pending: ${after.detail}`);
    }
    if (leaseLost) throw new Error('migration lease lost');
    const saved = await finish(migration, { status: 'applied', lock, by, stats });
    if (saved.modifiedCount === 0) throw new Error('migration lease lost');
    result.applied.push(migration.name);
    logger.info('migration_applied', { name: migration.name, stats });
    return true;
  } catch (error) {
    await finish(migration, {
      status: 'failed',
      lock,
      by,
      error: String(error.message || error).slice(0, 500),
    }).catch(() => null);
    result.failed.push(migration.name);
    logger.error('migration_failed', { name: migration.name, ...logger.errorFields(error) });
    return false;
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
};

const runMigrations = async ({
  migrations = registry, names = [], by = 'startup', leaseMs = DEFAULT_LEASE_MS, warnedLocks = new Set(),
} = {}) => {
  const result = { applied: [], verified: [], skipped: [], failed: [], locked: [] };
  for (const migration of selectMigrations(migrations, names)) {
    // Later migrations may depend on this one, so the first failure stops the run.
    if (!(await runOne(migration, { by, leaseMs, result, warnedLocks }))) break;
  }
  logger.info('migrations_complete', result);
  return result;
};

const runStartupMigrations = async ({ migrations = registry, retryDelayMs = 5000 } = {}) => {
  try {
    // server.js tracks this entire promise, including lease waits, as background
    // work. A dead deploy's lease must recover without needing another restart.
    let result = { applied: [], verified: [], skipped: [], failed: [], locked: [] };
    const warnedLocks = new Set();
    do {
      if (isDraining()) break;
      result = await runMigrations({ migrations, by: 'startup', warnedLocks });
      if (result.locked.length > 0 && !isDraining()) {
        await new Promise((resolve) => {
          const deadline = Date.now() + retryDelayMs;
          // Notice shutdown within 100 ms without shortening the lease retry
          // cadence or adding a process-wide listener for each startup attempt.
          const poll = () => {
            const remaining = deadline - Date.now();
            if (isDraining() || remaining <= 0) return resolve();
            const timer = setTimeout(poll, Math.min(100, remaining));
            timer.unref();
          };
          poll();
        });
      }
    } while (result.locked.length > 0 && !isDraining());
    return result;
  } catch (error) {
    logger.error('migrations_crashed', logger.errorFields(error, { stack: true }));
    return { applied: [], verified: [], skipped: [], failed: ['(runner)'], locked: [] };
  }
};

const migrationReadiness = async ({ migrations = registry } = {}) => {
  // Mongoose buffers model queries while disconnected (up to 10 s). A readiness
  // probe during an outage must answer at once; the database check already says why.
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return { ok: false, pending: [], running: [], failed: [], state: 'database_unavailable' };
  }
  const auto = migrations.filter((migration) => migration.mode === 'auto');
  const ledgers = await Migration.find({ _id: { $in: auto.map((migration) => migration.name) } })
    .select('status lockedUntil')
    .lean();
  const byName = new Map(ledgers.map((ledger) => [ledger._id, ledger]));
  const pending = [];
  const running = [];
  const failed = [];
  for (const migration of auto) {
    const ledger = byName.get(migration.name);
    if (ledger?.status === 'running' && new Date(ledger.lockedUntil) > new Date()) {
      running.push(migration.name);
      continue;
    }
    const { pending: isPending } = await migration.check(contextFor(true));
    if (isPending) (ledger?.status === 'failed' ? failed : pending).push(migration.name);
  }
  return { ok: pending.length === 0 && running.length === 0 && failed.length === 0, pending, running, failed };
};

const migrationStatus = async ({ migrations = registry } = {}) => {
  const rows = [];
  for (const migration of ordered(migrations)) {
    const ledger = await Migration.findById(migration.name).select('status finishedAt').lean();
    const { pending, detail } = await migration.check(contextFor(true));
    rows.push({
      name: migration.name,
      mode: migration.mode,
      kind: migration.kind,
      ledgerStatus: ledger?.status || 'never run',
      lastRunAt: ledger?.finishedAt || null,
      pending,
      detail,
    });
  }
  return rows;
};

// Never print credentials: keep scheme, hosts and database only.
const safeTarget = (uri) => String(uri || '').replace(/\/\/[^@/]*@/, '//').split('?')[0];

const cli = async (argv = process.argv.slice(2)) => {
  require('dotenv').config();
  const apply = argv.includes('--apply');
  const names = argv.filter((arg) => !arg.startsWith('--'));
  // A report must not create collections/indexes as a side effect of loading
  // Mongoose models. Apply steps explicitly ensure the indexes they need.
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000, autoCreate: false, autoIndex: false,
  });
  try {
    logger.printLine(`${apply ? 'APPLYING' : 'DRY RUN (nothing is written)'} on ${safeTarget(process.env.MONGODB_URI)}`);
    for (const row of await migrationStatus()) {
      logger.printLine(
        `  ${row.name.padEnd(24)} ${row.mode.padEnd(6)} ${row.kind.padEnd(8)} ledger=${row.ledgerStatus}  pending=${row.pending}  ${row.detail}`
      );
    }
    if (!apply) {
      logger.printLine('Re-run with --apply to run pending automatic migrations, or --apply <name> for a manual one.');
      return 0;
    }
    const result = await runMigrations({ names, by: 'cli' });
    logger.printLine(JSON.stringify(result));
    return result.failed.length > 0 ? 1 : 0;
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  cli().then((code) => process.exit(code), (error) => {
    logger.fatal('migration_cli_failed', logger.errorFields(error));
    process.exit(1);
  });
}

module.exports = { runMigrations, runStartupMigrations, migrationReadiness, migrationStatus, cli };
