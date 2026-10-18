const { AxiosError } = require('axios');
const {
  outboundPolicy,
  outboundGet,
  outboundPost,
  withDeadline,
  OutboundTimeoutError,
  s3ClientTimeoutConfig,
} = require('../../src/utils/http');

const ENV_KEYS = [
  'OUTBOUND_CONNECT_TIMEOUT_MS',
  'OUTBOUND_YOCO_TIMEOUT_MS',
  'OUTBOUND_R2_TIMEOUT_MS',
  'OUTBOUND_RESEND_TIMEOUT_MS',
];
let savedEnv;
let warnSpy;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] == null) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  warnSpy.mockRestore();
});

// A provider that accepted the connection and went quiet: it settles only when aborted.
const stalledAdapter = (config) => new Promise((_resolve, reject) => {
  config.signal.addEventListener('abort', () => {
    reject(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }));
  }, { once: true });
});

const elapsedMs = (start) => Number(process.hrtime.bigint() - start) / 1e6;

describe('outbound HTTP policy', () => {
  it('gives every named service a connect and a total timeout from one table', () => {
    expect(outboundPolicy('yoco')).toEqual({
      service: 'yoco',
      label: 'Yoco',
      connectTimeoutMs: 5000,
      totalTimeoutMs: 20000,
    });
    expect(outboundPolicy('resend').totalTimeoutMs).toBe(10000);
    expect(outboundPolicy('r2').totalTimeoutMs).toBe(30000);
    for (const service of ['xero', 'quickbooks', 'sage']) {
      expect(outboundPolicy(service).totalTimeoutMs).toBe(15000);
    }
  });

  it('refuses a service the table does not name, including prototype keys', () => {
    expect(() => outboundPolicy('toString')).toThrow(/Unknown outbound service/);
    expect(() => outboundPolicy('__proto__')).toThrow(/Unknown outbound service/);
  });

  it('bounds environment overrides so a typo cannot disable the deadline', () => {
    process.env.OUTBOUND_YOCO_TIMEOUT_MS = '0';
    expect(outboundPolicy('yoco').totalTimeoutMs).toBe(50);
    process.env.OUTBOUND_YOCO_TIMEOUT_MS = '99999999';
    expect(outboundPolicy('yoco').totalTimeoutMs).toBe(120000);
    process.env.OUTBOUND_YOCO_TIMEOUT_MS = 'soon';
    expect(outboundPolicy('yoco').totalTimeoutMs).toBe(20000);
    process.env.OUTBOUND_YOCO_TIMEOUT_MS = '100';
    expect(outboundPolicy('yoco').connectTimeoutMs).toBe(100);
  });

  it('passes the connect timeout and an abort signal to axios', async () => {
    const adapter = jest.fn(async (config) => ({
      data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config,
    }));
    await outboundGet('yoco', 'https://yoco.invalid/v1/orders/', { adapter, params: { limit: 50 } });
    const [config] = adapter.mock.calls[0];
    expect(config.timeout).toBe(5000);
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(config.params).toEqual({ limit: 50 });
  });

  it('fails a stalled call at the total deadline with a named, logged error', async () => {
    process.env.OUTBOUND_YOCO_TIMEOUT_MS = '100';
    const start = process.hrtime.bigint();

    const error = await outboundPost(
      'yoco',
      'https://yoco.invalid/oauth2/token?client_secret=never-logged',
      'grant_type=refresh_token',
      { adapter: stalledAdapter }
    ).catch((caught) => caught);

    const took = elapsedMs(start);
    expect(error).toBeInstanceOf(OutboundTimeoutError);
    expect(error).toMatchObject({
      name: 'OutboundTimeoutError',
      code: 'UPSTREAM_TIMEOUT',
      publicCode: 'UPSTREAM_TIMEOUT',
      statusCode: 504,
      service: 'yoco',
      phase: 'total',
      timeoutMs: 100,
    });
    expect(took).toBeGreaterThanOrEqual(90);
    expect(took).toBeLessThan(1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0][0])).toEqual({
      level: 'warn',
      event: 'outbound_timeout',
      service: 'yoco',
      phase: 'total',
      timeoutMs: 100,
      method: 'POST',
      host: 'yoco.invalid',
    });
    expect(warnSpy.mock.calls[0][0]).not.toContain('never-logged');
  });

  it('maps an axios socket timeout to the same named error', async () => {
    const adapter = (config) =>
      Promise.reject(new AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED', config));
    await expect(outboundGet('xero', 'https://api.xero.invalid/connections', { adapter }))
      .rejects.toMatchObject({ name: 'OutboundTimeoutError', service: 'xero', phase: 'connect', timeoutMs: 5000 });
  });

  it('passes every other failure through untouched', async () => {
    const adapter = (config) => Promise.reject(new AxiosError(
      'Request failed with status code 400', 'ERR_BAD_REQUEST', config, null,
      { status: 400, data: { error: 'invalid_grant' }, headers: {}, config }
    ));
    const error = await outboundPost('xero', 'https://identity.xero.invalid/connect/token', 'x', { adapter })
      .catch((caught) => caught);
    expect(error).not.toBeInstanceOf(OutboundTimeoutError);
    expect(error.response.status).toBe(400);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('settles at the deadline even when the work ignores the abort signal', async () => {
    process.env.OUTBOUND_RESEND_TIMEOUT_MS = '100';
    const start = process.hrtime.bigint();
    await expect(withDeadline('resend', () => new Promise(() => {})))
      .rejects.toMatchObject({ name: 'OutboundTimeoutError', service: 'resend', statusCode: 504 });
    expect(elapsedMs(start)).toBeLessThan(1000);
  });

  it('builds S3 client options from the same table', () => {
    process.env.OUTBOUND_R2_TIMEOUT_MS = '30000';
    expect(s3ClientTimeoutConfig('r2')).toEqual({
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, throwOnRequestTimeout: true },
      maxAttempts: 2,
    });
  });

  it('clears the deadline timer after success and after an ordinary rejection', async () => {
    const clear = jest.spyOn(global, 'clearTimeout');
    try {
      await expect(withDeadline('yoco', async () => 'ok')).resolves.toBe('ok');
      expect(clear).toHaveBeenCalledTimes(1);
      const failure = new Error('provider refused');
      await expect(withDeadline('yoco', async () => { throw failure; })).rejects.toBe(failure);
      expect(clear).toHaveBeenCalledTimes(2);
    } finally {
      clear.mockRestore();
    }
  });

  it('preserves caller cancellation without logging it as a provider timeout', async () => {
    const caller = new AbortController();
    const request = outboundGet('yoco', 'https://yoco.invalid/orders', {
      signal: caller.signal,
      adapter: stalledAdapter,
    });
    // Let the adapter attach its abort listener before cancelling.
    await new Promise((resolve) => setImmediate(resolve));
    caller.abort();
    await expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(['-1', 'NaN', '1e9'])('keeps a malformed total override %s bounded', (raw) => {
    process.env.OUTBOUND_YOCO_TIMEOUT_MS = raw;
    const policy = outboundPolicy('yoco');
    expect(policy.totalTimeoutMs).toBeGreaterThanOrEqual(50);
    expect(policy.totalTimeoutMs).toBeLessThanOrEqual(120000);
    expect(policy.connectTimeoutMs).toBeLessThanOrEqual(policy.totalTimeoutMs);
  });
});
