const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');
const Item = require('../../src/models/Item.model');
const { resolveIdentities } = require('../../src/services/transactionIdentity');
const { reconcileParsedRows } = require('../../src/services/ingestion.service');
const { zonedDayStart, addZonedDays, zonedDateKey, zonedDayOfWeek } = require('../../src/utils/timezone');

const ZONE = 'Africa/Johannesburg';
beforeAll(async () => {
  await setup();
  await Promise.all([Transaction.syncIndexes(), Upload.syncIndexes(), Item.syncIndexes()]);
});
afterAll(teardown);
afterEach(async () => { mongoose.set('debug', false); jest.restoreAllMocks(); await clearDB(); });

const cafeId = () => new mongoose.Types.ObjectId();
const dayStart = (key) => zonedDayStart(key, ZONE);
const at = (key, hour) => new Date(dayStart(key).getTime() + hour * 3600 * 1000);
const days = (count, endKey) => Array.from({ length: count }, (_, i) => zonedDateKey(addZonedDays(dayStart(endKey), -i, ZONE), ZONE));

// A till that restarts numbering daily: receipts 1..perDay on each of `count` days, stored directly.
const seedDailyReset = async (cafe, count, perDay, endKey) => {
  const docs = [];
  for (const key of days(count, endKey)) {
    for (let n = 1; n <= perDay; n += 1) {
      const date = at(key, 8 + (n % 10));
      docs.push({ cafeId: cafe, receiptId: String(n), date, hour: 8 + (n % 10), dayOfWeek: zonedDayOfWeek(date, ZONE),
        status: 'approved', total: 38, items: [{ name: 'Latte', quantity: 1, unitPrice: 38 }] });
    }
  }
  await Transaction.collection.insertMany(docs);
};

const stages = (node, found = []) => {
  if (!node || typeof node !== 'object') return found;
  if (node.stage) found.push(node);
  for (const key of ['inputStage', 'queryPlan', 'winningPlan']) stages(node[key], found);
  for (const child of node.inputStages || []) stages(child, found);
  return found;
};
const explain = async (query) => {
  const out = await query.explain('executionStats');
  const doc = Array.isArray(out) ? out[0] : out;
  return { plan: stages(doc.queryPlanner.winningPlan), stats: doc.executionStats };
};
const expectIndexed = ({ plan, stats }, indexName) => {
  expect(plan.some((stage) => stage.stage === 'IXSCAN' && stage.indexName === indexName)).toBe(true);
  expect(plan.some((stage) => stage.stage === 'SORT')).toBe(false);
  expect(stats.totalDocsExamined).toBeLessThanOrEqual(2 * stats.nReturned + 5);
};

describe('existing-identity lookups are bounded by the file\'s own days', () => {
  it('adds a date bound to every receipt query and still finds the same-day duplicate', async () => {
    const cafe = cafeId();
    await seedDailyReset(cafe, 60, 20, '2026-08-31');
    const finds = [];
    const original = Transaction.find.bind(Transaction);
    jest.spyOn(Transaction, 'find').mockImplementation((filter, ...rest) => { finds.push(filter); return original(filter, ...rest); });
    const rows = ['2026-08-31', '2026-09-01'].flatMap((key) => Array.from({ length: 20 }, (_, i) => ({
      // The same hour, total and basket as the seeded sale, so BE-03-T04's content comparison calls 31 Aug a duplicate, not a conflict.
      receiptId: String(i + 1), date: at(key, 8 + ((i + 1) % 10)), dateKey: key, status: 'approved', total: 38,
      items: [{ name: 'Latte', quantity: 1, unitPrice: 38 }] })));

    const resolution = await resolveIdentities(rows, { cafeId: cafe, timezone: ZONE });

    expect(resolution.duplicates).toHaveLength(20); // 31 Aug is already held; 1 Sep is new
    expect(resolution.importable).toHaveLength(20);
    const receiptQueries = finds.filter((filter) => filter.receiptId);
    expect(receiptQueries.length).toBeGreaterThan(0);
    for (const filter of receiptQueries) {
      expect(filter.date.$gte.getTime()).toBeGreaterThanOrEqual(dayStart('2026-08-30').getTime());
      expect(filter.date.$lte.getTime()).toBeLessThanOrEqual(dayStart('2026-09-03').getTime());
    }
  });

  it('explain: the bounded receipt lookup reads only the file\'s days', async () => {
    const cafe = cafeId();
    await seedDailyReset(cafe, 60, 20, '2026-08-31');
    const query = Transaction.find({ cafeId: cafe, receiptId: { $in: ['1', '2', '3'], $type: 'string' },
      date: { $gte: dayStart('2026-08-30'), $lte: dayStart('2026-09-02') } }).select('receiptId date uploadId');
    expectIndexed(await explain(query), 'cafeId_1_receiptId_1_date_1');
  });

  it('explain: the receipt-less content lookup reads only the file\'s days', async () => {
    const cafe = cafeId();
    const docs = days(60, '2026-08-31').map((key, i) => ({ cafeId: cafe, dedupKey: `k${i}`, date: at(key, 9), status: 'approved', total: 38, items: [] }));
    await Transaction.collection.insertMany(docs);
    const query = Transaction.find({ cafeId: cafe, dedupKey: { $type: 'string' }, date: { $gte: dayStart('2026-08-29'), $lte: dayStart('2026-09-01') } })
      .select('date total tip discount items.quantity uploadId dedupKey');
    const result = await explain(query);
    expect(result.plan.some((stage) => stage.stage === 'IXSCAN')).toBe(true);
    expect(result.stats.totalDocsExamined).toBeLessThanOrEqual(2 * result.stats.nReturned + 5);
  });
});

