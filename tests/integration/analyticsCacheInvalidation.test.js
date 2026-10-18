const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  invalidateInsights: async () => {},
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const PaymentSession = require('../../src/models/PaymentSession.model');
const oneGate = require('../../src/services/onegate.service');
const { reconcileOneGatePayment } = require('../../src/services/billingPayments.service');

const request = supertest(app);
const FEBRUARY = { startDate: '2026-02-01', endDate: '2026-02-28' };

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  process.env.API_CACHE_ENABLED = 'false';
  jest.restoreAllMocks();
  await clearDB();
});

const THREE_ROWS = [
  'Receipt,Date,Time,Status,Payment Method,Order Number,Card Reader,Items,Note,Currency,Tip,Discount,VAT,Total (incl. tax),Fee Amount,Net Amount',
  '2026/02/000001,2026/02/10,09:30:00,Approved,Card,#0001,,1 x Flat White,,ZAR,0.0,0.0,0.0,40.0,0.0,40.0',
  '2026/02/000002,2026/02/10,10:30:00,Approved,Card,#0002,,1 x Latte,,ZAR,0.0,0.0,0.0,45.0,0.0,45.0',
  '2026/02/000003,2026/02/11,11:30:00,Approved,Cash,#0003,,2 x Muffin,,ZAR,0.0,0.0,0.0,60.0,0.0,60.0',
].join('\n');

// The response cache is off under NODE_ENV=test; these tests turn it on only around the reads they time.
const withCache = async (fn) => {
  process.env.API_CACHE_ENABLED = 'true';
  try {
    return await fn();
  } finally {
    process.env.API_CACHE_ENABLED = 'false';
  }
};
const revenue = (who) => request.get('/api/analytics/revenue').set('Authorization', `Bearer ${who.token}`).query(FEBRUARY);
const cacheOf = async (who) => (await withCache(() => revenue(who))).headers['x-guava-cache'];

describe('analytics cache invalidation', () => {
  it('shows a fresh import on the very next request and leaves other cafes cached', async () => {
    const cafeA = await createTestUser();
    const cafeB = await createTestUser({ email: 'other@yourguava.com', cafeName: 'Other Cafe', orgName: 'Other Org' });
    expect(await cacheOf(cafeA)).toBe('miss');
    expect(await cacheOf(cafeA)).toBe('hit');
    expect(await cacheOf(cafeB)).toBe('miss');
    expect(await cacheOf(cafeB)).toBe('hit');

    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${cafeA.token}`)
      .attach('file', Buffer.from(THREE_ROWS), 'three-rows.csv');
    expect(stage.body.uploadId).toBeTruthy();
    const confirmed = await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${cafeA.token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
    expect(confirmed.status).toBe(200);

    const after = await withCache(() => revenue(cafeA));
    expect(after.headers['x-guava-cache']).toBe('miss');
    expect(after.body.summary.totalRevenue).toBe(145); // 40 + 45 + 60
    expect(await cacheOf(cafeB)).toBe('hit');
  });

  it('does not let a replayed payment callback evict anyone', async () => {
    const owner = await createTestUser();
    await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'already-paid-reference',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
      status: 'paid',
      paidAt: new Date(),
    });
    await cacheOf(owner);
    expect(await cacheOf(owner)).toBe('hit');

    await request.post('/api/account/payments/onegate/notify').send({ reference: 'already-paid-reference' });
    await request.get('/api/account/payments/paystack/return').query({ reference: 'already-paid-reference' });

    expect(await cacheOf(owner)).toBe('hit');
  });

  it('evicts the paying organisation when its payment settles, and only that organisation', async () => {
    const payer = await createTestUser();
    const bystander = await createTestUser({ email: 'bystander@yourguava.com', cafeName: 'Bystander Cafe', orgName: 'Bystander Org' });
    await PaymentSession.create({
      orgId: payer.user.orgId,
      userId: payer.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'settling-reference',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
    });
    jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue({
      id: 'provider-settling-reference',
      successful: 1,
      status: 'complete',
      amount: '99.00',
      currency: 'ZAR',
      merchant_reference: 'settling-reference',
    });
    await cacheOf(payer);
    await cacheOf(bystander);

    const settled = await reconcileOneGatePayment('settling-reference');

    expect(settled.status).toBe('paid');
    expect(await cacheOf(payer)).toBe('miss');
    expect(await cacheOf(bystander)).toBe('hit');
  });
});
