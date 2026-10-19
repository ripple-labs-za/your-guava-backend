// The bounded menu-review request must reach the model once (BE-12-T01): test mode no longer disables paid AI.
const mockAnthropicMessageCreate = jest.fn(() => Promise.reject(new Error('unexpected Anthropic call in production-hardening')));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

const supertest = require('supertest');
const {
  setup,
  teardown,
  clearDB,
  createTestManager,
  createTestUser,
  app,
} = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Item = require('../../src/models/Item.model');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const Transaction = require('../../src/models/Transaction.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const User = require('../../src/models/User.model');
const { buildBusinessContext } = require('../../src/services/anthropic.service');
const {
  reconcileOneGatePayment,
  reconcilePendingOneGatePayments,
} = require('../../src/services/billingPayments.service');
const {
  bonusUsedForCredits,
  meterGuavaCredits,
  reconcileStaleUsageReservations,
  refreshCreditWindow,
} = require('../../src/services/usage.service');
const oneGate = require('../../src/services/onegate.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.ONEGATE_API_URL;
  delete process.env.ONEGATE_ORGANISATION_ID;
  delete process.env.ONEGATE_ORG_ID;
  delete process.env.ONEGATE_API_SALT;
  delete process.env.API_PUBLIC_URL;
  delete process.env.ANTHROPIC_API_KEY;
  await clearDB();
});

