const { EventEmitter } = require('events');
jest.mock('../../src/services/anthropic.service', () => ({
  prepareChatConversation: jest.fn().mockResolvedValue([{ role: 'user', content: 'How are sales?' }]),
  streamBusinessChatResponse: jest.fn(),
}));
jest.mock('../../src/services/usage.service', () => ({ meterGuavaCredits: jest.fn() }));
const ai = require('../../src/services/anthropic.service');
const { meterGuavaCredits } = require('../../src/services/usage.service');
const { streamChatInsights } = require('../../src/controllers/askGuava.controller');

const result = { answer: 'Fine.', contextStats: { transactionCount: 12 } };
let res;
let next;
let finish;
let markDelivered;
const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  jest.useFakeTimers();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  markDelivered = jest.fn();
  ai.streamBusinessChatResponse.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  meterGuavaCredits.mockImplementation(async ({ run }) => ({
    result: await run({ markDelivered }), guavaCredits: { available: 397 }, replayed: false,
  }));
  res = new EventEmitter();
  res.write = jest.fn();
  res.writeHead = jest.fn(() => { res.headersSent = true; });
  res.flushHeaders = jest.fn();
  res.end = jest.fn(() => { res.writableEnded = true; });
  next = jest.fn();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

const start = async () => {
  const pending = streamChatInsights({
    user: { id: 'user', orgId: 'org', activeCafeId: 'cafe' },
    body: { messages: [{ role: 'user', content: 'How are sales?' }] },
    get: () => 'heartbeat-test',
  }, res, next);
  await jest.advanceTimersByTimeAsync(0);
  return { pending };
};

it.each([true, false])('keeps a silent first byte alive every 15 seconds without marking credits delivered (paid=%s)', async (paid) => {
  if (!paid) delete process.env.ANTHROPIC_API_KEY;
  const { pending } = await start();
  expect(res.headersSent).toBe(true);
  await jest.advanceTimersByTimeAsync(14_999);
  expect(res.write).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(35_001);
  expect(res.write.mock.calls).toEqual([[": ping\n\n"], [": ping\n\n"], [": ping\n\n"]]);
  expect(markDelivered).not.toHaveBeenCalled();
  const options = ai.streamBusinessChatResponse.mock.calls[0][0];
  expect(options.signal.aborted).toBe(false);
  options.onDelta('Fine.');
  if (paid) expect(markDelivered).toHaveBeenCalledTimes(1);
  finish(result);
  await pending;
  expect(res.end).toHaveBeenCalledTimes(1);
  const writes = res.write.mock.calls.length;
  await jest.advanceTimersByTimeAsync(60_000);
  expect(res.write).toHaveBeenCalledTimes(writes);
  expect(jest.getTimerCount()).toBe(0);
  expect(next).not.toHaveBeenCalled();
});

it('stops heartbeats as soon as the client disconnects, even while the provider remains pending', async () => {
  const { pending } = await start();
  await jest.advanceTimersByTimeAsync(15_000);
  expect(res.write).toHaveBeenCalledWith(': ping\n\n');
  res.destroyed = true;
  res.emit('close');
  expect(ai.streamBusinessChatResponse.mock.calls[0][0].signal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
  const writes = res.write.mock.calls.length;
  await jest.advanceTimersByTimeAsync(60_000);
  expect(res.write).toHaveBeenCalledTimes(writes);
  finish(result);
  await pending;
  expect(next).not.toHaveBeenCalled();
});

it('clears the heartbeat when the provider fails', async () => {
  ai.streamBusinessChatResponse.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), {
    code: 'AI_PROVIDER_BUSY', wrappedProviderError: true,
  }));
  const { pending } = await start();
  await pending;
  expect(res.write).toHaveBeenCalledWith('event: error\n');
  expect(jest.getTimerCount()).toBe(0);
  const writes = res.write.mock.calls.length;
  await jest.advanceTimersByTimeAsync(60_000);
  expect(res.write).toHaveBeenCalledTimes(writes);
});

it('leaves pre-reservation refusals as HTTP errors with no SSE headers or heartbeat', async () => {
  const error = Object.assign(new Error('No credits'), { code: 'INSUFFICIENT_CREDITS', statusCode: 402 });
  meterGuavaCredits.mockRejectedValueOnce(error);
  const { pending } = await start();
  await pending;
  expect(res.writeHead).not.toHaveBeenCalled();
  expect(res.write).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledWith(error);
  expect(jest.getTimerCount()).toBe(0);
});
