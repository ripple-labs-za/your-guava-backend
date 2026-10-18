const AnthropicSdk = require('@anthropic-ai/sdk');

const clampInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const getAnthropicClientOptions = () => ({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: clampInteger(process.env.ANTHROPIC_TIMEOUT_MS, 30_000, 5_000, 60_000),
  maxRetries: clampInteger(process.env.ANTHROPIC_MAX_RETRIES, 1, 0, 2),
});

/**
 * The SDK constructor however the installed version exports it. 0.30 exports the class as module.exports with
 * `.Anthropic` and `.default` pointing back at it; later versions expose `.Anthropic` / `.default`. Nothing else in
 * src requires the SDK (BE-05-T07 adds tests/unit/anthropicSdkSurface.test.js to keep it that way), so an SDK upgrade touches this file only.
 */
const resolveSdkConstructor = (sdk) =>
  [sdk?.Anthropic, sdk?.default, sdk].find((candidate) => typeof candidate === 'function');

const createAnthropicClient = () => {
  const Anthropic = resolveSdkConstructor(AnthropicSdk);
  return new Anthropic(getAnthropicClientOptions());
};

const sdkErrorClass = (name) => {
  const candidate = AnthropicSdk?.[name] ?? resolveSdkConstructor(AnthropicSdk)?.[name];
  return typeof candidate === 'function' ? candidate : null;
};
const isSdkError = (error, name) => {
  const ErrorClass = sdkErrorClass(name);
  return Boolean(ErrorClass && error instanceof ErrorClass);
};

// SDK 0.30 error classes never set `name`, so a real abort reads as a plain Error: check the class as well.
const isAbortError = (error) =>
  error?.name === 'AbortError' || error?.name === 'APIUserAbortError' || isSdkError(error, 'APIUserAbortError');

const isTimeoutError = (error) =>
  error?.code === 'AI_PROVIDER_TIMEOUT' ||
  error?.name === 'APIConnectionTimeoutError' ||
  isSdkError(error, 'APIConnectionTimeoutError');

const headerValue = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? null;
};

const LOG_ID_PATTERN = /[^A-Za-z0-9._:-]/g;
const safeLogId = (value) => (value == null ? null : String(value).replace(LOG_ID_PATTERN, '').slice(0, 80) || null);

/** 0.30 exposes `request_id`; later SDKs `requestID`; both keep the `request-id` header. */
const providerRequestIdOf = (error) =>
  safeLogId(error?.requestID ?? error?.request_id ?? headerValue(error?.headers, 'request-id'));

const SSE_ERROR_PREFIX = 'SSE Error: ';
const MAX_SSE_ERROR_CHARS = 2_000;
// SDK 0.30 puts raw JSON in message and "SSE Error: <json>" in cause.message.
// Later SDKs may keep only the prefixed message. Never fall back to logging either raw body.
const sseErrorBody = (error) => {
  for (const message of [error?.cause?.message, error?.message]) {
    if (typeof message !== 'string') continue;
    const text = message.startsWith(SSE_ERROR_PREFIX) ? message.slice(SSE_ERROR_PREFIX.length) : message;
    if (text.length > MAX_SSE_ERROR_CHARS) continue;
    try {
      const parsed = JSON.parse(text);
      const body = parsed?.error ?? parsed;
      if (typeof body?.type === 'string') return body;
    } catch {
      // Try the other SDK shape.
    }
  }
  return null;
};

const MAX_UPSTREAM_MESSAGE_CHARS = 200;

/** Reduces an SDK error to `{ status, type, message }` that is safe to log (never the raw response body). */
const upstreamErrorSummary = (error) => {
  const status = error?.status ?? error?.statusCode ?? null;
  const sseBody = sseErrorBody(error);
  const body = error?.error && typeof error.error === 'object' ? (error.error.error ?? error.error) : sseBody;
  const type = body?.type || error?.name || null;
  const detail = body
    ? body.message
    : (['Connection error.', 'Request timed out.', 'Request was aborted.'].includes(error?.message) ? error.message : null);
  const message = [type, typeof detail === 'string' ? detail : null].filter(Boolean).join(': ');
  return { status, type, message: message ? message.slice(0, MAX_UPSTREAM_MESSAGE_CHARS) : null };
};

const PROVIDER_FAILURES = Object.freeze({
  busy: { statusCode: 503, code: 'AI_PROVIDER_BUSY', retryable: true,
    message: 'The AI service is busy right now. No credits were charged. Try again in a minute.' },
  unavailable: { statusCode: 503, code: 'AI_PROVIDER_UNAVAILABLE', retryable: true,
    message: 'The AI service is temporarily unavailable. No credits were charged — please try again shortly.' },
  timeout: { statusCode: 504, code: 'AI_PROVIDER_TIMEOUT', retryable: true,
    message: 'The AI service took too long to answer. No credits were charged. Try again.' },
  auth: { statusCode: 502, code: 'AI_PROVIDER_AUTH_FAILED', retryable: false,
    message: "Guava's AI service is not accepting our credentials, so this will not work until we fix it. No credits were charged, and the problem has been logged." },
  rejected: { statusCode: 502, code: 'AI_PROVIDER_REJECTED', retryable: false,
    message: 'The AI service could not accept this request, so retrying it will not help. No credits were charged. Try a shorter question or start a new chat.' },
});
const REJECTED_STATUSES = new Set([400, 404, 409, 413, 422]);
const MAX_RETRY_AFTER_SECONDS = 120;

