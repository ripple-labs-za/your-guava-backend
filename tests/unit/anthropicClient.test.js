const {
  getAnthropicClientOptions,
  asUpstreamAiError,
  withAnthropicErrors,
  readStreamEvents,
  resolveSdkConstructor,
  responseText,
} = require('../../src/services/anthropicClient.service');

describe('Anthropic client bounds', () => {
  const originalTimeout = process.env.ANTHROPIC_TIMEOUT_MS;
  const originalRetries = process.env.ANTHROPIC_MAX_RETRIES;

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.ANTHROPIC_TIMEOUT_MS;
    else process.env.ANTHROPIC_TIMEOUT_MS = originalTimeout;
    if (originalRetries === undefined) delete process.env.ANTHROPIC_MAX_RETRIES;
    else process.env.ANTHROPIC_MAX_RETRIES = originalRetries;
  });

  it('uses bounded production defaults', () => {
    delete process.env.ANTHROPIC_TIMEOUT_MS;
    delete process.env.ANTHROPIC_MAX_RETRIES;
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 30_000, maxRetries: 1 })
    );
  });

  it('clamps unsafe timeout and retry values', () => {
    process.env.ANTHROPIC_TIMEOUT_MS = '999999';
    process.env.ANTHROPIC_MAX_RETRIES = '99';
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 60_000, maxRetries: 2 })
    );

    process.env.ANTHROPIC_TIMEOUT_MS = '1';
    process.env.ANTHROPIC_MAX_RETRIES = '-5';
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 5_000, maxRetries: 0 })
    );
  });
});

