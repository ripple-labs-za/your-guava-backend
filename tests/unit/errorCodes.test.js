// BE-13-T02: every machine-readable code the API sends is registered, and the error middleware always sends a registered code
// at the top level (never a system, database or library code), with Retry-After when it knows the wait.
const fs = require('fs');
const os = require('os');
const path = require('path');
const errorMiddleware = require('../../src/middleware/error.middleware');
const { ERROR_CODES, isRegisteredCode, codeOf, refusalBody } = require('../../src/utils/errorCodes');

const SRC = path.resolve(__dirname, '../../src');
// Same rule as backend-90/tools/contract-map.mjs (BE-13-T02 round 2): every quoted CONSTANT_CASE literal in src (one word of
// three or more capitals, or words joined by underscores) is an error code unless tests/fixtures/notErrorCodes.json names it
// (environment variables, library codes, HTTP methods, plain values). No span rule, so a code thrown through a helper of any
// name (`refusal(400, 'X', …)`) is still found.
const LITERAL = /['"`]([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/g;
const NOT_CODES_FILE = path.resolve(__dirname, '../fixtures/notErrorCodes.json');
const notCodes = () => {
  const { _comment, ...groups } = JSON.parse(fs.readFileSync(NOT_CODES_FILE, 'utf8'));
  return new Set(Object.values(groups).flat());
};
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return entry.name.endsWith('.js') && entry.name !== 'errorCodes.js' ? [full] : [];
});

// Every quoted CONSTANT_CASE literal under `dir`, with the first file it appears in.
const literals = (dir) => {
  const found = new Map();
  for (const file of walk(dir)) {
    for (const lit of fs.readFileSync(file, 'utf8').matchAll(LITERAL)) {
      if (!found.has(lit[1])) found.set(lit[1], path.relative(dir, file));
    }
  }
  return found;
};

const emitted = (dir = SRC) => {
  const skip = notCodes();
  return new Map([...literals(dir)].filter(([name]) => !skip.has(name)));
};

// Where a code is emitted: a code field, a throw, an error factory or refusal helper, or a call that takes an HTTP status
// as a whole argument (`refusal(409, 'X', …)`, `refusal('…', 413, 'X')`). A name from the not-a-code list must never sit
// there, or it would leave the API uncoded (codeOf drops it) while the registry test stays green.
const EMISSION_SPANS = [
  /\b(?:code|publicCode)\s*(?::|=(?!=))[^\n;,})]*/g,
  /\bthrow\b[^;]*/g,
  /\b(?:\w*Error|\w*[Rr]efus\w*)\([^;]*/g,
];
const CALL = /\b\w+\(([^;()]*)\)/g;
const STATUS_ARGUMENT = /(?:^|,)\s*[1-5]\d\d\s*(?:,|$)/;
// A missing stored upload is signalled with Node's own code and caught three lines later; it is never sent.
const LOCAL_SIGNALS = [['controllers/uploads/download.js', 'ENOENT']];

const emissionSpans = (text) => [
  ...EMISSION_SPANS.flatMap((re) => [...text.matchAll(re)].map((m) => m[0])),
  ...[...text.matchAll(CALL)].filter((m) => STATUS_ARGUMENT.test(m[1])).map((m) => m[0]),
];

const misusedNames = (dir) => {
  const skip = notCodes();
  const found = new Set();
  for (const file of walk(dir)) {
    const relative = path.relative(dir, file).split(path.sep).join('/');
    for (const span of emissionSpans(fs.readFileSync(file, 'utf8'))) for (const lit of span.matchAll(LITERAL)) {
      if (!skip.has(lit[1]) || LOCAL_SIGNALS.some(([where, name]) => where === relative && name === lit[1])) continue;
      found.add(`${lit[1]} (${relative})`);
    }
  }
  return [...found];
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

  it('finds a code thrown through a helper of any name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-codes-'));
    try {
      fs.writeFileSync(path.join(dir, 'planted.js'), "const refusal = (s, c, m) => Object.assign(new Error(m), { statusCode: s });\n"
        + "module.exports = (one) => { throw one ? refusal(400, 'PLANTED', 'no') : refusal(409, 'PLANTED_REFUSAL', 'no'); };\n");
      expect([...emitted(dir).keys()].sort()).toEqual(['PLANTED', 'PLANTED_REFUSAL']);
      expect(isRegisteredCode('PLANTED')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the not-a-code list exact: every name is still in src and none is a registered code', () => {
    const inSource = literals(SRC);
    const listed = [...notCodes()];
    expect(listed.filter((name) => !inSource.has(name))).toEqual([]);
    expect(listed.filter((name) => isRegisteredCode(name))).toEqual([]);
  });

  it('never emits a name from the not-a-code list as a code', () => {
    expect(misusedNames(SRC)).toEqual([]);
  });

  it('catches a not-a-code name used as a code, wherever the refusal is written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-codes-'));
    try {
      fs.writeFileSync(path.join(dir, 'planted.js'), "const refusal = (s, c, m) => Object.assign(new Error(m), { statusCode: s });\n"
        + "const a = () => refusal(409, 'PAYMENT_PROVIDER', 'reuses an environment name');\n"
        + "const b = (e) => { e.code = 'JWT_SECRET'; return e; };\n"
        + "const c = () => ({ maxTokens: 512, env: 'ANTHROPIC_MODEL' });\n"
        + 'module.exports = { a, b, c };\n');
      expect(misusedNames(dir).sort()).toEqual(['JWT_SECRET (planted.js)', 'PAYMENT_PROVIDER (planted.js)']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the parser and menu refusals that BE-13-T02 round 2 registered', () => {
    for (const code of ['UPLOAD_PARSE_TIMEOUT', 'UPLOAD_PARSE_RESOURCE_LIMIT', 'UPLOAD_ABORTED']) expect(codeOf({ code })).toBe(code);
    for (const code of ['MAP_TO_SELF', 'MAP_TO_INACTIVE_TARGET', 'ITEM_NAME_TAKEN']) expect(codeOf({ code, publicCode: code })).toBe(code);
    expect(ERROR_CODES.UPLOAD_ABORTED.client).toBe(false);
  });

  it('answers a refusal a controller sends itself with the registered code only', () => {
    expect(refusalBody(Object.assign(new Error('A menu item cannot be linked to itself.'), { publicCode: 'MAP_TO_SELF' })))
      .toEqual({ success: false, code: 'MAP_TO_SELF', message: 'A menu item cannot be linked to itself.' });
    expect(refusalBody(Object.assign(new Error('Busy'), { code: 'ENOENT' }), { members: [1] }))
      .toEqual({ success: false, message: 'Busy', members: [1] });
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