/** Retryable provider trouble stays a 503/504; our credentials or request being wrong is a 502 retrying cannot fix. */
const classifyProviderError = (error) => {
  const status = Number(error?.status) || null;
  if (isTimeoutError(error)) return PROVIDER_FAILURES.timeout;
  if (status === 429) return PROVIDER_FAILURES.busy;
  if (status === 401 || status === 403) return PROVIDER_FAILURES.auth;
  if (REJECTED_STATUSES.has(status)) return PROVIDER_FAILURES.rejected;
  return PROVIDER_FAILURES.unavailable;
};

const retryAfterSeconds = (error) => {
  const seconds = Number(headerValue(error?.headers, 'retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds)) : undefined;
};

/**
 * Normalises a provider failure into something safe to return. The message and the details are product-authored
 * (exposeMessage / exposeDetails), so the error middleware shows them even in production; upstreamStatus,
 * upstreamMessage and providerRequestId are for the server log only.
 */
const asUpstreamAiError = (error) => {
  const summary = upstreamErrorSummary(error);
  const failure = classifyProviderError(error);
  const retryAfter = failure === PROVIDER_FAILURES.busy ? retryAfterSeconds(error) : undefined;
  return Object.assign(new Error(failure.message), {
    statusCode: failure.statusCode,
    code: failure.code,
    details: { code: failure.code, retryable: failure.retryable, ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}) },
    exposeMessage: true,
    exposeDetails: true,
    wrappedProviderError: true,
    upstreamStatus: summary.status,
    upstreamMessage: summary.message,
    providerRequestId: providerRequestIdOf(error),
    ...(error?.providerDiagnostics ? { providerDiagnostics: error.providerDiagnostics } : {}),
    cause: error,
  });
};

const logProviderFailure = (operation, error, { requestId } = {}) => {
  const { status, type } = upstreamErrorSummary(error);
  const parts = [`[anthropic] ${operation} failed: status=${status} type=${type}`];
  const localId = safeLogId(requestId);
  const providerId = providerRequestIdOf(error);
  if (localId) parts.push(`requestId=${localId}`);
  if (providerId) parts.push(`providerRequestId=${providerId}`);
  console.error(parts.join(' '));
};

/** Runs an SDK call; aborts pass through untouched, every other failure is logged once and wrapped. */
const withAnthropicErrors = async (run, operation = 'request', context = {}) => {
  try {
    return await run();
  } catch (error) {
    if (isAbortError(error) || error?.wrappedProviderError) throw error;
    logProviderFailure(operation, error, context);
    throw asUpstreamAiError(error);
  }
};

const streamLimits = () => ({
  idleMs: clampInteger(process.env.AI_STREAM_IDLE_TIMEOUT_MS, 20_000, 1_000, 60_000),
  maxDurationMs: clampInteger(process.env.AI_STREAM_MAX_DURATION_MS, 120_000, 10_000, 240_000),
});

const streamTimeoutError = (phase, afterMs) => Object.assign(
  new Error(`The AI stream ${phase === 'idle' ? 'went quiet' : 'ran past its deadline'} after ${afterMs} ms`),
  { name: 'AiStreamTimeoutError', code: 'AI_PROVIDER_TIMEOUT', phase }
);

/**
 * Iterates a provider stream with an idle timer and an overall deadline. The SDK's own timeout stops at the
 * response headers, so a stalled SSE body used to hold the request, a concurrency slot and the credit reservation
 * until the client left. On a timeout it calls onTimeout (the caller aborts its upstream controller) and throws.
 */
async function* readStreamEvents(stream, { idleMs, maxDurationMs, onTimeout } = streamLimits()) {
  const iterator = stream[Symbol.asyncIterator]();
  const startedAt = Date.now();
  try {
    for (;;) {
      const remainingMs = maxDurationMs - (Date.now() - startedAt);
      const phase = remainingMs <= idleMs ? 'deadline' : 'idle';
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(streamTimeoutError(phase, phase === 'idle' ? idleMs : maxDurationMs)),
          Math.max(0, Math.min(idleMs, remainingMs))
        );
      });
      let step;
      try {
        step = await Promise.race([iterator.next(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (step.done) return;
      yield step.value;
    }
  } catch (error) {
    if (error?.code === 'AI_PROVIDER_TIMEOUT') onTimeout?.(error);
    throw error;
  } finally {
    // Not awaited: after an abort the pending read settles on its own; a hung fake would otherwise hang the caller.
    Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

/** The answer text: every text block in order, starting at the first one; thinking and tool blocks are skipped. */
const responseText = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('')
  .trim();

module.exports = {
  asUpstreamAiError,
  classifyProviderError,
  createAnthropicClient,
  getAnthropicClientOptions,
  isAbortError,
  isTimeoutError,
  logProviderFailure,
  providerRequestIdOf,
  readStreamEvents,
  resolveSdkConstructor,
  responseText,
  streamLimits,
  withAnthropicErrors,
};
