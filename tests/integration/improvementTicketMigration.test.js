const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');
const Improvement = require('../../src/models/Improvement.model');
const { migrateImprovementTicketIndexes } = require('../../src/migrations/improvement-tickets-per-org');
const { runStartupMigrations, migrationReadiness } = require('../../src/migrations/runner');
const Migration = require('../../src/models/Migration.model');
const ticketMigration = require('../../src/migrations').find((migration) => migration.name === 'improvement-tickets-per-org');
const { dropIndexIfPresent } = require('../../src/migrations/indexTools');
const request = require('supertest')(require('../setup').app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  await clearDB();
  await dropIndexIfPresent(Improvement.collection, { ticketNumber: 1 });
  await Improvement.collection.createIndex({ orgId: 1, ticketNumber: 1 }, { unique: true });
});

const ticket = (orgId, ticketNumber) => ({ orgId, ticketNumber, type: 'fix', title: 'T', description: 'D' });

describe('improvement ticket index migration', () => {
  it('automatically replaces the legacy ticket index at boot before another org creates ticket #1, once', async () => {
    await Improvement.init();
    await Improvement.collection.createIndex({ ticketNumber: 1 }, { unique: true, name: 'ticketNumber_1' });
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    await Improvement.collection.insertMany([ticket(orgA, 1), ticket(orgA, 3)]);

    const first = await runStartupMigrations({ migrations: [ticketMigration] });

    expect(first.applied).toEqual([ticketMigration.name]);
    expect(ticketMigration).toMatchObject({ mode: 'auto', kind: 'contract' });
    const indexes = await Improvement.collection.indexes();
    expect(indexes.map((index) => index.name)).not.toContain('ticketNumber_1');
    expect(indexes.find((index) => index.name === 'orgId_1_ticketNumber_1')).toMatchObject({ unique: true });
    const next = await Improvement.create({ orgId: orgB, type: 'fix', title: 'First B', description: 'D' });
    expect(next.ticketNumber).toBe(1);
    const nextA = await Improvement.create({ orgId: orgA, type: 'fix', title: 'Next A', description: 'D' });
    expect(nextA.ticketNumber).toBe(4);
    await expect(migrationReadiness({ migrations: [ticketMigration] })).resolves.toMatchObject({ ok: true });

    const second = await runStartupMigrations({ migrations: [ticketMigration] });
    expect(second.skipped).toEqual([ticketMigration.name]);
    const ledger = await Migration.findById(ticketMigration.name).lean();
    expect(ledger).toMatchObject({ status: 'applied', kind: 'contract', mode: 'auto', attempts: 1 });
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0].by).toBe('startup');
  });

  it('keeps readiness at 503 while the legacy ticket index is still pending at boot', async () => {
    await Improvement.collection.createIndex({ ticketNumber: 1 }, { unique: true, name: 'ticketNumber_1' });
    await expect(migrationReadiness({ migrations: [ticketMigration] })).resolves.toMatchObject({
      ok: false, pending: [ticketMigration.name],
    });
    const health = require('../../src/controllers/health.controller');
    health._resetReadinessCache();
    expect((await request.get('/api/ready')).status).toBe(503);
    await runStartupMigrations({ migrations: [ticketMigration] });
    await expect(migrationReadiness({ migrations: [ticketMigration] })).resolves.toMatchObject({ ok: true });
  });

  it('fails loudly on duplicate per-org numbers and never drops the legacy index when its replacement cannot build', async () => {
    await Improvement.collection.dropIndex('orgId_1_ticketNumber_1');
    const orgId = new mongoose.Types.ObjectId();
    // Corrupt data cannot coexist with the old unique index. A nonunique legacy
    // key lets this fixture exercise the replacement-build safety guard itself.
    await Improvement.collection.insertMany([ticket(orgId, 1), ticket(orgId, 1)]);
    await Improvement.collection.createIndex({ ticketNumber: 1 }, { name: 'ticketNumber_1' });

    const result = await runStartupMigrations({ migrations: [ticketMigration] });

    expect(result.failed).toEqual([ticketMigration.name]);
    expect(result.applied).toEqual([]);
    expect((await Improvement.collection.indexes()).map((index) => index.name)).toContain('ticketNumber_1');
    expect(await Improvement.collection.countDocuments({ orgId, ticketNumber: 1 })).toBe(2);
    expect(await Migration.findById(ticketMigration.name).lean()).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/E11000|duplicate key/i) });
    await expect(migrationReadiness({ migrations: [ticketMigration] })).resolves.toMatchObject({
      ok: false, failed: [ticketMigration.name],
    });
    require('../../src/controllers/health.controller')._resetReadinessCache();
    expect((await request.get('/api/ready')).status).toBe(503);
  });

  it('drops the legacy global unique index so two orgs can both have ticket #1', async () => {
    await Improvement.init();
    await Improvement.collection.createIndex({ ticketNumber: 1 }, { unique: true, name: 'ticketNumber_1' });
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    await Improvement.collection.insertOne(ticket(orgA, 1));
    await expect(Improvement.collection.insertOne(ticket(orgB, 1))).rejects.toMatchObject({ code: 11000 });

    const dryRun = await migrateImprovementTicketIndexes({ apply: false });
    expect(dryRun).toEqual({ dropLegacyIndex: true, applied: false });
    await migrateImprovementTicketIndexes({ apply: true });

    const names = (await Improvement.collection.indexes()).map((index) => index.name);
    expect(names).not.toContain('ticketNumber_1');
    expect(names).toContain('orgId_1_ticketNumber_1');
    await expect(Improvement.collection.insertOne(ticket(orgB, 1))).resolves.toBeTruthy();
    await expect(Improvement.collection.insertOne(ticket(orgA, 1))).rejects.toMatchObject({ code: 11000 });
  });
});
