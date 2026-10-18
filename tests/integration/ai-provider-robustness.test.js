const mockAnthropicMessageCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

const supertest = require('supertest');
const {
  setup,
  teardown,
  clearDB,
  createTestUser,
  app,
} = require('../setup');
const Item = require('../../src/models/Item.model');
const Transaction = require('../../src/models/Transaction.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const { _resetInsightsCache } = require('../../src/services/anthropic.service');
const { suggestMenuItemReviews } = require('../../src/services/menuItemReviewAi.service');

const request = supertest(app);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (probe, attempts = 500) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await sleep(10);
  }
  throw new Error('Timed out waiting for the expected state');
};
const abortable = (signal) => new Promise((_resolve, reject) => {
  signal?.addEventListener('abort', () => {
    reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }));
  }, { once: true });
});
const messageStart = { type: 'message_start', message: { id: 'msg_rb', model: 'test-model', usage: { input_tokens: 700 } } };
const textDelta = (text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
// Yields the given events, then stalls until the request is aborted.
const stallAfter = (events, signals = []) => (_request, options = {}) => {
  signals.push(options.signal);
  return Promise.resolve({
  async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
    await abortable(options.signal);
  },
  });
};
const eventData = (text, name) => {
  const match = text.match(new RegExp(`event: ${name}\\ndata: (.*)\\n`));
  return match ? JSON.parse(match[1]) : null;
};
// Yesterday or earlier in every timezone, so the insight window (completed days, BE-05-T04) includes it.
const seedCompletedDaySales = (cafeId) => Transaction.create({
  cafeId,
  receiptId: 'robustness-seed',
  date: new Date(Date.now() - 36 * 3_600_000),
  status: 'approved',
  total: 45,
  items: [{ name: 'Flat White', quantity: 1, unitPrice: 45 }],
});
const insightReply = (text, extra = {}) => ({
  id: 'msg_insight', model: 'test-model', usage: { input_tokens: 800, output_tokens: 120 },
  stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra,
});

const originalIdle = process.env.AI_STREAM_IDLE_TIMEOUT_MS;
const originalNodeEnv = process.env.NODE_ENV;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  jest.restoreAllMocks();
  await _resetInsightsCache();
  delete process.env.ANTHROPIC_API_KEY;
  if (originalIdle === undefined) delete process.env.AI_STREAM_IDLE_TIMEOUT_MS;
  else process.env.AI_STREAM_IDLE_TIMEOUT_MS = originalIdle;
  process.env.NODE_ENV = originalNodeEnv;
  await clearDB();
});

describe('insight replies the model wraps in prose', () => {
  it('extracts the insight array from a reply with a preamble and a trailing sentence', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await seedCompletedDaySales(owner.user.activeCafeId);
    mockAnthropicMessageCreate.mockResolvedValue(insightReply(
      'Here are your insights [as requested]:\n["Flat whites peak on Fridays.", "Muffins sell out by 10:00."]\nLet me know!'
    ));

    const response = await request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'preamble-refresh')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.insights).toEqual(['Flat whites peak on Fridays.', 'Muffins sell out by 10:00.']);
  });

  it('reports a reply cut off at the token limit as truncated and refunds it', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await seedCompletedDaySales(owner.user.activeCafeId);
    mockAnthropicMessageCreate.mockResolvedValue(insightReply('["One insight.", "Two ins', { stop_reason: 'max_tokens' }));

    const response = await request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'truncated-refresh')
      .send({});

    expect(response.status).toBe(502);
    expect(response.body.details).toEqual(expect.objectContaining({ code: 'AI_OUTPUT_TRUNCATED' }));
    const row = await UsageLedger.findOne({ idempotencyKey: 'truncated-refresh' }).lean();
    expect(row.status).toBe('refunded');
    expect(row.providerConsumedRuns).toBe(1); // BE-05-T01; drop this line only if T01 was skipped
  });

  it('refuses a reply that is JSON but not a list of insight strings', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await seedCompletedDaySales(owner.user.activeCafeId);
    mockAnthropicMessageCreate.mockResolvedValue(insightReply('{"insights": 3}'));

    const response = await request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'wrong-shape-refresh')
      .send({});

    expect(response.status).toBe(502);
    expect(response.body.details).toEqual(expect.objectContaining({ code: 'AI_INVALID_RESPONSE' }));
  });
});

