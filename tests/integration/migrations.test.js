const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Item = require('../../src/models/Item.model');
const Migration = require('../../src/models/Migration.model');
const { runMigrations, migrationReadiness } = require('../../src/migrations/runner');
const widen = require('../../src/migrations/widen-receipt-index');
const recategorise = require('../../src/migrations/recategorise-items');
const { dropIndexIfPresent } = require('../../src/migrations/indexTools');

const request = supertest(app);
const LEGACY_OPTIONS = { unique: true, partialFilterExpression: { receiptId: { $type: 'string' } } };
const transactions = () => mongoose.connection.db.collection('transactions');
const indexKeys = async () => (await transactions().indexes()).map((index) => JSON.stringify(index.key));
const createLegacyIndex = () => transactions().createIndex(widen.LEGACY_KEY, LEGACY_OPTIONS);
const sale = (cafeId, receiptId, iso) => ({
  cafeId,
  receiptId,
  date: new Date(iso),
  total: 35,
  items: [{ name: 'Latte', quantity: 1 }],
});
const fake = (name, kind, log, { pending = true, fail = false } = {}) => ({
  name,
  kind,
  mode: 'auto',
  description: name,
  // A failing migration stays pending; a successful one is done once it has run.
  check: async () => ({ pending: pending && (fail || !log.includes(name)), detail: name }),
  up: async () => {
    log.push(name);
    if (fail) throw new Error('index build failed');
    return {};
  },
});

beforeAll(async () => {
  // Several immutable fulls share this host. Only Mongo's launch allowance is
  // extended; migration assertions and operation deadlines stay unchanged.
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const create = MongoMemoryReplSet.create.bind(MongoMemoryReplSet);
  const launch = jest.spyOn(MongoMemoryReplSet, 'create').mockImplementationOnce((options) =>
    create({ ...options, instanceOpts: [{ launchTimeout: 60000 }] }));
  try { await setup(); } finally { launch.mockRestore(); }
  await Transaction.init();
  await Item.init();
}, 90000);
afterAll(teardown);
afterEach(async () => {
  await dropIndexIfPresent(transactions(), widen.LEGACY_KEY);
  await clearDB();
});

