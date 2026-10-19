// Analytics cost guards (BE-14-T02): every aggregation is a cafe-scoped index scan bounded by what it matches, a request reads its
// window once, and a faster endpoint answers exactly as before (the snapshots were committed before any speed-up).
const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const { rebuildItemsForCafe } = require('../../src/services/menuItems.service');
const { DEMAND_LINE_MATCH } = require('../../src/utils/demand');
const { countOperations, seedTransactions } = require('../helpers/perf');

const request = supertest(app);
jest.setTimeout(180_000);

const ENDPOINTS = ['revenue', 'items', 'heatmap', 'customers', 'combos'];
const END = '2026-08-31'; // a fixed past day: windows, trends and snapshots do not depend on the clock
const INDEXABLE = ['cafeId', 'status', 'date', 'dayOfWeek', 'hour'];
// How many aggregations may read the whole request window. Latency is the budget and total database work the tiebreak (step 6):
// a $facet saves the repeated read but runs its branches in turn in one thread, so on the 300,000-sale Perf Cafe it was slower
// (p95, 365 days: heatmap 673 ms as three concurrent scans, 1,533 ms as one facet; items 1,540 ms as two scans in turn, 1,559 ms
// as one facet). Items and heatmap therefore read their window concurrently: 2 and 3 scans, at the same time, never in turn.
const SCANS_ALLOWED = { revenue: 1, items: 2, heatmap: 3, customers: 1, combos: 1 };
const shiftDay = (key, days) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const windowQuery = (days) => ({ startDate: shiftDay(END, -(days - 1)), endDate: END });
const indexablePart = (match = {}) => Object.fromEntries(Object.entries(match).filter(([key]) => INDEXABLE.includes(key)));
const aggregatesOf = (calls) => calls.filter((c) => c.collectionName === 'transactions' && c.method === 'aggregate').map((c) => c.params[0]);

// Stages of the winning plan (classic or slot-based) and the documents it examined; rejected plans are ignored.
const planFacts = (explain) => {
  const stages = [];
  let docsExamined = null;
  const walk = (value, key) => {
    // A leaf, or a plan MongoDB rejected, has nothing to read.
    const readable = value && typeof value === 'object' && key !== 'rejectedPlans' && key !== 'slotBasedPlan';
    if (readable && Array.isArray(value)) {
      value.forEach((entry) => walk(entry));
    } else if (readable) {
      if (typeof value.stage === 'string') stages.push({ stage: value.stage, keyPattern: value.keyPattern });
      if (docsExamined === null && Number.isFinite(value.totalDocsExamined)) docsExamined = value.totalDocsExamined;
      Object.entries(value).forEach(([childKey, child]) => walk(child, childKey));
    }
  };
  walk(explain);
  return { stages, docsExamined };
};

// Whether an aggregation's first $match spans the whole request window (cafe-local days, Africa/Johannesburg is UTC+2).
const coversWindow = (pipeline, { startDate, endDate }) => {
  const date = pipeline[0]?.$match?.date || {};
  const lower = date.$gte ?? date.$gt;
  const upper = date.$lte ?? date.$lt;
  return lower instanceof Date && upper instanceof Date
    && lower <= new Date(`${startDate}T00:00:00+02:00`) && upper >= new Date(`${endDate}T23:59:59.998+02:00`);
};

let token;
let cafeId;
beforeAll(async () => {
  await setup();
  await Transaction.init(); // indexes built before any explain
  const owner = await createTestUser();
  token = owner.token;
  cafeId = owner.user.activeCafeId;
  expect(await seedTransactions(cafeId, { days: 400, perDay: 30, endDay: END })).toBe(12_000);
  await rebuildItemsForCafe(cafeId);
});
afterAll(teardown);

const get = (endpoint, days) => request.get(`/api/analytics/${endpoint}`).set('Authorization', `Bearer ${token}`).query(windowQuery(days));

describe('analytics cost on a 12,000-sale cafe', () => {
  it.each(ENDPOINTS)('A0: every %s aggregation is a cafe-scoped index scan bounded by what it matches', async (endpoint) => {
    const { result, calls } = await countOperations(() => get(endpoint, 365));
    expect(result.status).toBe(200);
    const pipelines = aggregatesOf(calls);
    expect(pipelines.length).toBeGreaterThan(0);
    for (const pipeline of pipelines) {
      expect(pipeline[0]).toHaveProperty('$match');
      const matched = await Transaction.countDocuments(indexablePart(pipeline[0].$match));
      const explain = await mongoose.connection.db.command({
        explain: { aggregate: 'transactions', pipeline, cursor: {} }, verbosity: 'executionStats',
      });
      const { stages, docsExamined } = planFacts(explain);
      expect(stages.map((s) => s.stage)).not.toContain('COLLSCAN');
      expect(stages.some((s) => s.stage === 'IXSCAN' && Object.keys(s.keyPattern || {})[0] === 'cafeId')).toBe(true);
      expect(docsExamined).toBeLessThanOrEqual(Math.ceil(1.1 * matched) + 10);
    }
  });

  it.each(ENDPOINTS)('A1: GET /analytics/%s for 365 days reads its window at most the allowed number of times', async (endpoint) => {
    const { result, calls } = await countOperations(() => get(endpoint, 365));
    expect(result.status).toBe(200);
    const fullWindow = aggregatesOf(calls).filter((pipeline) => coversWindow(pipeline, windowQuery(365)));
    expect(fullWindow.length).toBeGreaterThan(0); // the request did read its window: an empty test cannot pass
    expect(fullWindow.length).toBeLessThanOrEqual(SCANS_ALLOWED[endpoint]);
  });

  const stripVolatile = (body) => JSON.parse(JSON.stringify(body,
    (key, value) => (['generatedAt', 'requestId', 'cachedAt'].includes(key) ? undefined : value)));
  it.each(ENDPOINTS.flatMap((endpoint) => [[endpoint, 30], [endpoint, 365]]))(
    'A2: GET /analytics/%s for %i days answers exactly as before the speed-up', async (endpoint, days) => {
      const response = await get(endpoint, days);
      expect(response.status).toBe(200);
      expect(stripVolatile(response.body)).toMatchSnapshot();
    });

  it('A3: /transactions/stats reports the same totals and top items as a direct aggregation', async () => {
    const response = await request.get('/api/transactions/stats').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    const cafeObjectId = new mongoose.Types.ObjectId(String(cafeId));
    const [totals] = await Transaction.aggregate([
      { $match: { cafeId: cafeObjectId, status: 'approved' } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$total' } } },
    ]);
    // getStats counts demand lines only (BE-03-T11), so the comparison filters the same way.
    const perItem = await Transaction.aggregate([
      { $match: { cafeId: cafeObjectId, status: 'approved' } }, { $unwind: '$items' }, { $match: DEMAND_LINE_MATCH },
      { $group: { _id: '$items.name', qty: { $sum: '$items.quantity' } } },
    ]);
    const quantityByName = new Map(perItem.map((row) => [row._id, row.qty]));
    expect(response.body.stats.totalTransactions).toBe(totals.count);
    expect(response.body.stats.totalRevenue).toBeCloseTo(totals.revenue, 2);
    expect(response.body.stats.topItems.map((item) => item.qty)).toEqual([...quantityByName.values()].sort((a, b) => b - a).slice(0, 5));
    response.body.stats.topItems.forEach((item) => expect(quantityByName.get(item.name)).toBe(item.qty));
  });
});
