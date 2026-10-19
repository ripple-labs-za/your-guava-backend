const mockAnthropicMessageCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

const http = require('http');
const supertest = require('supertest');
const {
  setup,
  teardown,
  clearDB,
  createTestUser,
  app,
} = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const Organization = require('../../src/models/Organization.model');
const InsightChat = require('../../src/models/InsightChat.model');
const { _resetInsightsCache } = require('../../src/services/anthropic.service');

const request = supertest(app);
let server;
const closedResponses = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (probe, attempts = 500) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await sleep(10);
  }
  throw new Error('Timed out waiting for the expected state');
};

const gate = () => {
  const held = { reached: false };
  held.promise = new Promise((resolve) => { held.open = resolve; });
  return held;
};

const abortableWait = (held, signal) => new Promise((resolve, reject) => {
  const onAbort = () => {
    const error = new Error('Request was aborted.');
    error.name = 'APIUserAbortError';
    reject(error);
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
    held.promise.then(resolve);
  }
});

const messageStart = {
  type: 'message_start',
  message: { id: 'msg_charge', model: 'test-model', usage: { input_tokens: 900 } },
};
const textDelta = (text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const messageEnd = [
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
];

// Each step is an event to yield, { wait: gate() } to hold until the test opens it, or { fail: error } to break the stream.
const scriptedStream = (steps) => (_request, options = {}) => Promise.resolve({
  async *[Symbol.asyncIterator]() {
    for (const step of steps) {
      if (step.wait) {
        step.wait.reached = true;
        await abortableWait(step.wait, options.signal);
      } else if (step.fail) {
        throw step.fail;
      } else {
        yield step;
      }
    }
  },
});

const seedSales = (cafeId) => Transaction.create({
  cafeId,
  receiptId: 'charging-seed',
  date: new Date(Date.now() - 3_600_000),
  status: 'approved',
  total: 45,
  items: [{ name: 'Flat White', quantity: 1, unitPrice: 45 }],
});

const openStream = ({ token, idempotencyKey, messages, chatId }) => new Promise((resolve, reject) => {
  const { port } = server.address();
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/api/forecasts/insights/chat/stream',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
    },
  }, (res) => {
    let text = '';
    const checks = new Set();
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      text += chunk;
      checks.forEach((check) => check());
    });
    res.on('error', () => {});
    resolve({
      req,
      until: (pattern) => new Promise((done) => {
        const check = () => {
          if (pattern.test(text)) {
            checks.delete(check);
            done(text);
          }
        };
        checks.add(check);
        check();
      }),
    });
  });
  req.on('error', reject);
  req.end(JSON.stringify({ messages, chatId }));
});

const eventData = (text, name) => {
  const match = text.match(new RegExp(`event: ${name}\\ndata: (.*)\\n`));
  return match ? JSON.parse(match[1]) : null;
};

const settledRow = (idempotencyKey) => waitFor(async () => {
  const row = await UsageLedger.findOne({ idempotencyKey }).lean();
  return row && !['reserved', 'recovering'].includes(row.status) ? row : null;
});

const QUESTION = [{ role: 'user', content: 'Which day is best?' }];

beforeAll(async () => {
  await setup();
  server = app.listen(0);
  server.on('request', (req, res) => {
    res.once('close', () => {
      const key = req.headers['idempotency-key'];
      if (key) closedResponses.add(key);
    });
  });
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await teardown();
});
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  closedResponses.clear();
  await _resetInsightsCache();
  delete process.env.ANTHROPIC_API_KEY;
  await clearDB();
});