describe('reconciliation issues one query per batch of names', () => {
  const itemOps = () => {
    const calls = [];
    mongoose.set('debug', (collection, method) => { if (collection === 'items') calls.push(method); });
    return calls;
  };
  const rowsWithNames = (names, count) => Array.from({ length: count }, (_, i) => ({
    status: 'approved',
    items: [{ name: names[i % names.length], quantity: 1, unitPrice: 20 + (i % 37), priceSource: 'derived' },
      { name: names[(i * 7) % names.length], quantity: 2, unitPrice: 20 + (i % 37), priceSource: 'derived' }],
  }));

  it('reconciles 1,000 rows over 200 names (100 known) with two finds and one bulk write', async () => {
    const cafe = cafeId();
    const names = Array.from({ length: 200 }, (_, i) => `Item ${String(i).padStart(3, '0')}`);
    await Item.insertMany(names.slice(0, 100).map((name) => ({ cafeId: cafe, name, normalizedName: name.toLowerCase(), reviewStatus: 'matched' })));
    const calls = itemOps();
    const parsed = { rows: rowsWithNames(names, 1000) };
    await reconcileParsedRows(parsed, { cafeId: cafe });
    mongoose.set('debug', false);

    expect(calls.filter((m) => m === 'find').length).toBeLessThanOrEqual(2);
    expect(calls.filter((m) => m === 'bulkWrite').length).toBeLessThanOrEqual(1);
    expect(calls.filter((m) => m === 'updateOne' || m === 'findOneAndUpdate').length).toBe(0);
    expect(await Item.countDocuments({ cafeId: cafe })).toBe(200);
    const byName = new Map((await Item.find({ cafeId: cafe }).lean()).map((item) => [item.name, String(item._id)]));
    for (const row of parsed.rows) for (const line of row.items) expect(String(line.salesItemId)).toBe(byName.get(line.name));
  });

  it('batches 1,200 names into at most six finds', async () => {
    const cafe = cafeId();
    const names = Array.from({ length: 1200 }, (_, i) => `Name ${i}`);
    const calls = itemOps();
    await reconcileParsedRows({ rows: rowsWithNames(names, 1200) }, { cafeId: cafe });
    mongoose.set('debug', false);
    expect(calls.filter((m) => m === 'find').length).toBeLessThanOrEqual(6);
    expect(await Item.countDocuments({ cafeId: cafe })).toBe(1200);
  });

  it('creates one item for two spellings that share a key', async () => {
    const cafe = cafeId();
    await reconcileParsedRows({ rows: [{ status: 'approved', items: [{ name: 'Flat White', quantity: 1 }, { name: 'Flat-White', quantity: 1 }] }] }, { cafeId: cafe });
    expect(await Item.countDocuments({ cafeId: cafe })).toBe(1);
  });

  // Review of BE-03-T13: names whose key is empty (non-Latin, symbols) are not twins of each other. Grouped under ''
  // only the first was created, the others resolved to nothing and the whole import threw.
  it('creates one item per name whose key is empty, and links each line to its own', async () => {
    const cafe = cafeId();
    const parsed = { rows: [{ status: 'approved', items: [{ name: '拿铁', quantity: 1 }, { name: '美式', quantity: 1 }, { name: '***', quantity: 1 }] }] };
    await reconcileParsedRows(parsed, { cafeId: cafe });
    expect(await Item.countDocuments({ cafeId: cafe })).toBe(3);
    expect(parsed.rows[0].items.map((line) => line.name)).toEqual(['拿铁', '美式', '***']);
  });
});

