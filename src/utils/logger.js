/**
 * Structured logging: one JSON object per line on stdout, no dependency.
 * Railway and any log shipper parse JSON lines and read `level` themselves.
 *
 *   logger.info('upload_cleanup_summary', { deleted: 2 });
 *   logger.error('payment_reconcile_failed', { reference, ...logger.errorFields(error) });
 *
 * Call the methods through this object, never destructured, so tests can
 * jest.spyOn(logger, 'error'). Sensitive keys are redacted, credentials in URLs
 * are scrubbed and long strings are capped, so a careless call site cannot leak
 * a secret or flood the log.
 */
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, fatal: 50 });
const SENSITIVE_KEY = /password|passphrase|^pass$|secret|token|authori[sz]ation|cookie|api[-_]?key|signature|^salt$|credential/i;
const PERSONAL_KEY = /^(e-?mail|to|recipient|phone)$/i;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const MAX_STRING_CHARS = 2000;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 6;

const thresholdFor = (name) => {
  const key = String(name || 'info').toLowerCase();
  if (key === 'silent') return Number.POSITIVE_INFINITY;
  return LEVELS[key] || LEVELS.info;
};

const cleanString = (value) => {
  const scrubbed = value.replace(URL_CREDENTIALS, '$1[redacted]@');
  return scrubbed.length > MAX_STRING_CHARS
    ? `${scrubbed.slice(0, MAX_STRING_CHARS)}...[${scrubbed.length - MAX_STRING_CHARS} more chars]`
    : scrubbed;
};

const errorFields = (error, { stack = false } = {}) => {
  if (!error || typeof error !== 'object') {
    return { errorName: 'NonError', errorMessage: cleanString(String(error)) };
  }
  const fields = {
    errorName: cleanString(String(error.name || 'Error')),
    errorMessage: cleanString(String(error.message || '')),
  };
  if (error.code !== undefined && error.code !== null) fields.errorCode = cleanString(String(error.code));
  if (Number.isInteger(error.statusCode)) fields.statusCode = error.statusCode;
  if (stack && error.stack) fields.stack = cleanString(String(error.stack));
  return fields;
};

const sanitize = (value, depth, seen) => {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string': return cleanString(value);
    case 'number': return Number.isFinite(value) ? value : String(value);
    case 'boolean': return value;
    case 'bigint': return value.toString();
    case 'function':
    case 'symbol': return undefined;
    default: break;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return errorFields(value);
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    return items;
  }
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || PERSONAL_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    const clean = sanitize(inner, depth + 1, seen);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
};

const toFields = (fields) => {
  if (fields === undefined || fields === null) return {};
  if (fields instanceof Error) return errorFields(fields);
  if (typeof fields === 'object' && !Array.isArray(fields)) return sanitize(fields, 0, new WeakSet());
  return { detail: sanitize(fields, 0, new WeakSet()) };
};

const defaultWrite = (line) => process.stdout.write(`${line}\n`);

const createLogger = ({ write = defaultWrite, level } = {}) => {
  const emit = (levelName, event, fields) => {
    try {
      if (LEVELS[levelName] < thresholdFor(level ?? process.env.LOG_LEVEL)) return;
      const entry = { time: new Date().toISOString(), level: levelName, event: cleanString(String(event || 'log')) };
      for (const [key, value] of Object.entries(toFields(fields))) {
        if (!(key in entry)) entry[key] = value;
      }
      write(JSON.stringify(entry));
    } catch (_error) {
      // Logging must never take a request or the process down with it.
    }
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    fatal: (event, fields) => emit('fatal', event, fields),
  };
};

// Human-readable output for CLI scripts (migrations). Server code uses the levels above.
const printLine = (text) => {
  try {
    process.stdout.write(`${String(text)}\n`);
  } catch (_error) {
    // A closed stdout must not crash a CLI mid-run.
  }
};

const logger = createLogger();

module.exports = Object.assign(logger, { createLogger, errorFields, printLine, LEVELS });
