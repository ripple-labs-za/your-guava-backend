const logger = require('../../src/utils/logger');
const mockS3Send = jest.fn();
const mockS3Config = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((config) => {
    mockS3Config(config);
    return { send: (...args) => mockS3Send(...args) };
  }),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://signed.r2.invalid/object'),
}));
const mockResendSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args) => mockResendSend(...args) },
  })),
}));
jest.mock('axios');

const { PassThrough } = require('stream');
const axios = require('axios');
const email = require('../../src/services/email.service');
const r2 = require('../../src/services/r2.service');
const xero = require('../../src/services/integrations/xero.service');
const quickbooks = require('../../src/services/integrations/quickbooks.service');
const sage = require('../../src/services/integrations/sage.service');
const yoco = require('../../src/services/yoco.service');

const PENDING = Symbol('pending');
// Reports PENDING instead of hanging when a client never settles: that is the defect under test.
const settleWithin = (promise, ms) => Promise.race([
  promise.then((value) => ({ value }), (error) => ({ error })),
  new Promise((resolve) => { setTimeout(() => resolve(PENDING), ms).unref(); }),
]);
// A stalled provider that honours the abort signal it was given. No signal: it stays pending.
const stallUntilAborted = (signal) => new Promise((_resolve, reject) => {
  if (!signal) return;
  signal.addEventListener('abort', () => {
    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  }, { once: true });
});
const elapsedMs = (start) => Number(process.hrtime.bigint() - start) / 1e6;

const TEST_ENV = {
  OUTBOUND_RESEND_TIMEOUT_MS: '100',
  OUTBOUND_R2_TIMEOUT_MS: '100',
  OUTBOUND_XERO_TIMEOUT_MS: '100',
  OUTBOUND_QUICKBOOKS_TIMEOUT_MS: '100',
  OUTBOUND_SAGE_TIMEOUT_MS: '100',
  OUTBOUND_YOCO_TIMEOUT_MS: '100',
  RESEND_API_KEY: 're_test_not_a_key',
  RESEND_FROM_EMAIL: 'Your Guava <hello@yourguava.invalid>',
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-access',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
  XERO_CLIENT_ID: 'x-id', XERO_CLIENT_SECRET: 'x-secret', XERO_REDIRECT_URI: 'http://localhost:5185/cb',
  QUICKBOOKS_CLIENT_ID: 'q-id', QUICKBOOKS_CLIENT_SECRET: 'q-secret', QUICKBOOKS_REDIRECT_URI: 'http://localhost:5185/cb',
  SAGE_CLIENT_ID: 's-id', SAGE_CLIENT_SECRET: 's-secret', SAGE_REDIRECT_URI: 'http://localhost:5185/cb',
  YOCO_API_URL: 'https://api.yoco.invalid',
  YOCO_IAM_URL: 'https://iam.yoco.invalid',
};

let savedEnv;
let consoleSpies;

beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, TEST_ENV);
  delete process.env.YOCO_SYNC_MAX_PAGES;
  mockS3Send.mockReset();
  mockS3Config.mockClear();
  mockResendSend.mockReset();
  axios.get.mockReset();
  axios.post.mockReset();
  email._resetClient();
  r2._resetClient();
  consoleSpies = ['warn', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
});

afterEach(() => {
  process.env = savedEnv;
  consoleSpies.forEach((spy) => spy.mockRestore());
});

