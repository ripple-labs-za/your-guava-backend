jest.mock('../../src/services/anthropicClient.service', () => ({
  ...jest.requireActual('../../src/services/anthropicClient.service'),
  createAnthropicClient: jest.fn(),
}));

const { setup, teardown, clearDB, createTestUser } = require('../setup');
const { createAnthropicClient } = require('../../src/services/anthropicClient.service');
const { suggestMenuItemReview } = require('../../src/services/menuItemReviewAi.service');
const { meterGuavaCredits } = require('../../src/services/usage.service');
const Organization = require('../../src/models/Organization.model');
const UsageLedger = require('../../src/models/UsageLedger.model');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_USER_DAILY_CREDIT_LIMIT;
  jest.restoreAllMocks();
  await clearDB();
});

const abortError = () => Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
const item = { _id: 'review-item', name: 'Latte', category: 'coffee', avgPrice: 30 };
const review = (owner, controller, key) => suggestMenuItemReview(owner.user.activeCafeId, item, [], {
  useAi: true, orgId: owner.user.orgId, userId: owner.user.id,
  signal: controller.signal, idempotencyPrefix: key,
});
const clientFor = (send) => {
  const client = { fetch: jest.fn(send) };
  // Mirrors the SDK transport boundary: pre-aborted calls never dispatch fetch.
  client.messages = { create: jest.fn((_body, { signal }) => {
    if (signal?.aborted) return Promise.reject(abortError());
    return client.fetch('http://stub.invalid/messages', { signal });
  }) };
  createAnthropicClient.mockReturnValue(client);
  return client;
};

it('refunds an abandoned menu review but counts provider dispatches against the daily cap', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-only';
  process.env.AI_USER_DAILY_CREDIT_LIMIT = '2';
  const owner = await createTestUser();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const client = clientFor(async () => { controller.abort(); throw abortError(); });
    await expect(review(owner, controller, `abort-${attempt}`)).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.fetch).toHaveBeenCalledTimes(1);
  }
  const rows = await UsageLedger.find({ orgId: owner.user.orgId }).lean();
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.status)).toEqual(['refunded', 'refunded']);
  expect(rows.map((row) => row.providerConsumedRuns)).toEqual([1, 1]);
  expect((await Organization.findById(owner.user.orgId)).aiCredits.used).toBe(0);
  const run = jest.fn();
  await expect(meterGuavaCredits({ orgId: owner.user.orgId, userId: owner.user.id,
    featureKey: 'menu_item_ai_review', idempotencyKey: 'over-cap', run,
  })).rejects.toMatchObject({ code: 'AI_USER_DAILY_BUDGET_REACHED' });
  expect(run).not.toHaveBeenCalled();
});

it('does not record provider consumption when the review was cancelled before dispatch', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-only';
  const owner = await createTestUser();
  const controller = new AbortController();
  controller.abort();
  const client = clientFor(async () => { throw new Error('must not send'); });
  await expect(review(owner, controller, 'pre-aborted')).rejects.toMatchObject({ name: 'AbortError' });
  expect(client.fetch).not.toHaveBeenCalled();
  const row = await UsageLedger.findOne({ orgId: owner.user.orgId }).lean();
  expect(row.status).toBe('refunded');
  expect(row.providerConsumedRuns || 0).toBe(0);
  expect((await Organization.findById(owner.user.orgId)).aiCredits.used).toBe(0);
});
