// BE-13-T02: every machine-readable code the API sends is registered, and the error middleware always sends a registered code
// at the top level (never a system, database or library code), with Retry-After when it knows the wait.
const fs = require('fs');
const path = require('path');
const errorMiddleware = require('../../src/middleware/error.middleware');
const { ERROR_CODES, isRegisteredCode, codeOf } = require('../../src/utils/errorCodes');

const SRC = path.resolve(__dirname, '../../src');
const CODE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';
const LITERAL = new RegExp(`'(${CODE})'`, 'g');
// Same rule as backend-90/tools/contract-map.mjs: CONSTANT_CASE literals in a `code:`/`code =`/`publicCode:` span, or in the
// arguments of an error factory (`*Error(…)`, `refuse*(…)`).
const SPANS = [/\b(?:code|publicCode)\s*(?::|=(?!=))[^\n;]*/g, new RegExp(`\\b(?:\\w*Error|refuse\\w*)\\([^;]*?'${CODE}'`, 'g')];

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return entry.name.endsWith('.js') && !entry.name.startsWith('seed') && entry.name !== 'errorCodes.js' ? [full] : [];
});

const emitted = () => {
  const found = new Map();
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of SPANS) for (const span of text.matchAll(re)) for (const lit of span[0].matchAll(LITERAL)) {
      if (!found.has(lit[1])) found.set(lit[1], path.relative(SRC, file));
    }
  }
  return found;
};

const createResponse = () => {
  const response = { status: jest.fn(), json: jest.fn(), set: jest.fn() };
  response.status.mockReturnValue(response);
  response.set.mockReturnValue(response);
  return response;
};
const request = { id: 'request-1', method: 'POST', path: '/api/example' };
const bodyOf = (response) => response.json.mock.calls[0][0];

describe('error code registry', () => {
  it('registers every code the source emits', () => {
    const unregistered = [...emitted()].filter(([code]) => !isRegisteredCode(code)).map(([code, file]) => `${code} (${file})`);
    expect(unregistered).toEqual([]);
  });

  it('holds no code that nothing emits', () => {
    const found = emitted();
    expect(Object.keys(ERROR_CODES).filter((code) => !found.has(code))).toEqual([]);
  });

  it('keeps one entry per line in the shape the contract map reads', () => {
    const text = fs.readFileSync(path.join(SRC, 'utils', 'errorCodes.js'), 'utf8');
    const lines = [...text.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*\{([^\n]*)\}/gm)].map((m) => m[1]);
    expect(lines.sort()).toEqual(Object.keys(ERROR_CODES).sort());
    for (const entry of Object.values(ERROR_CODES)) {
      expect(Number.isInteger(entry.status)).toBe(true);
      expect(typeof entry.client).toBe('boolean');
      expect(entry.meaning.length).toBeGreaterThan(15);
    }
  });

  it('names a code in every rate limiter', () => {
    const source = fs.readFileSync(path.join(SRC, 'middleware', 'rateLimit.middleware.js'), 'utf8');
    const blocks = source.split('rateLimit({').slice(1).map((block) => block.slice(0, block.indexOf('});')));
    expect(blocks.length).toBeGreaterThan(0);
    // A block may pass a shared message constant (`message: AI_RATE_LIMIT_MESSAGE`): its definition must then carry the code.
    const messageOf = (block) => {
      const named = block.match(/message:\s*([A-Z][A-Z0-9_]+)\s*,/);
      if (!named) return block;
      const definition = source.match(new RegExp(`const ${named[1]} = \\{[^}]*\\}`));
      return definition ? definition[0] : '';
    };
    blocks.forEach((block) => expect(messageOf(block)).toMatch(/code:\s*'[A-Z][A-Z0-9_]+'/));
  });

  it('reads a code from publicCode, code or details.code, and nothing unregistered', () => {
    expect(codeOf({ publicCode: 'UPSTREAM_TIMEOUT', code: 'ETIMEDOUT' })).toBe('UPSTREAM_TIMEOUT');
    expect(codeOf({ code: 'SEVERE_PARTIAL_IMPORT' })).toBe('SEVERE_PARTIAL_IMPORT');
    expect(codeOf({ details: { code: 'BILLING_REQUIRED' } })).toBe('BILLING_REQUIRED');
    expect(codeOf({ code: 'ENOENT', details: { code: 11000 } })).toBeNull();
    expect(codeOf({ code: 'hasOwnProperty' })).toBeNull();
    expect(codeOf(null)).toBeNull();
  });
});

