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
const SENSITIVE_KEY = /password|passphrase|^pass$|secret|token|authori[sz]ation|cookie|api[-_]?key|signature|^salt$|credential|verification[-_]?code|^(pan|cvv|otp|bin|last4)$/i;
const PERSONAL_KEY = /e-?mail|phone|mobile|^(to|recipient)$/i;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]*@/gi;
const EMAIL_ADDRESS = /[a-z0-9._%+-]{1,254}@[a-z0-9.-]{1,253}\.[a-z]{2,63}/gi;
const QUERY_SECRET = /([?&](?:[a-z0-9_-]*token|api[-_]?key|key|secret|password|passphrase|verification[-_]?code|code|otp|signature)=)[^&#\s]*/gi;
const MAX_STRING_CHARS = 2000;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 6;

const thresholdFor = (name) => {
  const key = String(name || 'info').toLowerCase();
  if (key === 'silent') return Number.POSITIVE_INFINITY;
  return LEVELS[key] || LEVELS.info;
};

const cleanString = (value) => {
  // Remove URL userinfo before clipping, including an embedded @ in a password.
  // Bound the remaining scans so hostile long strings cannot make logging costly.
  const safeUrl = value.replace(URL_CREDENTIALS, '$1[redacted]@');
  const clipped = safeUrl.slice(0, MAX_STRING_CHARS);
  const scrubbed = clipped.replace(EMAIL_ADDRESS, '[redacted]').replace(QUERY_SECRET, '$1[redacted]');
  const omitted = Math.max(0, safeUrl.length - MAX_STRING_CHARS) + Math.max(0, scrubbed.length - MAX_STRING_CHARS);
  return omitted > 0 ? `${scrubbed.slice(0, MAX_STRING_CHARS)}...[${omitted} more chars]` : scrubbed;
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
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ITEMS); index += 1) {
        try {
          items.push(sanitize(value[index], depth + 1, seen));
        } catch (_error) {
          items.push('[unavailable]');
        }
      }
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
      return items;
    }
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      if (SENSITIVE_KEY.test(key) || PERSONAL_KEY.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      try {
        const clean = sanitize(value[key], depth + 1, seen);
        if (clean !== undefined) out[key] = clean;
      } catch (_error) {
        out[key] = '[unavailable]';
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
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
        let outputKey = key;
        while (outputKey in entry) outputKey = `caller_${outputKey}`;
        entry[outputKey] = value;
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
