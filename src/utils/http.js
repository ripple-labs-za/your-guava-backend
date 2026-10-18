const logger = require('./logger');
const axios = require('axios');

/**
 * One outbound HTTP policy for every third-party call the API makes.
 *
 * Each call gets two limits from this table:
 *   connectTimeoutMs  the S3 handler's connectionTimeout. Axios's default follow-redirects transport
 *                     also applies its timeout while waiting for response headers, so axios uses the
 *                     total limit below rather than cutting healthy providers off after five seconds.
 *   totalTimeoutMs    a wall-clock deadline for the whole call, body included. It aborts the request
 *                     through an AbortSignal and settles the caller even when an SDK ignores the signal.
 * A timed-out call rejects with OutboundTimeoutError (504, UPSTREAM_TIMEOUT) and logs one JSON line, so
 * a degraded provider is a named, countable event instead of a hung socket (identity-6, billing-6,
 * workforce-integrations-9, security-14, uploads-catalogue-15). The Anthropic SDK is the one exception:
 * it owns its transport, and ANTHROPIC_TIMEOUT_MS plus BE-05-T03's stream idle timeout bound it.
 */
const OUTBOUND_SERVICES = Object.freeze({
  resend: Object.freeze({ label: 'The email service', totalTimeoutMs: 10_000 }),
  r2: Object.freeze({ label: 'File storage', totalTimeoutMs: 30_000 }),
  yoco: Object.freeze({ label: 'Yoco', totalTimeoutMs: 20_000 }),
  xero: Object.freeze({ label: 'Xero', totalTimeoutMs: 15_000 }),
  quickbooks: Object.freeze({ label: 'QuickBooks', totalTimeoutMs: 15_000 }),
  sage: Object.freeze({ label: 'Sage', totalTimeoutMs: 15_000 }),
  paystack: Object.freeze({ label: 'Paystack', totalTimeoutMs: 20_000 }),
  onegate: Object.freeze({ label: 'OneGate', totalTimeoutMs: 20_000 }),
  weather: Object.freeze({ label: 'The weather service', totalTimeoutMs: 8_000 }),
  eskomsepush: Object.freeze({ label: 'The load-shedding service', totalTimeoutMs: 5_000 }),
});

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_BOUNDS = Object.freeze({ min: 20, max: 30_000 });
const TOTAL_BOUNDS = Object.freeze({ min: 50, max: 120_000 });
const TIMEOUT_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const warnedSettings = new Map();
const boundedMs = (variable, fallback, { min, max }) => {
  const raw = process.env[variable];
  if (raw === undefined) {
    warnedSettings.delete(variable);
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    if (warnedSettings.get(variable) !== raw) {
      // Name the knob and fallback, never echo an arbitrary environment value.
      logger.warn('outbound_timeout_config_invalid', { variable, defaultTimeoutMs: fallback });
      warnedSettings.set(variable, raw);
    }
    return fallback;
  }
  warnedSettings.delete(variable);
  return Math.max(min, Math.min(max, Number(raw)));
};

const outboundPolicy = (service) => {
  if (typeof service !== 'string' || !Object.hasOwn(OUTBOUND_SERVICES, service)) {
    throw new TypeError(`Unknown outbound service: ${String(service)}`);
  }
  const { label, totalTimeoutMs: defaultTotal } = OUTBOUND_SERVICES[service];
  const totalTimeoutMs = boundedMs(
    `OUTBOUND_${service.toUpperCase()}_TIMEOUT_MS`,
    defaultTotal,
    TOTAL_BOUNDS
  );
  const connectTimeoutMs = Math.min(
    boundedMs('OUTBOUND_CONNECT_TIMEOUT_MS', DEFAULT_CONNECT_TIMEOUT_MS, CONNECT_BOUNDS),
    totalTimeoutMs
  );
  return Object.freeze({ service, label, connectTimeoutMs, totalTimeoutMs });
};

// Validate even unused providers when the module loads during server startup.
for (const service of Object.keys(OUTBOUND_SERVICES)) outboundPolicy(service);

class OutboundTimeoutError extends Error {
  constructor(policy, phase = 'total', cause) {
    super(`${policy.label} did not respond in time. Please try again in a minute.`);
    this.name = 'OutboundTimeoutError';
    this.code = 'UPSTREAM_TIMEOUT';
    this.publicCode = 'UPSTREAM_TIMEOUT';
    this.statusCode = 504;
    // A fixed sentence written for the customer, so error.middleware keeps it in production.
    this.exposeMessage = true;
    this.service = policy.service;
    this.phase = phase;
    this.timeoutMs = phase === 'connect' ? policy.connectTimeoutMs : policy.totalTimeoutMs;
    this.details = { code: 'UPSTREAM_TIMEOUT', service: policy.service };
    if (cause) this.cause = cause;
  }
}

const isOutboundTimeout = (error) => error instanceof OutboundTimeoutError;

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

const logTimeout = (error, context = {}) => {
  logger.warn('outbound_timeout', { service: error.service, phase: error.phase, timeoutMs: error.timeoutMs, ...(context.method ? { method: context.method } : {}), ...(context.host ? { host: context.host } : {}) });
};

const asTimeout = (error, policy, controller, timeoutPhase) => {
  if (isOutboundTimeout(error)) return error;
  if (controller.signal.aborted && isOutboundTimeout(controller.signal.reason)) {
    return controller.signal.reason;
  }
  if (TIMEOUT_CODES.has(error?.code) || error?.name === 'TimeoutError') {
    return new OutboundTimeoutError(policy, timeoutPhase, error);
  }
  return null;
};

const withDeadline = async (service, run, { signal: callerSignal, context, timeoutPhase = 'connect' } = {}) => {
  const policy = outboundPolicy(service);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new OutboundTimeoutError(policy, 'total');
      controller.abort(error);
      reject(error);
    }, policy.totalTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;
  try {
    return await Promise.race([Promise.resolve().then(() => run(signal, policy)), deadline]);
  } catch (error) {
    const timeout = asTimeout(error, policy, controller, timeoutPhase);
    if (!timeout) throw error;
    logTimeout(timeout, context);
    throw timeout;
  } finally {
    clearTimeout(timer);
  }
};

const withTimeouts = (policy, config, signal) => ({
  ...config,
  timeout: policy.totalTimeoutMs,
  signal,
});

// axios.get / axios.post rather than an instance, so the existing jest.mock('axios') tests keep working.
const outboundGet = (service, url, config = {}) =>
  withDeadline(service, (signal, policy) => axios.get(url, withTimeouts(policy, config, signal)), {
    signal: config.signal,
    timeoutPhase: 'total',
    context: { method: 'GET', host: hostOf(url) },
  });

const outboundPost = (service, url, data, config = {}) =>
  withDeadline(service, (signal, policy) => axios.post(url, data, withTimeouts(policy, config, signal)), {
    signal: config.signal,
    timeoutPhase: 'total',
    context: { method: 'POST', host: hostOf(url) },
  });

const s3ClientTimeoutConfig = (service = 'r2') => {
  const policy = outboundPolicy(service);
  return {
    requestHandler: {
      connectionTimeout: policy.connectTimeoutMs,
      requestTimeout: policy.totalTimeoutMs,
      // Without this @smithy/node-http-handler only logs a warning when requestTimeout passes.
      throwOnRequestTimeout: true,
    },
    maxAttempts: 2,
  };
};

module.exports = {
  OUTBOUND_SERVICES,
  outboundPolicy,
  withDeadline,
  outboundGet,
  outboundPost,
  OutboundTimeoutError,
  isOutboundTimeout,
  s3ClientTimeoutConfig,
};
