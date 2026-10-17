const {
  setup,
  teardown,
  clearDB,
  createTestUser,
} = require('../setup');
const Organization = require('../../src/models/Organization.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const {
  meterGuavaCredits,
  reconcileStaleUsageReservations,
} = require('../../src/services/usage.service');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const waitFor = async (probe, attempts = 200) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the expected state');
};

describe('metered Guava Credit amounts', () => {
  it('refuses a credit amount that is not a non-negative number', async () => {
    const owner = await createTestUser();
    const run = jest.fn(async () => ({ answer: 'no' }));

    await expect(
      meterGuavaCredits({
        orgId: owner.user.orgId,
        userId: owner.user.id,
        featureKey: 'ask_guava_chat',
        credits: -1,
        run,
      })
    ).rejects.toThrow(/non-negative/i);
    await expect(
      meterGuavaCredits({
        orgId: owner.user.orgId,
        userId: owner.user.id,
        featureKey: 'ask_guava_chat',
        credits: 'three',
        run,
      })
    ).rejects.toThrow(/non-negative/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('still gates a zero-cost feature on billing access', async () => {
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      { $set: { billingStatus: 'past_due', trialEndsAt: new Date(Date.now() - 60_000) } }
    );
    const run = jest.fn(async () => ({ answer: 'free' }));

    await expect(
      meterGuavaCredits({
        orgId: owner.user.orgId,
        userId: owner.user.id,
        featureKey: 'ask_guava_chat',
        credits: 0,
        run,
      })
    ).rejects.toMatchObject({ statusCode: 402, code: 'BILLING_REQUIRED' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Guava Credit reservation lease breach', () => {
  it('keeps the delivered answer and re-charges when the reconciler refunded mid-run', async () => {
    const owner = await createTestUser();
    let finishRun;
    const metered = meterGuavaCredits({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      featureKey: 'ask_guava_chat',
      idempotencyKey: 'lease-breach-request',
      run: () => new Promise((resolve) => { finishRun = resolve; }),
    });

    const reserved = await waitFor(() =>
      UsageLedger.findOne({ orgId: owner.user.orgId, status: 'reserved' }).lean()
    );
    // The run outlives its lease and the reconciler releases the hold.
    await UsageLedger.updateOne(
      { _id: reserved._id },
      { $set: { reservedAt: new Date(Date.now() - 10 * 60_000) } }
    );
    const recovery = await reconcileStaleUsageReservations({ leaseMs: 60_000 });
    expect(recovery.refunded).toBe(1);

    finishRun({ answer: 'delivered anyway' });
    const outcome = await metered;

    expect(outcome.result).toEqual({ answer: 'delivered anyway' });
    const settled = await UsageLedger.findById(reserved._id).lean();
    expect(settled.status).toBe('committed');
    expect(settled.resultPayload).toEqual({ answer: 'delivered anyway' });
    expect(settled.recoveryReason).toBe('lease_breach_recommitted');
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(3);
  });

  it('charges exactly once when the reconciler and the commit race', async () => {
    const owner = await createTestUser();
    let finishRun;
    const metered = meterGuavaCredits({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      featureKey: 'ask_guava_chat',
      idempotencyKey: 'lease-breach-race',
      run: () => new Promise((resolve) => { finishRun = resolve; }),
    });

    const reserved = await waitFor(() =>
      UsageLedger.findOne({ orgId: owner.user.orgId, status: 'reserved' }).lean()
    );
    await UsageLedger.updateOne(
      { _id: reserved._id },
      { $set: { reservedAt: new Date(Date.now() - 10 * 60_000) } }
    );

    // Whichever side wins the row, the customer is charged for the answer once:
    // never twice, and never not at all.
    const recovery = reconcileStaleUsageReservations({ leaseMs: 60_000 });
    finishRun({ answer: 'raced' });
    const [outcome] = await Promise.all([metered, recovery]);

    expect(outcome.result).toEqual({ answer: 'raced' });
    const settled = await UsageLedger.findById(reserved._id).lean();
    expect(settled.status).toBe('committed');
    expect(settled.resultPayload).toEqual({ answer: 'raced' });
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(3);
  });
});

describe('refunded AI runs that reached the provider', () => {
  const originalUserLimit = process.env.AI_USER_DAILY_CREDIT_LIMIT;
  const originalOrgLimit = process.env.AI_ORG_DAILY_CREDIT_LIMIT;

  afterEach(() => {
    if (originalUserLimit === undefined) delete process.env.AI_USER_DAILY_CREDIT_LIMIT;
    else process.env.AI_USER_DAILY_CREDIT_LIMIT = originalUserLimit;
    if (originalOrgLimit === undefined) delete process.env.AI_ORG_DAILY_CREDIT_LIMIT;
    else process.env.AI_ORG_DAILY_CREDIT_LIMIT = originalOrgLimit;
  });

  const failAfterProvider = (meter) => {
    meter.recordProviderDiagnostics({ operation: 'ask_guava_chat', inputTokens: 900, outputTokens: 0 });
    throw Object.assign(new Error('provider stream broke'), { statusCode: 503 });
  };
  const failBeforeProvider = async () => {
    throw Object.assign(new Error('provider unreachable'), { statusCode: 503 });
  };
  const meterFor = (owner, idempotencyKey, run) => meterGuavaCredits({
    orgId: owner.user.orgId,
    userId: owner.user.id,
    featureKey: 'ask_guava_chat',
    idempotencyKey,
    run,
  });

  it('count toward the per-user daily AI safety budget without charging the customer', async () => {
    process.env.AI_USER_DAILY_CREDIT_LIMIT = '10';
    const owner = await createTestUser();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(meterFor(owner, `consumed-${attempt}`, failAfterProvider)).rejects.toThrow('provider stream broke');
    }

    // Three refunded runs x 3 credits = 9 of a 10-credit budget; the fourth needs 3 more.
    await expect(meterFor(owner, 'fourth', async () => ({ answer: 'x' })))
      .rejects.toMatchObject({ statusCode: 429, code: 'AI_USER_DAILY_BUDGET_REACHED' });
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(0);
    const rows = await UsageLedger.find({ status: 'refunded' }).lean();
    expect(rows.map((row) => row.providerConsumedRuns)).toEqual([1, 1, 1]);
  });

  it('count toward the per-organisation daily AI safety budget', async () => {
    process.env.AI_ORG_DAILY_CREDIT_LIMIT = '10';
    const owner = await createTestUser();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(meterFor(owner, `org-consumed-${attempt}`, failAfterProvider)).rejects.toThrow('provider stream broke');
    }

    await expect(meterFor(owner, 'org-fourth', async () => ({ answer: 'x' })))
      .rejects.toMatchObject({ statusCode: 429, code: 'AI_ORG_DAILY_BUDGET_REACHED' });
  });

  it('count every provider-consuming attempt when one idempotency key is retried', async () => {
    process.env.AI_USER_DAILY_CREDIT_LIMIT = '10';
    const owner = await createTestUser();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(meterFor(owner, 'reused-key', failAfterProvider)).rejects.toThrow('provider stream broke');
    }

    const row = await UsageLedger.findOne({ idempotencyKey: 'reused-key' }).lean();
    expect(row.providerConsumedRuns).toBe(3);
    await expect(meterFor(owner, 'after-reuse', async () => ({ answer: 'x' })))
      .rejects.toMatchObject({ statusCode: 429, code: 'AI_USER_DAILY_BUDGET_REACHED' });
  });

  it('do not count when the provider was never reached', async () => {
    process.env.AI_USER_DAILY_CREDIT_LIMIT = '10';
    const owner = await createTestUser();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(meterFor(owner, `unreached-${attempt}`, failBeforeProvider)).rejects.toThrow('provider unreachable');
    }

    const outcome = await meterFor(owner, 'reachable', async () => ({ answer: 'fine' }));
    expect(outcome.result).toEqual({ answer: 'fine' });
    expect(await UsageLedger.countDocuments({ providerConsumedRuns: { $gt: 0 } })).toBe(0);
  });
});

describe('same-key answer settlement waits', () => {
  const reserveHeld = async (owner, key) => {
    let resolveRun;
    let rejectRun;
    const outcome = meterGuavaCredits({
      orgId: owner.user.orgId, userId: owner.user.id, featureKey: 'ask_guava_chat', idempotencyKey: key,
      run: () => new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; }),
    });
    const settled = outcome.then((result) => ({ result }), (error) => ({ error }));
    await waitFor(() => resolveRun);
    return { settled, resolveRun, rejectRun };
  };

  it('re-reserves a refunded in-flight attempt instead of replaying its failure', async () => {
    const owner = await createTestUser();
    const held = await reserveHeld(owner, 'wait-for-refund');
    const run = jest.fn(async () => ({ answer: 'retry worked' }));
    const retry = meterGuavaCredits({
      orgId: owner.user.orgId, userId: owner.user.id, featureKey: 'ask_guava_chat',
      idempotencyKey: 'wait-for-refund', awaitInFlightMs: 5_000, run,
    });
    held.rejectRun(new Error('nothing delivered'));
    expect((await held.settled).error.message).toBe('nothing delivered');
    const result = await retry;
    expect(result.result.answer).toBe('retry worked');
    expect(result.replayed).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await Organization.findById(owner.user.orgId)).aiCredits.used).toBe(3);
  });

  it('stops waiting on client abort without taking a new reservation', async () => {
    const owner = await createTestUser();
    const held = await reserveHeld(owner, 'wait-cancel');
    const signal = new AbortController();
    const run = jest.fn();
    const retry = meterGuavaCredits({
      orgId: owner.user.orgId, userId: owner.user.id, featureKey: 'ask_guava_chat',
      idempotencyKey: 'wait-cancel', awaitInFlightMs: 5_000, signal: signal.signal, run,
    });
    signal.abort();
    try {
      await expect(retry).rejects.toMatchObject({ name: 'AbortError' });
      expect(run).not.toHaveBeenCalled();
    } finally {
      held.resolveRun({ answer: 'original' });
      await held.settled;
    }
    expect(await UsageLedger.countDocuments({})).toBe(1);
    expect((await Organization.findById(owner.user.orgId)).aiCredits.used).toBe(3);
  });

  it('rejects a changed conversation immediately even while the original answer is in flight', async () => {
    const owner = await createTestUser();
    const held = await reserveHeld(owner, 'wait-fingerprint');
    try {
      await expect(meterGuavaCredits({
        orgId: owner.user.orgId, userId: owner.user.id, featureKey: 'ask_guava_chat',
        idempotencyKey: 'wait-fingerprint', metadata: { semanticHash: 'different' },
        awaitInFlightMs: 5_000, run: jest.fn(),
      })).rejects.toMatchObject({
        statusCode: 409, details: { code: 'USAGE_IDEMPOTENCY_FINGERPRINT_CONFLICT' },
      });
    } finally {
      held.resolveRun({ answer: 'original' });
      await held.settled;
    }
  });

  it('keeps provider-consuming daily spend indexable on a seeded ledger', async () => {
    const mongoose = require('mongoose');
    const owner = await createTestUser();
    await UsageLedger.init();
    const orgId = new mongoose.Types.ObjectId(owner.user.orgId);
    await UsageLedger.insertMany(Array.from({ length: 500 }, () => ({
      orgId, userId: new mongoose.Types.ObjectId(), featureKey: 'ask_guava_chat', label: 'Seed answer', credits: 3,
      status: 'refunded', providerConsumedRuns: 1, reservedAt: new Date(),
    })));
    await UsageLedger.create({
      orgId, userId: owner.user.id, featureKey: 'ask_guava_chat', label: 'Seed answer', credits: 3,
      status: 'refunded', providerConsumedRuns: 1, reservedAt: new Date(),
    });
    const aggregate = jest.spyOn(UsageLedger, 'aggregate');
    await meterGuavaCredits({
      orgId, userId: owner.user.id, featureKey: 'ask_guava_chat',
      run: async () => ({ answer: 'indexed' }),
    });
    const pipeline = aggregate.mock.calls[0][0];
    aggregate.mockRestore();
    const explanation = await UsageLedger.aggregate(pipeline).explain('executionStats');
    const stages = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.stage) stages.push(node);
      Object.values(node).forEach((value) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      });
    };
    const cursor = explanation.stages?.find((stage) => stage.$cursor)?.$cursor || explanation;
    walk(cursor.queryPlanner.winningPlan);
    const scan = stages.find((stage) => stage.stage === 'IXSCAN');
    expect(scan?.indexName).toBe('orgId_1_userId_1_status_1_reservedAt_-1');
    expect(stages.some((stage) => stage.stage === 'COLLSCAN')).toBe(false);
    console.log('DAILY SPEND INDEX', JSON.stringify({
      index: scan.indexName, examined: cursor.executionStats.totalDocsExamined,
      keys: cursor.executionStats.totalKeysExamined,
    }));
  });
});
