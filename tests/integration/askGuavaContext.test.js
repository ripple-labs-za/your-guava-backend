const mockAnthropicMessageCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const ai = require('../../src/services/anthropic.service');
const request = supertest(app);
const seedSales = (cafeId, count, prefix) => Transaction.create(Array.from({ length: count }, (_, index) => ({
  cafeId, receiptId: `${prefix}-${index}`, date: new Date(Date.now() - (index + 1) * 3600000),
  status: 'approved', total: 40 + index, items: [{ name: 'Flat White', quantity: 1, unitPrice: 40 + index }],
})));
beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  ai._resetBusinessContextCache();
  await clearDB();
});

describe('GET /api/forecasts/insights/context (BE-13-T04)', () => {
  it('returns the next answer context counts without charging or calling the provider', async () => {
    const { token, user } = await createTestUser();
    await seedSales(user.activeCafeId, 3, 'ctx');
    const response = await request.get('/api/forecasts/insights/context').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.contextStats).toEqual(expect.objectContaining({
      transactionCount: 3, locations: 1, forecasts: expect.any(Number),
    }));
    expect(typeof response.body.contextStats.contextWindow).toBe('string');
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
    expect(await UsageLedger.countDocuments({})).toBe(0);
  });

  it('counts only the locations a manager may see', async () => {
    const owner = await createTestUser();
    const added = await request.post('/api/team/add-cafe').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Second Cafe' });
    expect(added.status).toBe(201);
    await seedSales(owner.user.activeCafeId, 2, 'first');
    await seedSales(added.body.cafe._id, 5, 'second');
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);
    const ownerView = await request.get('/api/forecasts/insights/context').set('Authorization', `Bearer ${owner.token}`);
    const managerView = await request.get('/api/forecasts/insights/context').set('Authorization', `Bearer ${manager.token}`);
    expect(ownerView.status).toBe(200);
    expect(managerView.status).toBe(200);
    expect(ownerView.body.contextStats).toMatchObject({ locations: 2, transactionCount: 7 });
    expect(managerView.body.contextStats).toMatchObject({ locations: 1, transactionCount: 2 });
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
    expect(await UsageLedger.countDocuments({})).toBe(0);
  });
});
