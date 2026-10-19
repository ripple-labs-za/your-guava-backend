const logger = require('../../src/utils/logger');
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
const Organization = require('../../src/models/Organization.model');
const GeneratedInsight = require('../../src/models/GeneratedInsight.model');
const InsightChat = require('../../src/models/InsightChat.model');
const Transaction = require('../../src/models/Transaction.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const { _resetInsightsCache } = require('../../src/services/anthropic.service');
const { waitFor } = require('../helpers/waitFor');

const request = supertest(app);

// A paid insight refresh is only started when there is something to analyse, so
// every test that expects the metered path to run has to have recent sales.
const seedRecentSales = (cafeId) =>
  Transaction.create({
    cafeId,
    receiptId: 'insight-refresh-seed',
    date: new Date(Date.now() - 36 * 3_600_000),
    status: 'approved',
    total: 45,
    items: [{ name: 'Flat White', quantity: 1, unitPrice: 45 }],
  });

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  await _resetInsightsCache();
  delete process.env.ANTHROPIC_API_KEY;
  await clearDB();
});

describe('explicit insight refresh', () => {
  it('keeps GET read-only and coalesces/replays metered refreshes', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await UsageLedger.init();
    await seedRecentSales(owner.user.activeCafeId);
    // The provider blocks until the test has seen the second request lose the lease
    // race, then answers: the verdict depends on order, not on the machine's speed.
    let releaseProvider;
    let providerEntered;
    const entered = new Promise((resolve) => { providerEntered = resolve; });
    mockAnthropicMessageCreate.mockImplementation(() => {
      providerEntered();
      return new Promise((resolve) => {
        releaseProvider = () => resolve({ content: [{ type: 'text', text: '["Prepare more flat whites tomorrow."]' }] });
      });
    });

    const initialRead = await request
      .get('/api/forecasts/insights')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(initialRead.status).toBe(200);
    expect(initialRead.body).toEqual(expect.objectContaining({
      insights: [],
      generatedAt: null,
      requiresRefresh: true,
      cacheStatus: 'empty',
    }));
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
    expect(await UsageLedger.countDocuments({})).toBe(0);

    const refreshRequest = () => request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'stable-insight-refresh')
      .send({});
    const reads = jest.spyOn(GeneratedInsight, 'findOne');
    const claims = jest.spyOn(GeneratedInsight, 'findOneAndUpdate');
    const firstPromise = refreshRequest().then((response) => response);
    await entered; // the first request holds the refresh lease and is inside the provider call
    const claimsBefore = claims.mock.calls.length;
    const secondPromise = refreshRequest().then((response) => response);
    // The second request has lost the lease once it has tried to claim it and then polled the cache again.
    await waitFor(() => {
      const lastClaim = claims.mock.invocationCallOrder.at(-1) ?? 0;
      return claims.mock.calls.length > claimsBefore && reads.mock.invocationCallOrder.some((order) => order > lastClaim);
    }, { timeoutMs: 5000, message: 'the second refresh to wait on the first' });
    releaseProvider();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    reads.mockRestore();
    claims.mockRestore();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.insights).toEqual(['Prepare more flat whites tomorrow.']);
    expect(second.body.insights).toEqual(first.body.insights);
    expect([first.body.meta.coalesced, second.body.meta.coalesced].sort()).toEqual([false, true]);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);

    const retry = await refreshRequest();
    expect(retry.status).toBe(200);
    expect(retry.body.meta.replayed).toBe(true);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);

    const cachedRead = await request
      .get('/api/forecasts/insights')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(cachedRead.body).toEqual(expect.objectContaining({
      insights: ['Prepare more flat whites tomorrow.'],
      requiresRefresh: false,
      cacheStatus: 'fresh',
    }));
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(10);
    expect(await UsageLedger.countDocuments({
      featureKey: 'insight_refresh',
      status: 'committed',
    })).toBe(1);
  });

  it('requires an idempotency key before starting a paid refresh', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();

    const response = await request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key is required/i);
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
    expect(await UsageLedger.countDocuments({})).toBe(0);
  });

  it('does not turn a metering conflict and empty cache stub into a successful refresh', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await Promise.all([GeneratedInsight.init(), UsageLedger.init()]);
    await seedRecentSales(owner.user.activeCafeId);
    await GeneratedInsight.create({
      cafeId: owner.user.activeCafeId,
      orgId: owner.user.orgId,
      insights: [],
      generatedAt: null,
    });
    await UsageLedger.create({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user._id,
      featureKey: 'ask_guava_chat',
      label: 'Ask Guava answer',
      credits: 3,
      status: 'reserved',
      idempotencyKey: 'conflicting-insight-refresh',
      requestFingerprint: '0'.repeat(64),
      reservedAt: new Date(),
    });

    const response = await request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'conflicting-insight-refresh')
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.details?.code).toBe('USAGE_IDEMPOTENCY_FINGERPRINT_CONFLICT');
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
  });

  it('durably stores a paid chat answer and replays it without a second charge', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await UsageLedger.init();
    mockAnthropicMessageCreate.mockResolvedValue({
      id: 'provider-chat-request',
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Flat whites led sales this week.' }],
    });

    const created = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        title: 'Best sellers',
        messages: [
          { role: 'user', content: 'How did yesterday go?' },
          { role: 'assistant', content: 'Yesterday was steady.' },
        ],
      });
    const chatId = created.body.chat._id;
    const chatRequest = () => request
      .post('/api/forecasts/insights/chat')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'durable-chat-answer')
      .send({
        chatId,
        messages: [
          { role: 'user', content: 'How did yesterday go?' },
          { role: 'assistant', content: 'Yesterday was steady.' },
          { role: 'user', content: 'What sold best?' },
        ],
      });

    const first = await chatRequest();
    const clientSave = await request
      .patch(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        messages: [
          { role: 'user', content: 'How did yesterday go?' },
          { role: 'assistant', content: 'Yesterday was steady.' },
          { role: 'user', content: 'What sold best?' },
          { role: 'assistant', content: 'Flat whites led sales this week.' },
        ],
        contextStats: first.body.contextStats,
      });
    const replay = await chatRequest();
    const streamReplay = await request
      .post('/api/forecasts/insights/chat/stream')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'durable-chat-answer')
      .send({
        chatId,
        messages: [
          { role: 'user', content: 'How did yesterday go?' },
          { role: 'assistant', content: 'Yesterday was steady.' },
          { role: 'user', content: 'What sold best?' },
        ],
      });

    expect(first.status).toBe(200);
    expect(clientSave.status).toBe(200);
    expect(first.body.answer).toBe('Flat whites led sales this week.');
    expect(replay.status).toBe(200);
    expect(replay.body.meta.replayed).toBe(true);
    expect(streamReplay.status).toBe(200);
    expect(streamReplay.headers['content-type']).toMatch(/text\/event-stream/);
    expect(streamReplay.text).toContain('event: delta');
    expect(streamReplay.text).toContain('Flat whites led sales this week.');
    expect(streamReplay.text).toContain('"replayed":true');
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);

    const chat = await InsightChat.findById(chatId).lean();
    expect(chat.messages).toHaveLength(4);
    expect(chat.messages[2]).toEqual(expect.objectContaining({
      role: 'user',
      content: 'What sold best?',
    }));
    expect(chat.messages[3]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Flat whites led sales this week.',
    }));
    const ledger = await UsageLedger.findOne({ idempotencyKey: 'durable-chat-answer' }).lean();
    expect(ledger.resultPayload).toEqual(expect.objectContaining({
      answer: 'Flat whites led sales this week.',
    }));
    expect(ledger.providerDiagnostics).toEqual(expect.objectContaining({
      providerRequestId: 'provider-chat-request',
      inputTokens: 100,
      outputTokens: 20,
    }));
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(3);
  });
});

