const { setup, teardown, clearDB } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');
const Item = require('../../src/models/Item.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const migration = require('../../src/migrations/align-import-indexes');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const MODELS = { Transaction, Upload, Item, UsageLedger };
const plantLegacy = async () => {
  for (const model of Object.values(MODELS)) await model.createIndexes();
  for (const { model, key } of migration.LEGACY_INDEXES) await MODELS[model].collection.createIndex(key);
};
const hasKey = async (model, key) => (await MODELS[model].collection.indexes()).some((index) => JSON.stringify(index.key) === JSON.stringify(key));

it('reports the legacy indexes without touching them on a dry run', async () => {
  await plantLegacy();
  expect((await migration.check()).pending).toBe(true);
  const result = await migration.up({ dryRun: true });
  expect(result.dropped).toHaveLength(migration.LEGACY_INDEXES.length);
  for (const { model, key } of migration.LEGACY_INDEXES) expect(await hasKey(model, key)).toBe(true);
});

it('drops exactly the legacy indexes and keeps every declared one', async () => {
  await plantLegacy();
  await migration.up({});
  for (const { model, key } of migration.LEGACY_INDEXES) expect(await hasKey(model, key)).toBe(false);
  expect(await hasKey('Transaction', { cafeId: 1, uploadId: 1, date: -1 })).toBe(true);
  expect(await hasKey('Transaction', { cafeId: 1, receiptId: 1, date: 1 })).toBe(true);
  expect((await migration.check()).pending).toBe(false);
});

// A production database has the legacy indexes and not yet the new ones; --apply creates those first, so the dry run
// must say what it would drop rather than refuse.
it('dry-runs a database that has the legacy indexes but not yet the new ones', async () => {
  await plantLegacy();
  await Transaction.collection.dropIndex('cafeId_1_uploadId_1_date_-1');
  const result = await migration.up({ dryRun: true });
  expect(result.dropped).toContain('Transaction.uploadId_1');
  expect(await hasKey('Transaction', { uploadId: 1 })).toBe(true);
});

it('is idempotent', async () => {
  await plantLegacy();
  await migration.up({});
  expect((await migration.up({})).dropped).toEqual([]);
});
