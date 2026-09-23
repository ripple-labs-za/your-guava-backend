const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');
const { buildBusinessContext } = require('../../src/services/anthropic.service');

const request = supertest(app);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const sale = (cafeId, date, overrides = {}) => ({
  cafeId,
  date,
  dayOfWeek: 1,
  status: 'approved',
  items: [{ name: 'Flat White', quantity: 1, unitPrice: 100 }],
  total: 100,
  ...overrides,
});

describe('sales with no time of day', () => {
  it('stay out of the heatmap cells and its observed days, and are counted in its meta', async () => {
    const { token, user } = await createTestUser();
    await Transaction.insertMany([
      sale(user.activeCafeId, new Date('2026-01-05T07:00:00Z'), { hour: 9, hourKnown: true }), // Mon 09:00 SAST
      sale(user.activeCafeId, new Date('2026-01-11T22:00:00Z'), { hour: null, hourKnown: false, total: 300 }), // Mon 12 Jan, no time
      sale(user.activeCafeId, new Date('2026-01-18T22:00:00Z'), { hour: null, hourKnown: false, total: 300 }), // Mon 19 Jan, no time
    ]);

    const res = await request
      .get('/api/analytics/heatmap')
      .set('Authorization', `Bearer ${token}`)
      .query({ startDate: '2026-01-05', endDate: '2026-01-19' });

    expect(res.status).toBe(200);
    const monday9 = res.body.heatmap.find((cell) => cell.dayOfWeek === 1 && cell.hour === 9);
    expect(monday9).toMatchObject({ revenue: 100, observedDays: 1 });
    expect(res.body.meta.timeOfDay).toEqual({ transactionsWithTime: 1, transactionsWithoutTime: 2 });
  });

  it('are left out of the Ask Guava hour pattern, which says how many were left out', async () => {
    const { user } = await createTestUser();
    const now = Date.now();
    await Transaction.insertMany([
      sale(user.activeCafeId, new Date(now - 2 * DAY_MS), { hour: 10, hourKnown: true, total: 40 }),
      sale(user.activeCafeId, new Date(now - 3 * DAY_MS), { hour: null, hourKnown: false, total: 60 }),
    ]);

    const context = await buildBusinessContext({ cafeId: user.activeCafeId, orgId: user.orgId });

    expect(context.activeLocationHourPattern90d.map((row) => row.hour)).toEqual([10]);
    expect(context.activeLocationHourCoverage90d).toEqual({ transactionsWithoutTime: 1 });
  });

  it('come from a date-only upload with hourKnown false and hour null', async () => {
    const { user } = await createTestUser();
    const { parseBuffer } = require('../../src/services/parser.service');
    const { persistParsedRows } = require('../../src/services/ingestion.service');
    const parsed = await parseBuffer(Buffer.from('Date,Items,Total\n2026-09-14,1 x Latte,38.00'), {
      columnMapping: { date: 'Date', items: 'Items', total: 'Total' }, itemsMode: 'packed', timezone: 'Africa/Johannesburg',
    });
    await persistParsedRows(parsed, { cafeId: user.activeCafeId, uploadId: new mongoose.Types.ObjectId(), bulk: true,
      timezone: 'Africa/Johannesburg' });
    const stored = await Transaction.findOne({ cafeId: user.activeCafeId }).lean();
    expect(stored).toMatchObject({ hourKnown: false, hour: null });
  });

  it('stored before this card are marked by the migration, and nothing else is', async () => {
    const { user } = await createTestUser();
    const upload = await Upload.create({
      cafeId: user.activeCafeId, uploadedBy: new mongoose.Types.ObjectId(), fileName: 'date-only.csv', fileSize: 1,
      r2Key: 'uploads/x/date-only.csv', posType: 'wizard', status: 'completed',
      columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
    });
    await Transaction.collection.insertMany([
      { ...sale(new mongoose.Types.ObjectId(user.activeCafeId), new Date('2026-09-13T22:00:00Z')), uploadId: upload._id, hour: 0 },
      { ...sale(new mongoose.Types.ObjectId(user.activeCafeId), new Date('2026-09-14T07:30:00Z')), uploadId: upload._id, hour: 9 },
    ]);
    const { markDateOnlyHours } = require('../../src/migrations/mark-date-only-hours');

    const dryRun = await markDateOnlyHours({ apply: false });
    expect(dryRun).toMatchObject({ matched: 1, marked: 0 });
    const applied = await markDateOnlyHours({ apply: true });
    expect(applied).toMatchObject({ matched: 1, marked: 1 });

    const rows = await Transaction.find({ uploadId: upload._id }).sort({ date: 1 }).lean();
    expect(rows[0]).toMatchObject({ hourKnown: false, hour: null });
    expect(rows[1].hour).toBe(9);
    expect(rows[1].hourKnown).toBeUndefined();
  });
});