describe('receipt index migration', () => {
  it('reports not ready while the legacy {cafeId, receiptId} unique index exists', async () => {
    await createLegacyIndex();
    await expect(migrationReadiness()).resolves.toMatchObject({ ok: false, pending: ['widen-receipt-index'] });
    // BE-02-T06 caches anonymous readiness for 5 s; start from an empty cache so this request computes it.
    const health = require('../../src/controllers/health.controller');
    if (typeof health._resetReadinessCache === 'function') health._resetReadinessCache();
    const res = await request.get('/api/ready');
    expect(res.status).toBe(503);
  });

  it('lets a till that restarts its numbering daily import day two once the migration has run', async () => {
    await createLegacyIndex();
    const cafeId = new mongoose.Types.ObjectId();
    await Transaction.create(sale(cafeId, '#0001', '2026-06-01T08:00:00Z'));
    await expect(Transaction.create(sale(cafeId, '#0001', '2026-06-02T08:00:00Z'))).rejects.toMatchObject({ code: 11000 });

    const result = await runMigrations({ by: 'test' });

    expect(result.applied).toEqual(['widen-receipt-index']);
    expect(await indexKeys()).not.toContain(JSON.stringify(widen.LEGACY_KEY));
    await expect(Transaction.create(sale(cafeId, '#0001', '2026-06-02T08:00:00Z'))).resolves.toBeTruthy();
    await expect(Transaction.create(sale(cafeId, '#0001', '2026-06-01T08:00:00Z'))).rejects.toMatchObject({ code: 11000 });
    await expect(migrationReadiness()).resolves.toMatchObject({ ok: true });
  });

  it('records each run in the migrations collection and skips it on the next start', async () => {
    await createLegacyIndex();
    await runMigrations({ by: 'test' });
    const second = await runMigrations({ by: 'test' });

    expect(second.skipped).toContain('widen-receipt-index');
    const ledger = await Migration.findById('widen-receipt-index').lean();
    expect(ledger).toMatchObject({ status: 'applied', kind: 'contract', mode: 'auto', attempts: 1 });
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0]).toMatchObject({ status: 'applied', by: 'test' });
    expect(ledger.runs[0].stats.dropped).toEqual(['cafeId_1_receiptId_1']);
  });

  it('runs again if the legacy index comes back after it was applied', async () => {
    await createLegacyIndex();
    await runMigrations({ by: 'test' });
    await createLegacyIndex();
    const again = await runMigrations({ by: 'test' });
    expect(again.applied).toEqual(['widen-receipt-index']);
    const ledger = await Migration.findById('widen-receipt-index').lean();
    expect(ledger.runs).toHaveLength(2);
    expect(ledger.attempts).toBe(2);
  });

  it('records a database already in the target state without touching it', async () => {
    const result = await runMigrations({ by: 'test' });
    expect(result.verified).toContain('widen-receipt-index');
    const ledger = await Migration.findById('widen-receipt-index').lean();
    expect(ledger.stats).toMatchObject({ alreadyInTargetState: true });
  });

  it('leaves a migration alone while another runner holds a live lease, and reports it running', async () => {
    await createLegacyIndex();
    await Migration.create({ _id: 'widen-receipt-index', status: 'running', lockedUntil: new Date(Date.now() + 60000), attempts: 1 });
    const result = await runMigrations({ by: 'test' });
    expect(result.locked).toEqual(['widen-receipt-index']);
    expect(await indexKeys()).toContain(JSON.stringify(widen.LEGACY_KEY));
    await expect(migrationReadiness()).resolves.toMatchObject({ ok: false, running: ['widen-receipt-index'] });
  });

  it('takes over a lease that expired because its runner died', async () => {
    await createLegacyIndex();
    await Migration.create({ _id: 'widen-receipt-index', status: 'running', lockedUntil: new Date(Date.now() - 1000), attempts: 1 });
    const result = await runMigrations({ by: 'test' });
    expect(result.applied).toEqual(['widen-receipt-index']);
  });

  it('never drops an index whose replacement does not exist', async () => {
    await createLegacyIndex();
    await expect(
      dropIndexIfPresent(transactions(), widen.LEGACY_KEY, { requireOneOf: [{ cafeId: 1, receiptId: 1, dateKey: 1 }] })
    ).rejects.toThrow(/replacement/);
    expect(await indexKeys()).toContain(JSON.stringify(widen.LEGACY_KEY));
  });
});