describe('Anthropic upstream error wrapping', () => {
  const rawBody = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
  // Shape of an @anthropic-ai/sdk APIError: `message` embeds the raw response
  // body, `error` is the parsed body with the API error nested under `.error`.
  const sdkAuthError = () => Object.assign(new Error(`401 ${rawBody}`), {
    name: 'AuthenticationError',
    status: 401,
    error: JSON.parse(rawBody),
  });
  let logSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the SDK error as cause and summarises it without the raw response body', () => {
    const cause = sdkAuthError();

    const wrapped = asUpstreamAiError(cause);

    expect(wrapped.statusCode).toBe(502);
    expect(wrapped.message).toMatch(/not accepting our credentials/);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.upstreamStatus).toBe(401);
    expect(wrapped.upstreamMessage).toBe('authentication_error: invalid x-api-key');
    expect(wrapped.upstreamMessage).not.toContain('{');
    // Marks the message as written for the client. error.middleware.js does not
    // read this yet, so in production the owner still sees "Internal Server
    // Error"; the flag is the contract that fix needs to honour.
    expect(wrapped.exposeMessage).toBe(true);
  });

  it('never copies a non-JSON response body into the summary', () => {
    const htmlError = Object.assign(new Error('502 <html>Bad gateway</html>'), {
      name: 'APIError',
      status: 502,
    });

    const wrapped = asUpstreamAiError(htmlError);

    expect(wrapped.upstreamStatus).toBe(502);
    expect(wrapped.upstreamMessage).toBe('APIError');
  });

  it('keeps SDK-generated connection messages and truncates long provider messages', () => {
    const connection = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
    expect(asUpstreamAiError(connection)).toEqual(expect.objectContaining({
      upstreamStatus: null,
      upstreamMessage: 'APIConnectionError: Connection error.',
    }));

    const overloaded = Object.assign(new Error('529 ...'), {
      status: 529,
      error: { type: 'error', error: { type: 'overloaded_error', message: 'y'.repeat(1_000) } },
    });
    const summary = asUpstreamAiError(overloaded).upstreamMessage;
    expect(summary.startsWith('overloaded_error: yyy')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('logs the failed operation with upstream status and type', async () => {
    await expect(
      withAnthropicErrors(async () => { throw sdkAuthError(); }, 'proposeColumnMapping')
    ).rejects.toMatchObject({ statusCode: 502, upstreamStatus: 401 });

    expect(logSpy).toHaveBeenCalledWith(
      '[anthropic] proposeColumnMapping failed: status=401 type=authentication_error'
    );
  });

  it('rethrows client aborts untouched and unlogged', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

    await expect(withAnthropicErrors(async () => { throw abort; })).rejects.toBe(abort);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('provider error classification', () => {
  it('reads a real SDK stream error cause without keeping the raw JSON body', () => {
    const { APIError } = require('@anthropic-ai/sdk');
    const raw = JSON.stringify({ type: 'overloaded_error', message: 'Overloaded' });
    const sdkError = APIError.generate(undefined, `SSE Error: ${raw}`, raw, {});
    expect(asUpstreamAiError(sdkError).upstreamMessage).toBe('overloaded_error: Overloaded');
    const unparseable = APIError.generate(undefined, undefined, 'raw provider payload', undefined);
    unparseable.cause = new Error('private raw body');
    expect(asUpstreamAiError(unparseable).upstreamMessage).not.toMatch(/raw|private|payload/);
  });
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); });

  const providerError = (status, type, extra = {}) => Object.assign(new Error(`${status} {"type":"error"}`), {
    status,
    error: { type: 'error', error: { type, message: `${type} happened` } },
    headers: { 'request-id': `req_${status}` },
    ...extra,
  });

  it.each([
    [400, 'invalid_request_error', 502, 'AI_PROVIDER_REJECTED', false],
    [401, 'authentication_error', 502, 'AI_PROVIDER_AUTH_FAILED', false],
    [403, 'permission_error', 502, 'AI_PROVIDER_AUTH_FAILED', false],
    [404, 'not_found_error', 502, 'AI_PROVIDER_REJECTED', false],
    [413, 'request_too_large', 502, 'AI_PROVIDER_REJECTED', false],
    [429, 'rate_limit_error', 503, 'AI_PROVIDER_BUSY', true],
    [500, 'api_error', 503, 'AI_PROVIDER_UNAVAILABLE', true],
    [529, 'overloaded_error', 503, 'AI_PROVIDER_UNAVAILABLE', true],
  ])('maps a provider %i %s to %i %s', (status, type, statusCode, code, retryable) => {
    const wrapped = asUpstreamAiError(providerError(status, type));
    expect(wrapped).toMatchObject({
      statusCode, code, exposeMessage: true, exposeDetails: true, upstreamStatus: status, providerRequestId: `req_${status}`,
    });
    expect(wrapped.details).toEqual(expect.objectContaining({ code, retryable }));
  });

  it('maps a connection timeout to a 504 the client may retry', () => {
    const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    expect(asUpstreamAiError(timeout)).toMatchObject({
      statusCode: 504, code: 'AI_PROVIDER_TIMEOUT', details: { code: 'AI_PROVIDER_TIMEOUT', retryable: true },
    });
  });

  it('passes the provider Retry-After through for a 429, bounded to two minutes', () => {
    expect(asUpstreamAiError(providerError(429, 'rate_limit_error', {
      headers: { 'retry-after': '30', 'request-id': 'req_429' },
    })).details.retryAfterSeconds).toBe(30);
    expect(asUpstreamAiError(providerError(429, 'rate_limit_error', {
      headers: { 'retry-after': '99999' },
    })).details.retryAfterSeconds).toBe(120);
  });

  it('reads the error type and request id from the newer SDK shapes as well', () => {
    const newer = Object.assign(new Error('529 Overloaded'), {
      status: 529,
      requestID: 'req_new',
      headers: new Headers({ 'request-id': 'req_new' }),
      error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    expect(asUpstreamAiError(newer)).toMatchObject({ statusCode: 503, providerRequestId: 'req_new' });
    const sseError = Object.assign(
      new Error('SSE Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      { name: 'APIConnectionError' }
    );
    expect(asUpstreamAiError(sseError).upstreamMessage).toBe('overloaded_error: Overloaded');
  });

  it('logs the local request id and the provider request id when it has them', async () => {
    await expect(withAnthropicErrors(
      async () => { throw providerError(401, 'authentication_error'); },
      'streamBusinessChatResponse',
      { requestId: 'req-local-0001' }
    )).rejects.toMatchObject({ code: 'AI_PROVIDER_AUTH_FAILED' });
    expect(logSpy).toHaveBeenCalledWith(
      '[anthropic] streamBusinessChatResponse failed: status=401 type=authentication_error requestId=req-local-0001 providerRequestId=req_401'
    );
  });

  it('recognises the real SDK abort class, which carries no name', async () => {
    const { APIUserAbortError } = require('@anthropic-ai/sdk');
    const abort = new APIUserAbortError();
    await expect(withAnthropicErrors(async () => { throw abort; })).rejects.toBe(abort);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('stream deadlines', () => {
  const quietAfter = (events) => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
      await new Promise(() => {});
    },
  });
  const trickle = (everyMs) => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, everyMs));
        yield { type: 'ping' };
      }
    },
  });
  const drain = async (stream, options) => {
    const seen = [];
    for await (const event of readStreamEvents(stream, options)) seen.push(event.type);
    return seen;
  };

  it('aborts a stream that goes quiet for longer than the idle limit', async () => {
    const timeouts = [];
    const started = process.hrtime.bigint();
    await expect(drain(quietAfter([{ type: 'message_start' }]), {
      idleMs: 200, maxDurationMs: 5_000, onTimeout: (error) => timeouts.push(error),
    })).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', phase: 'idle' });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(timeouts).toHaveLength(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(190);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('aborts a stream that keeps trickling past its overall deadline', async () => {
    const started = process.hrtime.bigint();
    await expect(drain(trickle(50), { idleMs: 1_000, maxDurationMs: 300, onTimeout: () => {} }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', phase: 'deadline' });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2_000);
  });

  it('passes a healthy stream through untouched', async () => {
    const onTimeout = jest.fn();
    const healthy = { async *[Symbol.asyncIterator]() { yield { type: 'a' }; yield { type: 'b' }; } };
    expect(await drain(healthy, { idleMs: 1_000, maxDurationMs: 5_000, onTimeout })).toEqual(['a', 'b']);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('SDK shape helpers', () => {
  it('finds the SDK constructor however the SDK exports it', () => {
    function Client() {}
    expect(resolveSdkConstructor(Client)).toBe(Client);
    expect(resolveSdkConstructor({ default: Client })).toBe(Client);
    expect(resolveSdkConstructor({ Anthropic: Client })).toBe(Client);
  });

  it('reads the answer from the text blocks, skipping a leading non-text block', () => {
    expect(responseText({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'noop', input: {} },
        { type: 'text', text: '{"a":1}' },
      ],
    })).toBe('{"a":1}');
  });
});