describe('a stalled provider fails in bounded time with a named error', () => {
  it('Resend: a stalled send resolves { sent: false, timedOut: true } and passes a signal to the SDK', async () => {
    mockResendSend.mockImplementation((_payload, options) => stallUntilAborted(options?.signal));
    const start = process.hrtime.bigint();
    const outcome = await settleWithin(
      email.sendEmail({ to: 'owner@yourguava.invalid', subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' }),
      2000
    );
    expect(outcome).not.toBe(PENDING);
    expect(outcome.value).toMatchObject({
      sent: false,
      timedOut: true,
      error: { name: 'OutboundTimeoutError', service: 'resend' },
    });
    expect(elapsedMs(start)).toBeLessThan(1000);
    expect(mockResendSend.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('R2: a stalled upload rejects with the named error, and the client carries handler timeouts', async () => {
    mockS3Send.mockImplementation((_command, options) => stallUntilAborted(options?.abortSignal));
    const outcome = await settleWithin(
      r2.uploadFile(Buffer.from('a,b\n1,2\n'), 'uploads/cafe/file.csv', 'text/csv'),
      2000
    );
    expect(outcome).not.toBe(PENDING);
    expect(outcome.error).toMatchObject({ name: 'OutboundTimeoutError', service: 'r2', statusCode: 504 });
    expect(mockS3Config).toHaveBeenCalledWith(expect.objectContaining({
      requestHandler: { connectionTimeout: 100, requestTimeout: 100, throwOnRequestTimeout: true },
      maxAttempts: 2,
    }));
  });

  it('R2: a download whose body stops arriving fails at the deadline and the stream is destroyed', async () => {
    const body = new PassThrough();
    mockS3Send.mockResolvedValue({ ContentLength: 10, Body: body });
    const outcome = await settleWithin(r2.downloadFile('uploads/cafe/file.csv'), 2000);
    expect(outcome).not.toBe(PENDING);
    expect(outcome.error).toMatchObject({ name: 'OutboundTimeoutError', service: 'r2' });
    expect(body.destroyed).toBe(true);
  });

  it('R2: a stalled delete rejects with the named error', async () => {
    mockS3Send.mockImplementation((_command, options) => stallUntilAborted(options?.abortSignal));
    const outcome = await settleWithin(r2.deleteFile('uploads/cafe/file.csv'), 2000);
    expect(outcome).not.toBe(PENDING);
    expect(outcome.error).toMatchObject({ name: 'OutboundTimeoutError', service: 'r2' });
  });

  it.each([
    ['xero', xero],
    ['quickbooks', quickbooks],
    ['sage', sage],
  ])('%s: a stalled token exchange and a stalled refresh both reject with the named error', async (service, client) => {
    axios.post.mockImplementation((_url, _body, config) => stallUntilAborted(config?.signal));
    const exchange = await settleWithin(client.exchangeCodeForTokens('code-1', {}), 2000);
    const refresh = await settleWithin(client.refreshAccessToken('refresh-1'), 2000);
    expect(exchange).not.toBe(PENDING);
    expect(refresh).not.toBe(PENDING);
    expect(exchange.error).toMatchObject({ name: 'OutboundTimeoutError', service });
    expect(refresh.error).toMatchObject({ name: 'OutboundTimeoutError', service });
  });

  it('Xero: a stalled connections lookup rejects instead of returning a token without its tenant', async () => {
    axios.post.mockResolvedValue({ data: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 } });
    axios.get.mockImplementation((_url, config) => stallUntilAborted(config?.signal));
    const start = process.hrtime.bigint();
    const outcome = await settleWithin(xero.exchangeCodeForTokens('code-1', {}), 2000);
    expect(outcome).not.toBe(PENDING);
    expect(outcome.error).toMatchObject({ name: 'OutboundTimeoutError', service: 'xero', statusCode: 504 });
    expect(elapsedMs(start)).toBeLessThan(1000);
  });

  it('Yoco: stalled token and orders calls reject with the named error', async () => {
    axios.post.mockImplementation((_url, _body, config) => stallUntilAborted(config?.signal));
    axios.get.mockImplementation((_url, config) => stallUntilAborted(config?.signal));
    const outcomes = await Promise.all([
      settleWithin(yoco.exchangeCode('code-1'), 2000),
      settleWithin(yoco.refreshAccessToken('refresh-1'), 2000),
      settleWithin(yoco.fetchOrders('access-1', {}), 2000),
      settleWithin(yoco.subscribeWebhook('access-1', 'https://api.yourguava.invalid/api/yoco/webhook'), 2000),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).not.toBe(PENDING);
      expect(outcome.error).toMatchObject({ name: 'OutboundTimeoutError', service: 'yoco' });
    }
  });
});

describe('Yoco pagination is capped', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-02-01T00:00:00Z');
  // Pages resolve on a macrotask so a runaway loop cannot starve the timers, and give up after 1,000
  // pages so today's uncapped loop ends (red) instead of hanging the suite.
  const mockPages = (cursorFor) => {
    let calls = 0;
    axios.get.mockImplementation(() => {
      calls += 1;
      if (calls > 1000) return Promise.reject(new Error('runaway pagination: 1000 pages'));
      const page = { data: { data: [{ id: `order-${calls}` }], next_cursor: cursorFor(calls) } };
      return new Promise((resolve) => setImmediate(() => resolve(page)));
    });
  };

  it('stops at YOCO_SYNC_MAX_PAGES and reports the truncation', async () => {
    process.env.YOCO_SYNC_MAX_PAGES = '5';
    mockPages((n) => `cursor-${n}`);
    const result = await yoco.fetchAllOrders('access-1', start, end);
    expect(axios.get).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ pages: 5, truncated: 'page_limit' });
    expect(result.orders).toHaveLength(5);
  });

  it('defaults to 200 pages', async () => {
    mockPages((n) => `cursor-${n}`);
    const result = await yoco.fetchAllOrders('access-1', start, end);
    expect(axios.get).toHaveBeenCalledTimes(200);
    expect(result.truncated).toBe('page_limit');
  });

  it('stops when the provider repeats a cursor', async () => {
    mockPages(() => 'same-cursor');
    const result = await yoco.fetchAllOrders('access-1', start, end);
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ pages: 2, truncated: 'cursor_repeated' });
  });

  it('returns every page and no truncation when the provider ends the cursor', async () => {
    mockPages((n) => (n < 3 ? `cursor-${n}` : null));
    const result = await yoco.fetchAllOrders('access-1', start, end);
    expect(result).toMatchObject({ pages: 3, truncated: null });
    expect(result.orders.map((order) => order.id)).toEqual(['order-1', 'order-2', 'order-3']);
  });
});