describe('runner ordering and failure', () => {
  it('does not rerun a migration when a concurrent preflight becomes stale before acquiring its lease', async () => {
    let done = false;
    let firstInUp = false;
    let releaseUp;
    let releaseCheck;
    let enteredUp;
    let enteredCheck;
    const upEntered = new Promise((resolve) => { enteredUp = resolve; });
    const checkEntered = new Promise((resolve) => { enteredCheck = resolve; });
    const upGate = new Promise((resolve) => { releaseUp = resolve; });
    const checkGate = new Promise((resolve) => { releaseCheck = resolve; });
    const up = jest.fn(async () => {
      firstInUp = true;
      enteredUp();
      await upGate;
      firstInUp = false;
      done = true;
      return {};
    });
    const migration = {
      name: 'b90-concurrent', mode: 'auto', kind: 'contract',
      async check() {
        const pending = !done;
        if (firstInUp) { enteredCheck(); await checkGate; }
        return { pending, detail: 'concurrent check' };
      },
      up,
    };
    const first = runMigrations({ migrations: [migration], by: 'first' });
    await upEntered;
    const second = runMigrations({ migrations: [migration], by: 'second' });
    await checkEntered;
    releaseUp();
    await first;
    releaseCheck();
    await second;
    expect(up).toHaveBeenCalledTimes(1);
    expect((await Migration.findById(migration.name).lean()).status).toBe('applied');
  });

  it('does not overwrite the ledger after another runner has taken its expired lease', async () => {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    let pending = true;
    const migration = {
      name: 'b90-fenced', mode: 'auto', kind: 'data',
      check: async () => ({ pending, detail: 'fencing' }),
      up: async () => { entered(); await gate; pending = false; return {}; },
    };
    const run = runMigrations({ migrations: [migration], by: 'old' });
    await started;
    await Migration.updateOne({ _id: migration.name }, { $inc: { attempts: 1 }, $set: { lockedBy: 'replacement' } });
    release();
    await run;
    expect(await Migration.findById(migration.name).lean()).toMatchObject({ status: 'running', lockedBy: 'replacement' });
  });

  it('answers immediately while disconnected instead of buffering a ledger query', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 0 });
    try {
      const find = jest.spyOn(Migration, 'find');
      await expect(migrationReadiness()).resolves.toMatchObject({ ok: false, state: 'database_unavailable' });
      expect(find).not.toHaveBeenCalled();
      find.mockRestore();
    } finally {
      if (descriptor) Object.defineProperty(mongoose.connection, 'readyState', descriptor);
      else delete mongoose.connection.readyState;
    }
  });

  it('runs additive migrations before data rewrites before drops, whatever the registry order', async () => {
    const log = [];
    await runMigrations({
      migrations: [fake('b90-drop', 'contract', log), fake('b90-backfill', 'data', log), fake('b90-add', 'expand', log)],
      by: 'test',
    });
    expect(log).toEqual(['b90-add', 'b90-backfill', 'b90-drop']);
  });

  it('stops at the first failure, records it, and reports not ready', async () => {
    const log = [];
    const migrations = [fake('b90-fails', 'expand', log, { fail: true }), fake('b90-later', 'contract', log)];
    const result = await runMigrations({ migrations, by: 'test' });

    expect(result.failed).toEqual(['b90-fails']);
    expect(log).toEqual(['b90-fails']);
    const ledger = await Migration.findById('b90-fails').lean();
    expect(ledger).toMatchObject({ status: 'failed', lastError: 'index build failed' });
    await expect(migrationReadiness({ migrations })).resolves.toMatchObject({
      ok: false,
      failed: ['b90-fails'],
      pending: ['b90-later'],
    });
  });
});

describe('recategorise-items through the runner', () => {
  it('never runs a manual migration at startup, runs it when named, and keeps owner choices', async () => {
    const misfiled = await Item.create({ cafeId: new mongoose.Types.ObjectId(), name: 'House Coffee (Blend)', category: 'retail' });
    const ownerChoice = await Item.create({
      cafeId: new mongoose.Types.ObjectId(),
      name: 'House Coffee (Blend)',
      category: 'retail',
      manualFields: ['category'],
    });

    await runMigrations({ by: 'test' });
    expect((await Item.findById(misfiled._id).lean()).category).toBe('retail');

    const result = await runMigrations({ names: ['recategorise-items'], by: 'test' });
    expect(result.applied).toEqual(['recategorise-items']);
    expect((await Item.findById(misfiled._id).lean()).category).toBe('coffee');
    expect((await Item.findById(ownerChoice._id).lean()).category).toBe('retail');
  });

  it('does not overwrite an owner edit made between planning and applying', async () => {
    const item = await Item.create({ cafeId: new mongoose.Types.ObjectId(), name: 'House Coffee (Blend)', category: 'retail' });
    const { updates } = recategorise.plan([await Item.findById(item._id).lean()]);
    expect(updates).toHaveLength(1);
    await Item.updateOne({ _id: item._id }, { $addToSet: { manualFields: 'category' } });

    const { modified } = await recategorise.applyUpdates(updates);

    expect(modified).toBe(0);
    expect((await Item.findById(item._id).lean()).category).toBe('retail');
  });
});