describe('production hardening regressions', () => {
  it('invalidates an access token when live cafe membership is removed', async () => {
    const owner = await createTestUser();
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);

    await User.updateOne(
      { _id: manager.user.id },
      { $set: { cafeIds: [], activeCafeId: null } }
    );

    const response = await request
      .get('/api/cafe/me')
      .set('Authorization', `Bearer ${manager.token}`);

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/session expired/i);
  });

  it('blocks product APIs after trial expiry while keeping account recovery available', async () => {
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      // D-025: reads remain available during the three-day grace period.
      { $set: { billingStatus: 'trialing', trialEndsAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) } }
    );

    const blocked = await request
      .get('/api/cafe/me')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('BILLING_REQUIRED');

    const account = await request
      .get('/api/account')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(account.status).toBe(200);
    expect(account.body.account.organization.billingStatus).toBe('past_due');
    expect(account.body.account.usage.guavaCredits.available).toBe(0);
  });

  it('never returns stored POS or accounting OAuth tokens in cafe DTOs', async () => {
    const owner = await createTestUser();
    await Cafe.updateOne(
      { _id: owner.user.activeCafeId },
      {
        $set: {
          'yocoTokens.accessToken': 'secret-yoco-access',
          'yocoTokens.refreshToken': 'secret-yoco-refresh',
          'accountingIntegrations.xero.accessToken': 'secret-xero-access',
          'accountingIntegrations.xero.refreshToken': 'secret-xero-refresh',
          'accountingIntegrations.xero.connected': true,
        },
      }
    );

    const getResponse = await request
      .get('/api/cafe/me')
      .set('Authorization', `Bearer ${owner.token}`);
    const updateResponse = await request
      .put('/api/cafe/me')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Safe Cafe' });

    for (const response of [getResponse, updateResponse]) {
      expect(response.status).toBe(200);
      expect(response.body.cafe.yocoTokens?.accessToken).toBeUndefined();
      expect(response.body.cafe.yocoTokens?.refreshToken).toBeUndefined();
      expect(response.body.cafe.accountingIntegrations?.xero?.accessToken).toBeUndefined();
      expect(response.body.cafe.accountingIntegrations?.xero?.refreshToken).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain('secret-');
    }
  });

  it('limits a manager business context to their assigned cafes', async () => {
    const owner = await createTestUser();
    const secondCafe = await Cafe.create({ name: 'Other Location', orgId: owner.user.orgId });
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);

    await Transaction.create([
      {
        cafeId: owner.user.activeCafeId,
        receiptId: 'allowed-receipt',
        date: new Date(),
        status: 'approved',
        total: 40,
        items: [{ name: 'Flat White', quantity: 1, unitPrice: 40 }],
      },
      {
        cafeId: secondCafe._id,
        receiptId: 'forbidden-receipt',
        date: new Date(),
        status: 'approved',
        total: 999,
        items: [{ name: 'Private Item', quantity: 1, unitPrice: 999 }],
      },
    ]);

    const context = await buildBusinessContext({
      cafeId: owner.user.activeCafeId,
      orgId: owner.user.orgId,
      authorizedCafeIds: manager.user.cafeIds,
    });

    expect(context.locations).toHaveLength(1);
    expect(context.dataset.transactionCount).toBe(1);
    expect(context.dataset.totalRevenue).toBe(40);
    expect(context.topItems90d.map((item) => item.name)).not.toContain('Private Item');
  });

  it('atomically prevents concurrent Guava Credit overspend and returns a failed run\'s credit', async () => {
    const owner = await createTestUser();
    await UsageLedger.init();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      { $set: { 'aiCredits.included': 400, 'aiCredits.bonus': 0, 'aiCredits.used': 399, 'aiCredits.resetAt': new Date(Date.now() + 86_400_000) } }
    );
    const spend = (key) => meterGuavaCredits({
      orgId: owner.user.orgId, cafeId: owner.user.activeCafeId, userId: owner.user.id,
      featureKey: 'history_backfill_day', idempotencyKey: key, run: async () => 'ok',
    });
    const results = await Promise.allSettled([spend('race-a'), spend('race-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected.reason.statusCode).toBe(402);
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.used).toBe(400);

    await Organization.updateOne({ _id: owner.user.orgId }, { $set: { 'aiCredits.used': 390 } });
    await expect(meterGuavaCredits({
      orgId: owner.user.orgId, cafeId: owner.user.activeCafeId, userId: owner.user.id,
      featureKey: 'history_backfill_day', idempotencyKey: 'fails', run: async () => { throw new Error('provider down'); },
    })).rejects.toThrow('provider down');
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.used).toBe(390);
  });

  it('executes an idempotent metered operation only once', async () => {
    const owner = await createTestUser();
    await UsageLedger.init();
    let executions = 0;
    const operation = () => meterGuavaCredits({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user.id,
      featureKey: 'menu_item_ai_review',
      idempotencyKey: 'stable-test-operation',
      run: async () => {
        executions += 1;
        return 'done';
      },
    });

    await expect(operation()).resolves.toEqual(expect.objectContaining({
      result: 'done',
      replayed: false,
    }));
    await expect(operation()).resolves.toEqual(expect.objectContaining({
      result: 'done',
      replayed: true,
    }));

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(executions).toBe(1);
    expect(org.aiCredits.used).toBe(1);
    expect(await UsageLedger.countDocuments({ idempotencyKey: 'stable-test-operation' })).toBe(1);
  });

  it('atomically aborts the ledger when a credit reservation is rejected', async () => {
    const owner = await createTestUser();
    await UsageLedger.init();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          'aiCredits.included': 400,
          'aiCredits.bonus': 0,
          'aiCredits.used': 400,
          'aiCredits.resetAt': new Date(Date.now() + 86_400_000),
        },
      }
    );
    let executions = 0;

    await expect(meterGuavaCredits({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user.id,
      featureKey: 'menu_item_ai_review',
      idempotencyKey: 'rejected-reservation',
      run: async () => { executions += 1; },
    })).rejects.toMatchObject({ statusCode: 402 });

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(executions).toBe(0);
    expect(org.aiCredits.used).toBe(400);
    expect(await UsageLedger.countDocuments({ idempotencyKey: 'rejected-reservation' })).toBe(0);
  });

  it('does not refund an old reservation into a newly reset credit window', async () => {
    const owner = await createTestUser();
    const oldResetAt = new Date(Date.now() + 60_000);
    const newResetAt = new Date(Date.now() + 86_400_000);
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          'aiCredits.included': 400,
          'aiCredits.used': 0,
          'aiCredits.resetAt': oldResetAt,
        },
      }
    );

    let rejectOperation;
    let operationStarted;
    const started = new Promise((resolve) => { operationStarted = resolve; });
    const operation = meterGuavaCredits({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user.id,
      featureKey: 'menu_item_ai_review',
      idempotencyKey: 'window-bound-refund',
      run: () => {
        operationStarted();
        return new Promise((resolve, reject) => { rejectOperation = reject; });
      },
    });

    await started;
    await Organization.updateOne(
      { _id: owner.user.orgId },
      { $set: { 'aiCredits.used': 0, 'aiCredits.resetAt': newResetAt } }
    );
    rejectOperation(new Error('provider failed after the window reset'));
    await expect(operation).rejects.toThrow('provider failed');

    const org = await Organization.findById(owner.user.orgId).lean();
    const ledger = await UsageLedger.findOne({ idempotencyKey: 'window-bound-refund' }).lean();
    expect(org.aiCredits.used).toBe(0);
    expect(org.aiCredits.resetAt.getTime()).toBe(newResetAt.getTime());
    expect(ledger.status).toBe('refunded');
    expect(ledger.creditWindowResetAt.getTime()).toBe(oldResetAt.getTime());
  });

  it('preserves consumed purchased credits when the included-credit window resets', async () => {
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          'aiCredits.included': 400,
          'aiCredits.bonus': 500,
          'aiCredits.bonusUsed': 400,
          'aiCredits.used': 800,
          'aiCredits.resetAt': new Date(Date.now() - 60_000),
        },
      }
    );

    const refreshed = await refreshCreditWindow(owner.user.orgId);
    expect(refreshed.aiCredits.used).toBe(400);
    expect(refreshed.aiCredits.bonusUsed).toBe(400);
    expect(refreshed.aiCredits.bonus).toBe(500);
    expect(refreshed.aiCredits.included + refreshed.aiCredits.bonus - refreshed.aiCredits.used)
      .toBe(500);
  });

  it('migrates legacy combined usage without resurrecting inferred bonus consumption', async () => {
    const owner = await createTestUser();
    const organizationId = (await Organization.findById(owner.user.orgId))._id;
    await Organization.collection.updateOne(
      { _id: organizationId },
      {
        $set: {
          'aiCredits.included': 400,
          'aiCredits.bonus': 500,
          'aiCredits.used': 800,
          'aiCredits.resetAt': new Date(Date.now() + 86_400_000),
        },
        $unset: { 'aiCredits.bonusUsed': '' },
      }
    );

    const raw = await Organization.collection.findOne({ _id: organizationId });
    const hydrated = await Organization.findById(owner.user.orgId);
    expect(raw.aiCredits.bonusUsed).toBeUndefined();
    expect(hydrated.aiCredits.bonusUsed).toBeUndefined();
    expect(bonusUsedForCredits(hydrated)).toBe(400);
    const refreshed = await refreshCreditWindow(owner.user.orgId);
    expect(refreshed.aiCredits.bonusUsed).toBe(400);
    expect(refreshed.aiCredits.used).toBe(800);
  });

  it('refunds the exact bonus allocation after the included-credit window rolls over', async () => {
    const owner = await createTestUser();
    const oldResetAt = new Date(Date.now() + 60_000);
    const newResetAt = new Date(Date.now() + 86_400_000);
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          'aiCredits.included': 400,
          'aiCredits.bonus': 500,
          'aiCredits.bonusUsed': 0,
          'aiCredits.used': 390,
          'aiCredits.resetAt': oldResetAt,
        },
      }
    );

    let rejectOperation;
    let operationStarted;
    const started = new Promise((resolve) => { operationStarted = resolve; });
    const operation = meterGuavaCredits({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user.id,
      featureKey: 'manual',
      credits: 20,
      idempotencyKey: 'split-window-refund',
      run: () => {
        operationStarted();
        return new Promise((_resolve, reject) => { rejectOperation = reject; });
      },
    });

    await started;
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          'aiCredits.used': 10,
          'aiCredits.bonusUsed': 10,
          'aiCredits.resetAt': newResetAt,
        },
      }
    );
    rejectOperation(new Error('provider failed after rollover'));
    await expect(operation).rejects.toThrow('provider failed after rollover');

    const org = await Organization.findById(owner.user.orgId).lean();
    const ledger = await UsageLedger.findOne({ idempotencyKey: 'split-window-refund' }).lean();
    expect(ledger.creditAllocation).toEqual(expect.objectContaining({ included: 10, bonus: 10 }));
    expect(ledger.status).toBe('refunded');
    expect(org.aiCredits.used).toBe(0);
    expect(org.aiCredits.bonusUsed).toBe(0);
    expect(org.aiCredits.resetAt.getTime()).toBe(newResetAt.getTime());
  });

  it('reactivates a fingerprint-matching refunded idempotent operation exactly once', async () => {
    const owner = await createTestUser();
    await UsageLedger.init();
    let executions = 0;
    const operation = (shouldFail, semanticHash = 'same-conversation', stream = false) => meterGuavaCredits({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user.id,
      featureKey: 'menu_item_ai_review',
      idempotencyKey: 'retry-refunded-operation',
      metadata: { semanticHash, ...(stream ? { stream: true } : {}) },
      run: async () => {
        executions += 1;
        if (shouldFail) throw new Error('temporary provider failure');
        return 'recovered';
      },
    });

    await expect(operation(true, 'same-conversation', true)).rejects.toThrow('temporary provider failure');
    await expect(operation(false, 'changed-conversation')).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'USAGE_IDEMPOTENCY_FINGERPRINT_CONFLICT' },
    });
    await expect(operation(false)).resolves.toEqual(expect.objectContaining({ result: 'recovered' }));

    const org = await Organization.findById(owner.user.orgId).lean();
    const ledger = await UsageLedger.findOne({ idempotencyKey: 'retry-refunded-operation' }).lean();
    expect(executions).toBe(2);
    expect(org.aiCredits.used).toBe(1);
    expect(ledger.status).toBe('committed');
    expect(ledger.replayCount).toBe(1);
    expect(await UsageLedger.countDocuments({ idempotencyKey: 'retry-refunded-operation' })).toBe(1);
  });

  it('reclaims a stale reservation and safely reuses its idempotency key', async () => {
    const owner = await createTestUser();
    await UsageLedger.init();
    const resetAt = new Date(Date.now() + 86_400_000);
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          'aiCredits.included': 400,
          'aiCredits.bonus': 500,
          'aiCredits.bonusUsed': 10,
          'aiCredits.used': 410,
          'aiCredits.resetAt': resetAt,
        },
      }
    );
    await UsageLedger.create({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user.id,
      featureKey: 'manual',
      label: 'Stale operation',
      provider: 'guava',
      credits: 20,
      creditAllocation: { included: 10, bonus: 10 },
      creditWindowResetAt: resetAt,
      idempotencyKey: 'stale-retry-operation',
      status: 'reserved',
      reservedAt: new Date(Date.now() - 2 * 60_000),
    });

    const summary = await reconcileStaleUsageReservations({ leaseMs: 60_000 });
    let org = await Organization.findById(owner.user.orgId).lean();
    let ledger = await UsageLedger.findOne({ idempotencyKey: 'stale-retry-operation' }).lean();
    expect(summary.refunded).toBe(1);
    expect(org.aiCredits.used).toBe(390);
    expect(org.aiCredits.bonusUsed).toBe(0);
    expect(ledger.status).toBe('refunded');
    expect(ledger.recoveryReason).toBe('stale_reservation');

    await expect(meterGuavaCredits({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user.id,
      featureKey: 'manual',
      credits: 20,
      idempotencyKey: 'stale-retry-operation',
      run: async () => 'retried',
    })).resolves.toEqual(expect.objectContaining({ result: 'retried' }));

    org = await Organization.findById(owner.user.orgId).lean();
    ledger = await UsageLedger.findOne({ idempotencyKey: 'stale-retry-operation' }).lean();
    expect(org.aiCredits.used).toBe(410);
    expect(org.aiCredits.bonusUsed).toBe(10);
    expect(ledger.status).toBe('committed');
    expect(ledger.replayCount).toBe(1);
    expect(await UsageLedger.countDocuments({ idempotencyKey: 'stale-retry-operation' })).toBe(1);
  });

  it('keeps reconciliation reads free and requires an explicit bounded AI action', async () => {
    const owner = await createTestUser();
    process.env.ANTHROPIC_API_KEY = 'test-key-that-must-not-be-used';
    const items = await Item.create(
      Array.from({ length: 11 }, (_, index) => ({
        cafeId: owner.user.activeCafeId,
        name: `Review Item ${index + 1}`,
        normalizedName: `review item ${index + 1}`,
        reviewStatus: 'needs_review',
      }))
    );

    const read = await request
      .get('/api/items/reconciliation')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(read.status).toBe(200);
    expect(read.body.meta.paidAiUsed).toBe(false);
    expect(await UsageLedger.countDocuments({})).toBe(0);
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();

    mockAnthropicMessageCreate.mockResolvedValueOnce({
      id: 'menu-review-request',
      model: 'test-model',
      usage: { input_tokens: 20, output_tokens: 10 },
      content: [{ type: 'text', text: JSON.stringify({ action: 'confirm', category: 'coffee', confidence: 0.8, reason: 'A standalone drink.' }) }],
    });
    const bounded = await request
      .post('/api/items/reconciliation/suggestions')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'bounded-menu-review')
      .send({ itemIds: items.slice(0, 1).map((item) => item._id) });
    expect(bounded.status).toBe(200);
    expect(bounded.body.meta).toEqual(
      expect.objectContaining({ requested: 1, paidAiUsed: true, paidAiCount: 1 })
    );
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);
    expect(await UsageLedger.countDocuments({ status: 'committed' })).toBe(1);

    const oversized = await request
      .post('/api/items/reconciliation/suggestions')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'oversized-menu-review')
      .send({ itemIds: items.map((item) => item._id) });
    expect(oversized.status).toBe(400);
    expect(oversized.body.message).toMatch(/maximum of 10/i);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);
    expect(await UsageLedger.countDocuments({ status: 'committed' })).toBe(1);
  });

  it('rate limits the upload route with an upload budget, not the much tighter AI budget', () => {
    const { aiLimiter, uploadLimiter } = require('../../src/middleware/rateLimit.middleware');
    const { requireCreditSpend } = require('../../src/middleware/rbac.middleware');
    const router = require('../../src/routes/transactions.routes');

    const layer = router.stack.find(
      (entry) => entry.route?.path === '/upload' && entry.route.methods.post
    );
    const handlers = layer.route.stack.map((entry) => entry.handle);

    // A limiter runs first so a rate-limited request never writes a file to disk.
    expect(handlers[0]).toBe(uploadLimiter);
    // But NOT the AI limiter. Only an unrecognised POS format with no saved mapping
    // reaches Claude; a Yoco export or a cafe with a saved mapping never does. Gating
    // every upload on the AI budget meant an owner importing a backlog of monthly
    // exports was cut off after a handful, and told it was "too many AI requests".
    // The AI call is separately bounded by the daily-credit and concurrency policy in
    // aiUsage.service, and it costs credits, which is its own natural brake.
    expect(handlers).not.toContain(aiLimiter);
    // Members without credit permission must still upload preset formats: the
    // controller downgrades to a free mapping rather than rejecting with 403.
    expect(handlers).not.toContain(requireCreditSpend);
  });

  it('gives uploads a materially larger budget than paid AI calls', () => {
    const { getLimiterOptions } = require('../../src/middleware/rateLimit.middleware');
    const upload = getLimiterOptions('upload');
    const ai = getLimiterOptions('ai');

    expect(upload.limit).toBeGreaterThan(ai.limit);
    // An owner catching up on a year of monthly exports uploads 12 files in a burst.
    expect(upload.limit).toBeGreaterThanOrEqual(30);
  });

  it('requires a bounded Idempotency-Key for configured paid chat endpoints', async () => {
    const owner = await createTestUser();
    process.env.ANTHROPIC_API_KEY = 'configured-test-key';

    const missing = await request
      .post('/api/forecasts/insights/chat')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ question: 'How are sales?' });
    const oversized = await request
      .post('/api/forecasts/insights/chat/stream')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'x'.repeat(161))
      .send({ question: 'How are sales?' });

    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/Idempotency-Key is required/i);
    expect(oversized.status).toBe(400);
    expect(oversized.body.message).toMatch(/Idempotency-Key is too long/i);
    expect(await UsageLedger.countDocuments({})).toBe(0);
  });

  it('refunds a metered AI operation aborted before commit', async () => {
    const owner = await createTestUser();
    const controller = new AbortController();
    const abortError = new Error('Client disconnected');
    abortError.name = 'AbortError';

    await expect(meterGuavaCredits({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user.id,
      featureKey: 'ask_guava_chat',
      idempotencyKey: 'aborted-chat-operation',
      signal: controller.signal,
      run: async () => {
        controller.abort(abortError);
        return 'unseen answer';
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    const org = await Organization.findById(owner.user.orgId).lean();
    const ledger = await UsageLedger.findOne({ idempotencyKey: 'aborted-chat-operation' }).lean();
    expect(org.aiCredits.used).toBe(0);
    expect(ledger.status).toBe('refunded');
  });

  it('fulfils concurrent duplicate payment notifications exactly once', async () => {
    const owner = await createTestUser();
    process.env.PAYMENT_PROVIDER = 'onegate';
    process.env.ONEGATE_API_URL = 'https://payments.onegate.co.za';
    process.env.ONEGATE_ORGANISATION_ID = '21234';
    process.env.ONEGATE_API_SALT = 'test-salt';
    process.env.API_PUBLIC_URL = 'http://api.test';

    jest.spyOn(oneGate, 'createPaymentKey').mockResolvedValue({
      key: 'credit_pack_key',
      url: 'https://payments.onegate.co.za/pay/hosted?payment_key=credit_pack_key',
      origin: 'https://payments.onegate.co.za',
    });

    const checkout = await request
      .post('/api/account/ai-credits')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'duplicate-credit-notification-checkout')
      .send({ credits: 500 });
    const reference = checkout.body.purchase.reference;

    const lookup = jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue({
      id: 'provider-transaction-1',
      successful: 1,
      status: 'complete',
      amount: '99.00',
      currency: 'ZAR',
      merchant_reference: reference,
    });

    const [first, second] = await Promise.all([
      request.post('/api/account/payments/onegate/notify').send({ merchant_reference: reference }),
      request.post('/api/account/payments/onegate/notify').send({ merchant_reference: reference }),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(lookup).toHaveBeenCalledTimes(1);
    const org = await Organization.findById(owner.user.orgId).lean();
    const session = await PaymentSession.findOne({ reference }).lean();
    expect(org.aiCredits.bonus).toBe(500);
    expect(session.status).toBe('paid');
  });

  it('keeps payment return and status GET requests read-only', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'read-only-payment-reference',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
    });
    const lookup = jest.spyOn(oneGate, 'lookupGatewayTransaction');

    const returnResponse = await request
      .get(`/api/account/payments/onegate/return?reference=${session.reference}&result=success`);
    const statusResponse = await request
      .get(`/api/account/payments/${session.reference}`)
      .set('Authorization', `Bearer ${owner.token}`);

    expect(returnResponse.status).toBe(302);
    expect(returnResponse.headers.location).toContain('payment=pending');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.payment.status).toBe('pending');
    expect(lookup).not.toHaveBeenCalled();

    const unchangedSession = await PaymentSession.findById(session._id).lean();
    const unchangedOrg = await Organization.findById(owner.user.orgId).lean();
    expect(unchangedSession.status).toBe('pending');
    expect(unchangedSession.fulfillmentAttempts).toBe(0);
    expect(unchangedOrg.aiCredits.bonus).toBe(0);
  });

  it('reconciles an aged pending payment when its webhook was lost', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'lost-webhook-payment-reference',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
    });
    await PaymentSession.collection.updateOne(
      { _id: session._id },
      { $set: { updatedAt: new Date(Date.now() - 5 * 60_000) } }
    );
    jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue({
      id: 'lost-webhook-provider-transaction',
      successful: 1,
      status: 'complete',
      amount: '99.00',
      currency: 'ZAR',
      merchant_reference: session.reference,
    });

    const summary = await reconcilePendingOneGatePayments({ minAgeMs: 30_000 });

    const paid = await PaymentSession.findById(session._id).lean();
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(summary).toEqual(expect.objectContaining({ scanned: 1, paid: 1, errors: 0 }));
    expect(paid.status).toBe('paid');
    expect(org.aiCredits.bonus).toBe(500);
  });

  it('never fulfils a provider transaction with contradictory failed status', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'contradictory-provider-payment',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
    });
    jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue({
      id: 'contradictory-provider-transaction',
      successful: 1,
      status: 'failed',
      amount: '99.00',
      currency: 'ZAR',
      merchant_reference: session.reference,
    });

    const reconciled = await reconcileOneGatePayment(session.reference);

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(reconciled.status).toBe('failed');
    expect(org.aiCredits.bonus).toBe(0);
    expect(org.fulfilledPaymentReferences || []).toHaveLength(0);
  });

  it('keeps already-consumed bonus credits consumed when a paid plan resets included credits', async () => {
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          billingStatus: 'past_due',
          'aiCredits.included': 400,
          'aiCredits.bonus': 500,
          'aiCredits.bonusUsed': 200,
          'aiCredits.used': 600,
          'aiCredits.resetAt': new Date(Date.now() - 60_000),
        },
      }
    );
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'plan',
      reference: 'bonus-preserving-plan-payment',
      amount: 899,
      currency: 'ZAR',
      plan: 'growth',
      billingCycle: 'monthly',
    });
    jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue({
      id: 'bonus-preserving-provider-payment',
      successful: 1,
      status: 'complete',
      amount: '899.00',
      currency: 'ZAR',
      merchant_reference: session.reference,
    });

    await reconcileOneGatePayment(session.reference);

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.included).toBe(1800);
    expect(org.aiCredits.bonus).toBe(500);
    expect(org.aiCredits.bonusUsed).toBe(200);
    expect(org.aiCredits.used).toBe(200);
  });

  it('does not refill included credits when an active plan renews early', async () => {
    const owner = await createTestUser();
    const lookup = jest.spyOn(oneGate, 'lookupGatewayTransaction').mockImplementation(async (reference) => ({
      id: `provider-${reference}`,
      successful: 1,
      status: 'complete',
      amount: '899.00',
      currency: 'ZAR',
      merchant_reference: reference,
    }));

    const first = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'plan',
      reference: 'first-plan-payment',
      amount: 899,
      plan: 'growth',
      billingCycle: 'monthly',
    });
    await reconcileOneGatePayment(first.reference);

    await Organization.updateOne(
      { _id: owner.user.orgId },
      { $set: { 'aiCredits.used': 37, 'aiCredits.resetAt': new Date(Date.now() + 86_400_000) } }
    );
    const firstPeriodEnd = (await Organization.findById(owner.user.orgId).lean()).currentPeriodEnd;

    const renewal = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'plan',
      reference: 'early-plan-renewal',
      amount: 899,
      plan: 'growth',
      billingCycle: 'monthly',
    });
    await reconcileOneGatePayment(renewal.reference);

    const renewed = await Organization.findById(owner.user.orgId).lean();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(renewed.aiCredits.included).toBe(1800);
    expect(renewed.aiCredits.used).toBe(37);
    expect(renewed.currentPeriodEnd.getTime()).toBeGreaterThan(firstPeriodEnd.getTime());
  });

  it('prevents an expired payment worker from releasing a newer processing lease', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'leased-payment-reference',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
    });

    let resolveFirstLookup;
    let resolveSecondLookup;
    const lookup = jest.spyOn(oneGate, 'lookupGatewayTransaction')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstLookup = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondLookup = resolve; }));
    const waitForLookup = async (count) => {
      for (let attempt = 0; attempt < 100 && lookup.mock.calls.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(lookup).toHaveBeenCalledTimes(count);
    };

    const firstWorker = reconcileOneGatePayment(session.reference);
    await waitForLookup(1);
    await PaymentSession.updateOne(
      { _id: session._id },
      { $set: { processingStartedAt: new Date(Date.now() - 3 * 60_000) } }
    );

    const secondWorker = reconcileOneGatePayment(session.reference);
    await waitForLookup(2);
    resolveFirstLookup({
      id: 'pending-provider-transaction',
      status: 'pending',
      amount: '99.00',
      currency: 'ZAR',
      merchant_reference: session.reference,
    });
    await firstWorker;

    const stillProcessing = await PaymentSession.findById(session._id).lean();
    expect(stillProcessing.status).toBe('processing');

    resolveSecondLookup({
      id: 'paid-provider-transaction',
      successful: 1,
      status: 'complete',
      amount: '99.00',
      currency: 'ZAR',
      merchant_reference: session.reference,
    });
    await secondWorker;

    const paid = await PaymentSession.findById(session._id).lean();
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(paid.status).toBe('paid');
    expect(org.aiCredits.bonus).toBe(500);
  });
});