describe('Ask Guava streaming charges (D-015)', () => {
  it('charges a client that disconnects after the first delta and stores the complete answer', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await seedSales(owner.user.activeCafeId);
    const chat = await InsightChat.create({
      cafeId: owner.user.activeCafeId, orgId: owner.user.orgId, userId: owner.user.id,
    });
    const hold = gate();
    mockAnthropicMessageCreate.mockImplementation(scriptedStream([
      messageStart, textDelta('Saturdays are '), { wait: hold }, textDelta('your strongest day.'), ...messageEnd,
    ]));

    const stream = await openStream({ token: owner.token, idempotencyKey: 'drop-after-delta', messages: QUESTION, chatId: chat.id });
    await stream.until(/Saturdays are/);
    stream.req.destroy();
    await waitFor(() => closedResponses.has('drop-after-delta'));
    hold.open();

    const row = await settledRow('drop-after-delta');
    expect(row.status).toBe('committed');
    expect(row.resultPayload.answer).toBe('Saturdays are your strongest day.');
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(3);
    const saved = await waitFor(async () => {
      const row = await InsightChat.findById(chat.id).lean();
      return row.messages.length === 2 ? row : null;
    });
    expect(saved.messages[1].content).toBe('Saturdays are your strongest day.');
  });

  it('refunds a client that disconnects before any delta and records the provider usage', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await seedSales(owner.user.activeCafeId);
    const hold = gate();
    mockAnthropicMessageCreate.mockImplementation(scriptedStream([
      messageStart, { wait: hold }, textDelta('Too late.'), ...messageEnd,
    ]));

    const stream = await openStream({ token: owner.token, idempotencyKey: 'drop-before-delta', messages: QUESTION });
    await waitFor(() => hold.reached);
    stream.req.destroy();

    const row = await settledRow('drop-before-delta');
    expect(row.status).toBe('refunded');
    expect(row.providerConsumedRuns).toBe(1);
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(0);
  });

  it('makes a same-key retry wait for the drained answer instead of failing with 409', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await seedSales(owner.user.activeCafeId);
    const hold = gate();
    mockAnthropicMessageCreate.mockImplementation(scriptedStream([
      messageStart, textDelta('Mornings '), { wait: hold }, textDelta('are busiest.'), ...messageEnd,
    ]));

    const stream = await openStream({ token: owner.token, idempotencyKey: 'retry-while-draining', messages: QUESTION });
    await stream.until(/Mornings/);
    stream.req.destroy();
    await waitFor(() => closedResponses.has('retry-while-draining'));

    const retry = request
      .post('/api/forecasts/insights/chat')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'retry-while-draining')
      .send({ messages: QUESTION })
      .then((response) => response);
    // Long enough for today's code to have answered 409 while the first run still holds its reservation.
    await sleep(1_000);
    hold.open();

    const response = await retry;
    expect(response.status).toBe(200);
    expect(response.body.answer).toBe('Mornings are busiest.');
    expect(response.body.meta.replayed).toBe(true);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(3);
  });

  it('charges a partial answer the provider broke off and says so in the error event', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await seedSales(owner.user.activeCafeId);
    const chat = await InsightChat.create({
      cafeId: owner.user.activeCafeId, orgId: owner.user.orgId, userId: owner.user.id,
    });
    const providerBreak = Object.assign(
      new Error('SSE Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      { name: 'APIConnectionError' }
    );
    mockAnthropicMessageCreate.mockImplementation(scriptedStream([
      messageStart, textDelta('Stock more '), { fail: providerBreak },
    ]));

    const stream = await openStream({ token: owner.token, idempotencyKey: 'provider-broke', messages: QUESTION, chatId: chat.id });
    const text = await stream.until(/event: error\ndata: .*\n/);

    expect(eventData(text, 'error')).toEqual(expect.objectContaining({
      code: 'AI_STREAM_INTERRUPTED',
      charged: true,
      credits: 3,
    }));
    const row = await settledRow('provider-broke');
    expect(row.status).toBe('committed');
    expect(row.recoveryReason).toBe('delivered_then_interrupted');
    expect(row.resultPayload.interrupted).toBe(true);
    expect(row.resultPayload.answer.startsWith('Stock more ')).toBe(true);
    expect(row.resultPayload.answer).toMatch(/stopped this answer part-way/);
    const saved = await InsightChat.findById(chat.id).lean();
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1].content).toBe(row.resultPayload.answer);

    // A provider failure can arrive while a stopped answer is draining too.
    const stoppedChat = await InsightChat.create({
      cafeId: owner.user.activeCafeId, orgId: owner.user.orgId, userId: owner.user.id,
    });
    const hold = gate();
    mockAnthropicMessageCreate.mockImplementation(scriptedStream([
      messageStart, textDelta('Stock more '), { wait: hold }, { fail: providerBreak },
    ]));
    const stopped = await openStream({
      token: owner.token, idempotencyKey: 'stopped-provider-broke', messages: QUESTION, chatId: stoppedChat.id,
    });
    await stopped.until(/Stock more/);
    stopped.req.destroy();
    await waitFor(() => closedResponses.has('stopped-provider-broke'));
    hold.open();
    const stoppedRow = await settledRow('stopped-provider-broke');
    expect(stoppedRow.status).toBe('committed');
    const savedStopped = await waitFor(async () => {
      const candidate = await InsightChat.findById(stoppedChat.id).lean();
      return candidate.messages.length === 2 ? candidate : null;
    });
    expect(savedStopped.messages[1].content).toBe(stoppedRow.resultPayload.answer);
  });
  it('refunds a whitespace-only answer without marking visible delivery', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    mockAnthropicMessageCreate.mockImplementation(scriptedStream([messageStart, textDelta('  '), ...messageEnd]));
    const stream = await openStream({ token: owner.token, idempotencyKey: 'whitespace-only', messages: QUESTION });
    const text = await stream.until(/event: error\ndata: .*\n/);
    expect(eventData(text, 'error').charged).toBe(false);
    const row = await settledRow('whitespace-only');
    expect(row.status).toBe('refunded');
    expect((await Organization.findById(owner.user.orgId)).aiCredits.used).toBe(0);
  });

  it('reports an unknown charge when a delivered answer cannot be committed', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    const originalUpdate = UsageLedger.findOneAndUpdate.bind(UsageLedger);
    const commitFailure = jest.spyOn(UsageLedger, 'findOneAndUpdate').mockImplementation((filter, update, ...options) => {
      if (update?.$set?.status === 'committed') return Promise.reject(new Error('ledger write unavailable'));
      return originalUpdate(filter, update, ...options);
    });
    mockAnthropicMessageCreate.mockImplementation(scriptedStream([
      messageStart, textDelta('Visible answer'), { fail: new Error('provider disconnected') },
    ]));
    try {
      const stream = await openStream({ token: owner.token, idempotencyKey: 'unknown-charge', messages: QUESTION });
      const text = await stream.until(/event: error\ndata: .*\n/);
      expect(eventData(text, 'error')).toEqual(expect.objectContaining({ charged: null }));
      expect(eventData(text, 'error').message).toMatch(/charge could not be confirmed/i);
      expect(eventData(text, 'error').message).not.toMatch(/nothing was charged/i);
    } finally {
      commitFailure.mockRestore();
    }
  });

});