describe('error middleware sends the code', () => {
  it('sends a registered err.code at the top level beside its details', () => {
    const response = createResponse();
    const err = Object.assign(new Error('12 of 20 rows could not be parsed.'), {
      statusCode: 422, code: 'SEVERE_PARTIAL_IMPORT', details: { errors: 12, totalRows: 20 },
    });
    errorMiddleware(err, request, response, jest.fn());
    expect(response.status).toHaveBeenCalledWith(422);
    expect(bodyOf(response)).toEqual(expect.objectContaining({ code: 'SEVERE_PARTIAL_IMPORT', details: { errors: 12, totalRows: 20 } }));
  });

  it('prefers a registered publicCode over the internal code', () => {
    const response = createResponse();
    const err = Object.assign(new Error('The AI service is temporarily unavailable. No credits were charged.'), {
      statusCode: 503, code: 'ECONNRESET', publicCode: 'AI_PROVIDER_UNAVAILABLE',
    });
    errorMiddleware(err, request, response, jest.fn());
    expect(bodyOf(response).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('lifts a registered details.code to the top level', () => {
    const response = createResponse();
    const err = Object.assign(new Error('Your daily AI credit safety limit has been reached'), {
      statusCode: 429, details: { code: 'AI_USER_DAILY_BUDGET_REACHED', limit: 500 },
    });
    errorMiddleware(err, request, response, jest.fn());
    expect(bodyOf(response).code).toBe('AI_USER_DAILY_BUDGET_REACHED');
  });

  it('never sends a system, database or library code', () => {
    for (const code of ['ENOENT', 'ECONNRESET', 'LIMIT_FILE_SIZE', 11000]) {
      const response = createResponse();
      errorMiddleware(Object.assign(new Error('boom'), { statusCode: 400, code }), request, response, jest.fn());
      expect(bodyOf(response).code).toBeUndefined();
    }
  });

  it('sets Retry-After on a thrown 429 that knows when to retry', () => {
    const response = createResponse();
    const err = Object.assign(new Error('You already have the maximum number of AI requests in progress'), {
      statusCode: 429, code: 'AI_USER_CONCURRENCY_LIMIT', retryAfterSeconds: 5,
    });
    errorMiddleware(err, request, response, jest.fn());
    expect(response.set).toHaveBeenCalledWith('Retry-After', '5');
  });

  it('answers an oversized JSON body with 413 PAYLOAD_TOO_LARGE at the top level and the limit (BE-05-T06 message kept)', () => {
    const response = createResponse();
    const err = Object.assign(new Error('request entity too large'), {
      status: 413, statusCode: 413, type: 'entity.too.large', limit: 102400, length: 500000,
    });
    errorMiddleware(err, request, response, jest.fn());
    expect(response.status).toHaveBeenCalledWith(413);
    expect(bodyOf(response)).toEqual(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE', message: expect.stringMatching(/100 KB/) }));
  });

  it('sends no Retry-After on a 429 that does not know the wait, nor on other statuses', () => {
    for (const err of [
      Object.assign(new Error('daily limit'), { statusCode: 429, details: { code: 'AI_USER_DAILY_BUDGET_REACHED' } }),
      Object.assign(new Error('nope'), { statusCode: 400, code: 'LEGACY_XLS', retryAfterSeconds: 5 }),
    ]) {
      const response = createResponse();
      errorMiddleware(err, request, response, jest.fn());
      expect(response.set).not.toHaveBeenCalled();
    }
  });
});
