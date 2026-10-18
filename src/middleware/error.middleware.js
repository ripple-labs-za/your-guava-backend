const logger = require('../utils/logger');
const { isHardenedEnvironment } = require('../config/posture');

// A code the product wrote for the client to branch on (SEVERE_PARTIAL_IMPORT, LEGACY_XLS, ...). err.code alone is
// never exposed: it is also where Node, Mongo and libraries put theirs (ENOENT, 11000). Same rule as BE-09-T02.
const PUBLIC_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const isHttpStatus = (value) => Number.isInteger(value) && value >= 400 && value <= 599;

// Provider authentication is not the caller's session expiring.
const resolveStatus = (err) => {
  if (err?.isAxiosError === true) return 502;
  if (isHttpStatus(err?.statusCode)) return err?.statusCode;
  if (err?.expose === true && isHttpStatus(err?.status)) return err?.status;
  return 500;
};

const errorMiddleware = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  // An unwrapped axios error is still an upstream failure. Ignore its message,
  // details and any opt-in fields; those did not come from our error helpers.
  if (err?.isAxiosError === true) {
    const upstreamStatus = err?.response?.status;
    err = Object.assign(new Error('The upstream service could not complete the request. Please try again in a minute.'), {
      statusCode: 502,
      publicCode: upstreamStatus === 401 || upstreamStatus === 403 ? 'UPSTREAM_AUTH_FAILED' : 'UPSTREAM_ERROR',
      exposeMessage: true,
      upstreamStatus,
      cause: err,
    });
  }
  let statusCode = resolveStatus(err);
  let message = err?.message || 'Internal Server Error';
  let details = err?.details;
  const requestId = req.id || req.requestId;

  // Map common Mongoose errors to 4xx so client mistakes aren't logged as 500s.
  if (err?.name === 'ValidationError' && err?.errors) {
    statusCode = 400;
    message = Object.values(err?.errors)
      .map((e) => e.message)
      .join('; ') || 'Validation failed';
  } else if (err?.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for ${err?.path}`;
  } else if (err?.code === 11000) {
    statusCode = 409;
    const field = err?.keyPattern ? Object.keys(err?.keyPattern)[0] : 'field';
    message = `A record with this ${field} already exists.`;
  } else if (err?.type === 'entity.too.large') {
    statusCode = 413;
    message = `This request is too large to process. The limit is ${Math.round(err?.limit / 1024)} KB.`;
    details = { code: 'PAYLOAD_TOO_LARGE', limitBytes: err?.limit };
  }

  if (statusCode >= 500) {
    logger.error('request_error', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode,
      message: err?.message || message,
      // Set by asUpstreamAiError: the client keeps the friendly 503 while the
      // log keeps the provider's reason (e.g. a rejected API key).
      ...(err?.upstreamStatus != null ? { upstreamStatus: err?.upstreamStatus } : {}),
      ...(err?.upstreamMessage
        ? { upstreamMessage: String(err?.upstreamMessage).slice(0, 200) }
        : {}),
      ...(err?.logContext ? { context: err?.logContext } : {}),
      stack: err?.stack,
    });
  }

  // A 5xx message is redacted in production because it is usually a stack-level
  // detail — a connection string, a provider body — that must never reach a
  // browser. The exception is a message the product wrote deliberately FOR the
  // customer: asUpstreamAiError explains that the AI provider is down and that
  // no credits were charged. Redacting that to "Internal Server Error" left a
  // cafe owner with no idea what had happened and a reasonable fear they had
  // just paid for nothing. `exposeMessage` is opt-in, is set only on fixed
  // product-authored strings, and never on a raw thrown error.
  if (statusCode >= 500 && isHardenedEnvironment() && !err?.exposeMessage) {
    message = 'Internal Server Error';
  }

  const exposeDetails = details && (err?.exposeDetails === true || !(statusCode >= 500 && isHardenedEnvironment()));
  const publicCode = typeof err?.publicCode === 'string' && PUBLIC_CODE_RE.test(err?.publicCode) ? err?.publicCode : null;

  return res.status(statusCode).json({
    success: false,
    message,
    ...(publicCode ? { code: publicCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(exposeDetails ? { details } : {}),
  });
};

module.exports = errorMiddleware;