describe('insight refresh lease, replay and window', () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const refresh = (owner, key) => request
    .post('/api/forecasts/insights/refresh')
    .set('Authorization', `Bearer ${owner.token}`)
    .set('Idempotency-Key', key)
    .send({})
    .then((response) => response);
  const insightsReply = (insights) => ({
    id: 'msg_insights', model: 'test-model', usage: { input_tokens: 400, output_tokens: 60 },
    stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(insights) }],
  });
  const overloaded = () => Object.assign(new Error('529 overloaded'), {
    status: 529, error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  });

  it('never overwrites a newer post-import refresh when an older paid key is replayed', async () => {
    // Replace the global Date, rather than mutating native Date.now: Mongoose
    // snapshots the native constructor and uses it to judge heartbeat age.
    // Keep all IO timers real so the replica set and HTTP requests keep running.
    const instant = Date.now();
    jest.useFakeTimers({
      now: instant,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask',
        'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    try {
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
      const owner = await createTestUser();
      await UsageLedger.init();
      await seedRecentSales(owner.user.activeCafeId);
      const { invalidateInsights } = require('../../src/services/anthropic.service');
      mockAnthropicMessageCreate
        .mockResolvedValueOnce(insightsReply(['Before the import.']))
        .mockResolvedValueOnce(insightsReply(['New post-import analysis.']));
      expect((await refresh(owner, 'old-paid-key')).status).toBe(200);
      jest.setSystemTime(instant + 1_000);
      await invalidateInsights(owner.user.activeCafeId);
      expect((await refresh(owner, 'new-paid-key')).body.insights).toEqual(['New post-import analysis.']);
      // Distinct generations and an expired coalescing window, with no wall-time wait.
      jest.setSystemTime(instant + 32_000);
      const replay = await refresh(owner, 'old-paid-key');
      expect(replay.status).toBe(200);
      expect(replay.body.cacheStatus).toBe('stale');
      expect(replay.body.requiresRefresh).toBe(true);
      expect(replay.body.meta.replayed).toBe(true);
      const read = await request.get('/api/forecasts/insights').set('Authorization', `Bearer ${owner.token}`);
      expect(read.body.insights).toEqual(['New post-import analysis.']);
      expect(read.body.cacheStatus).toBe('fresh');
      expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(2);
      expect((await Organization.findById(owner.user.orgId)).aiCredits.used).toBe(20);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([false, true])('stops the lease heartbeat after provider failure=%s', async (fails) => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.AI_INSIGHT_LEASE_MS = '1000';
    const owner = await createTestUser();
    await seedRecentSales(owner.user.activeCafeId);
    const intervals = jest.spyOn(global, 'setInterval');
    const cleared = jest.spyOn(global, 'clearInterval');
    if (fails) {
      jest.spyOn(logger, 'error').mockImplementation(() => {});
      mockAnthropicMessageCreate.mockRejectedValue(overloaded());
    } else mockAnthropicMessageCreate.mockResolvedValue(insightsReply(['Completed.']));
    const response = await refresh(owner, `heartbeat-${fails}`);
    const index = intervals.mock.calls.findIndex((call) => call[1] === 333);
    const timer = intervals.mock.results[index]?.value;
    try {
      expect(response.status).toBe(fails ? 503 : 200);
      expect(timer).toBeDefined();
      expect(cleared).toHaveBeenCalledWith(timer);
    } finally {
      if (timer) clearInterval(timer);
    }
  });

  afterEach(() => {
    delete process.env.AI_INSIGHT_LEASE_MS;
    jest.restoreAllMocks();
  });

  it('renews the refresh lease while a slow provider call runs, so a second tab coalesces instead of paying again', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.AI_INSIGHT_LEASE_MS = '1000';
    const owner = await createTestUser();
    await UsageLedger.init();
    await seedRecentSales(owner.user.activeCafeId);
    mockAnthropicMessageCreate.mockImplementation(async () => {
      await sleep(2_500);
      return insightsReply(['Slow but sure.']);
    });

    const holder = refresh(owner, 'slow-holder');
    const leased = await waitFor(() => GeneratedInsight.findOne({ 'refreshLease.token': { $exists: true } }).lean());
    const firstExpiry = new Date(leased.refreshLease.expiresAt).getTime();
    await sleep(1_500);
    const renewed = await GeneratedInsight.findOne({ cafeId: owner.user.activeCafeId }).lean();
    expect(new Date(renewed.refreshLease.expiresAt).getTime()).toBeGreaterThan(firstExpiry);

    const [first, second] = await Promise.all([holder, refresh(owner, 'second-tab')]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.meta.coalesced).toBe(true);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(10);
  }, 15_000);

  it('lets a waiting refresh run once the holder fails, instead of reporting a false 409', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    const owner = await createTestUser();
    await UsageLedger.init();
    await seedRecentSales(owner.user.activeCafeId);
    mockAnthropicMessageCreate
      .mockImplementationOnce(async () => { await sleep(300); throw overloaded(); })
      .mockImplementationOnce(async () => insightsReply(['Second tab wins.']));

    const holder = refresh(owner, 'holder-fails');
    await waitFor(() => GeneratedInsight.findOne({ 'refreshLease.token': { $exists: true } }).lean());
    const [first, second] = await Promise.all([holder, refresh(owner, 'waiter-runs')]);

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(second.body.insights).toEqual(['Second tab wins.']);
    expect(second.body.meta.coalesced).toBe(false);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(2);
  });

  it('never republishes a pre-import analysis when a lost-response refresh is retried after an import', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await UsageLedger.init();
    await seedRecentSales(owner.user.activeCafeId);
    const { invalidateInsights } = require('../../src/services/anthropic.service');
    mockAnthropicMessageCreate.mockResolvedValue(insightsReply(['Before the import.']));

    const original = await refresh(owner, 'lost-response');
    expect(original.status).toBe(200);
    await invalidateInsights(owner.user.activeCafeId); // an import committed while the response was lost

    const retry = await refresh(owner, 'lost-response');
    expect(retry.status).toBe(200);
    expect(retry.body.meta.replayed).toBe(true);
    expect(retry.body.cacheStatus).toBe('stale');
    expect(retry.body.requiresRefresh).toBe(true);
    const read = await request.get('/api/forecasts/insights').set('Authorization', `Bearer ${owner.token}`);
    expect(read.body.cacheStatus).toBe('stale');
    expect(read.body.requiresRefresh).toBe(true);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);
  });

  it('reports a cafe with no sales as insufficient data, not as a fresh analysis', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();

    const response = await refresh(owner, 'no-sales');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      cacheStatus: 'insufficient_data', requiresRefresh: true, insufficientData: true,
    }));
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
  });

  it('treats a cafe whose only sales are from today as having nothing to analyse yet', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await Transaction.create({
      cafeId: owner.user.activeCafeId, receiptId: 'today-only', date: new Date(), status: 'approved', total: 45,
      items: [{ name: 'Flat White', quantity: 1, unitPrice: 45 }],
    });

    const response = await refresh(owner, 'today-only');

    expect(response.body.cacheStatus).toBe('insufficient_data');
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
  });

  it('analyses the 14 completed days before today and leaves the partial day out', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    const Cafe = require('../../src/models/Cafe.model');
    const cafe = await Cafe.findById(owner.user.activeCafeId).lean();
    const timeZone = cafe.timezone || 'Africa/Johannesburg';
    const todayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    await Transaction.create([
      { cafeId: cafe._id, receiptId: 'today-partial', date: new Date(), status: 'approved', total: 900,
        items: [{ name: 'Flat White', quantity: 20, unitPrice: 45 }] },
      { cafeId: cafe._id, receiptId: 'yesterday', date: new Date(Date.now() - 36 * 3_600_000), status: 'approved', total: 6000,
        items: [{ name: 'Flat White', quantity: 130, unitPrice: 46 }] },
      { cafeId: cafe._id, receiptId: 'too-old', date: new Date(Date.now() - 16 * 24 * 3_600_000), status: 'approved', total: 10,
        items: [{ name: 'Flat White', quantity: 1, unitPrice: 10 }] },
    ]);
    mockAnthropicMessageCreate.mockResolvedValue(insightsReply(['Steady week.']));

    const response = await refresh(owner, 'window-check');

    expect(response.status).toBe(200);
    const prompt = mockAnthropicMessageCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('"totalTransactions": 1');
    expect(prompt).not.toContain(`"${todayKey}"`);
    expect(prompt).toMatch(/14 completed days/);
  });
});
