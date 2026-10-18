const crypto = require('crypto');
const { requestLogsEnabled } = require('../config/flags');
const { activeCafeId } = require('../utils/tenancy');

const logger = require('../utils/logger');
const REQUEST_ID_HEADER = 'X-Request-Id';
const CLIENT_REQUEST_ID_HEADER = 'X-Client-Request-Id';
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

const logsEnabled = () => requestLogsEnabled();

const generateRequestId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
};

// Routers strip their mount prefix from req.path, so by the time the response
// finishes "/api/auth/me" reads as "/me". originalUrl keeps the full path; the
// query string is dropped because it can carry tokens.
const requestPath = (req) => String(req.originalUrl || req.url || '').split('?')[0];

// The id in logs and 5xx bodies is always ours, so no client can make two
// requests share one. A well-formed client id is kept beside it for correlation.
const requestContext = (req, res, next) => {
  const requestId = generateRequestId();
  const incomingId = String(req.get(REQUEST_ID_HEADER) || '');
  const clientRequestId = REQUEST_ID_PATTERN.test(incomingId) ? incomingId : undefined;

  req.id = requestId;
  req.requestId = requestId;
  req.clientRequestId = clientRequestId;
  req.startedAt = Date.now();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  if (clientRequestId) res.setHeader(CLIENT_REQUEST_ID_HEADER, clientRequestId);
  next();
};

const requestLogger = (req, res, next) => {
  if (!logsEnabled()) return next();

  const startedAt = process.hrtime.bigint();
  let logged = false;
  const fieldsFor = (extra) => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const fields = {
      requestId: req.id,
      ...(req.clientRequestId ? { clientRequestId: req.clientRequestId } : {}),
      method: req.method,
      path: requestPath(req),
      ...(!extra.aborted || res.headersSent ? { statusCode: res.statusCode } : {}),
      durationMs: Number(durationMs.toFixed(1)),
      contentLength: Number(res.getHeader('content-length') || 0),
      ...extra,
    };
    if (req.user?.id) fields.userId = String(req.user.id);
    if (activeCafeId(req)) fields.cafeId = String(activeCafeId(req));
    return fields;
  };

  res.on('finish', () => {
    if (logged) return;
    logged = true;
    if (res.statusCode >= 500) logger.error('http_request', fieldsFor({}));
    else logger.info('http_request', fieldsFor({}));
  });
  // 'close' without 'finish' is a client that went away: a cancelled Ask Guava
  // stream or an aborted upload. It used to leave no line at all.
  res.on('close', () => {
    if (logged || res.writableFinished) return;
    logged = true;
    logger.warn('http_request_aborted', fieldsFor({ aborted: true }));
  });

  next();
};

module.exports = { REQUEST_ID_HEADER, CLIENT_REQUEST_ID_HEADER, requestContext, requestLogger };