describe('indexes match the query shapes (explain)', () => {
  it('the upload Rows view reads its page from an index, with no in-memory sort', async () => {
    const cafe = cafeId(); const uploadId = new mongoose.Types.ObjectId();
    await Transaction.collection.insertMany(days(300, '2026-08-31').map((key, i) => ({ cafeId: cafe, uploadId: i % 3 === 0 ? uploadId : new mongoose.Types.ObjectId(), receiptId: `u${i}`, date: at(key, 9), status: 'approved', items: [] })));
    expectIndexed(await explain(Transaction.find({ cafeId: cafe, uploadId }).sort({ date: -1 }).limit(50)), 'cafeId_1_uploadId_1_date_-1');
  });

  it('the maintenance sweep reads only uploads that owe maintenance', async () => {
    const base = { cafeId: cafeId(), uploadedBy: new mongoose.Types.ObjectId(), fileName: 'f.csv', fileSize: 1, r2Key: 'k', posType: 'yoco' };
    await Upload.insertMany([
      ...Array.from({ length: 300 }, () => ({ ...base, status: 'completed', maintenance: { status: 'completed' } })),
      ...Array.from({ length: 5 }, () => ({ ...base, status: 'completed', maintenance: { status: 'queued' } })),
    ]);
    const query = Upload.find({ status: 'completed', 'maintenance.status': { $in: ['queued', 'running', 'partial_failure'] } })
      .sort({ updatedAt: 1 }).limit(10);
    expectIndexed(await explain(query), 'maintenance.status_1_updatedAt_1');
  });

  it('the storage-retry sweep reads only tombstones still owing cleanup', async () => {
    const base = { cafeId: cafeId(), uploadedBy: new mongoose.Types.ObjectId(), fileName: 'f.csv', fileSize: 1, r2Key: 'k', posType: 'yoco', status: 'deleted' };
    await Upload.insertMany([...Array.from({ length: 300 }, () => ({ ...base })), ...Array.from({ length: 3 }, () => ({ ...base, errorMessage: 'Stored file cleanup pending; background cleanup will retry.' }))]);
    const query = Upload.find({ status: 'deleted', errorMessage: 'Stored file cleanup pending; background cleanup will retry.' }).sort({ updatedAt: 1 }).limit(10);
    expectIndexed(await explain(query), 'status_1_errorMessage_1_updatedAt_1');
  });

  it('declares exactly the planned index sets', async () => {
    const names = async (Model) => (await Model.collection.indexes()).map((index) => index.name).sort();
    expect(await names(Transaction)).toEqual(['_id_', 'cafeId_1_date_-1', 'cafeId_1_dedupKey_1', 'cafeId_1_receiptId_1_date_1',
      'cafeId_1_status_1_date_-1', 'cafeId_1_status_1_dayOfWeek_1_date_-1', 'cafeId_1_status_1_dayOfWeek_1_hour_1_date_-1',
      'cafeId_1_uploadId_1_date_-1'].sort());
    expect(await names(Upload)).toEqual(['_id_', 'cafeId_1_createdAt_-1', 'cafeId_1_status_1_dateRange.firstDate_1',
      'maintenance.status_1_updatedAt_1', 'status_1_errorMessage_1_updatedAt_1', 'status_1_updatedAt_1'].sort());
    const itemNames = await names(Item);
    expect(itemNames).not.toContain('normalizedName_1');
    expect(itemNames).not.toContain('reviewStatus_1');
  });
});