describe('stalled streams', () => {
  it('ends a stream that stalls before its first delta, refunds it and logs it with the request id', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.AI_STREAM_IDLE_TIMEOUT_MS = '1000';
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const owner = await createTestUser();
    await seedCompletedDaySales(owner.user.activeCafeId);
    const signals = [];
    mockAnthropicMessageCreate.mockImplementation(stallAfter([messageStart], signals));

    const started = Date.now();
    const response = await request
      .post('/api/forecasts/insights/chat/stream')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'stall-before-delta')
      .set('X-Request-Id', 'stall-request-0001')
      .send({ messages: [{ role: 'user', content: 'Anything?' }] });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signals[0].aborted).toBe(true);
    expect(signals[0].reason.code).toBe('AI_PROVIDER_TIMEOUT');
    expect(eventData(response.text, 'error')).toEqual(expect.objectContaining({
      code: 'AI_PROVIDER_TIMEOUT', charged: false, retryable: true,
    }));
    const row = await UsageLedger.findOne({ idempotencyKey: 'stall-before-delta' }).lean();
    expect(row.status).toBe('refunded');
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(
      /^\[anthropic\] streamBusinessChatResponse failed: status=null type=AiStreamTimeoutError requestId=stall-request-0001/
    ));
  });

  it('ends a stream that stalls after its first delta within the idle limit and charges it (D-015)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.AI_STREAM_IDLE_TIMEOUT_MS = '1000';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const owner = await createTestUser();
    await seedCompletedDaySales(owner.user.activeCafeId);
    const signals = [];
    mockAnthropicMessageCreate.mockImplementation(stallAfter([messageStart, textDelta('Mornings are ')], signals));

    const started = Date.now();
    const response = await request
      .post('/api/forecasts/insights/chat/stream')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'stall-after-delta')
      .send({ messages: [{ role: 'user', content: 'When am I busy?' }] });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signals[0].aborted).toBe(true);
    expect(signals[0].reason.code).toBe('AI_PROVIDER_TIMEOUT');
    expect(eventData(response.text, 'error')).toEqual(expect.objectContaining({ code: 'AI_STREAM_INTERRUPTED', charged: true }));
    const row = await UsageLedger.findOne({ idempotencyKey: 'stall-after-delta' }).lean();
    expect(row.status).toBe('committed');
  });
});

describe('menu item AI review cancellation', () => {
  it('refunds the reviews in flight and starts no more when the request is aborted', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    const items = await Item.create([1, 2, 3, 4].map((index) => ({
      cafeId: owner.user.activeCafeId, name: `Mystery item ${index}`, category: 'other',
      isActive: true, reviewStatus: 'needs_review', totalSold: 3, avgPrice: 20,
    })));
    mockAnthropicMessageCreate.mockImplementation((_request, options = {}) => abortable(options.signal));
    // The AI path is gated off under the test environment; open it the way tests/unit/menuItemReviewAi.test.js does
    // (today NODE_ENV; after BE-12-T01 the explicit flag that card introduced).
    process.env.NODE_ENV = 'development';
    const controller = new AbortController();

    const pending = suggestMenuItemReviews(
      owner.user.activeCafeId,
      items.map((item) => ({ item: item.toObject(), candidates: [] })),
      { orgId: owner.user.orgId, userId: owner.user.id, useAi: true, idempotencyPrefix: 'menu-abort', signal: controller.signal }
    ).catch((error) => error);
    await waitFor(() => mockAnthropicMessageCreate.mock.calls.length === 2);
    controller.abort(Object.assign(new Error('Client disconnected'), { name: 'AbortError' }));

    const outcome = await Promise.race([pending, sleep(3_000).then(() => 'still running')]);
    expect(outcome).not.toBe('still running');
    // Promise.all settles on the first rejection; the second review finishes its own refund just after.
    await waitFor(async () =>
      (await UsageLedger.countDocuments({ featureKey: 'menu_item_ai_review', status: 'refunded' })) === 2);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(2);
    expect(await UsageLedger.countDocuments({ featureKey: 'menu_item_ai_review', status: 'committed' })).toBe(0);
  });
});
