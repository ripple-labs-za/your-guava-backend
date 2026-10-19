const fs = require('fs');
const path = require('path');

/**
 * A regex escape that passes through a JSON-decoding layer collapses into the
 * control character it names: "\b" becomes a literal U+0008 BACKSPACE. The
 * result is still valid JavaScript, so `node --check` passes, and every editor,
 * diff and JSON.stringify renders the byte back as an innocent-looking "\b".
 * Only the raw bytes give it away.
 *
 * It happened once already: the WORD_MATCH regex in itemCategory.js shipped
 * matching a backspace instead of a word boundary, so "Coca Cola" and "Ice Tea"
 * were filed as "other" and silently lost the cold-drink weather signal, and
 * the classifier's own tests stayed green because every case they covered also
 * matched a plain substring. This is the durable guard. The CI workflow runs
 * the same check with grep over every tracked source file.
 */
const SRC_ROOT = path.resolve(__dirname, '../../src');

// Every byte below 0x20 except tab, line feed and carriage return.
const CONTROL_BYTE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

const findControlBytes = (file) => {
  // latin1 maps one byte to one character, so the offsets are byte offsets and
  // multi-byte UTF-8 sequences can never be mistaken for a control byte.
  const source = fs.readFileSync(file, 'latin1');
  const found = [];
  for (const match of source.matchAll(CONTROL_BYTE)) {
    const hex = match[0].charCodeAt(0).toString(16).padStart(2, '0');
    found.push(`${path.relative(SRC_ROOT, file)}:${lineOf(source, match.index)} 0x${hex}`);
  }
  return found;
};

describe('source hygiene', () => {
  const files = walk(SRC_ROOT);

  it('walks the source tree it is meant to guard', () => {
    expect(files).toContain(path.join(SRC_ROOT, 'utils', 'itemCategory.js'));
    expect(files).toContain(path.join(SRC_ROOT, 'services', 'forecast.service.js'));
  });

  it('contains no raw control characters in any src/**/*.js file', () => {
    expect(files.flatMap(findControlBytes)).toEqual([]);
  });

  it('would catch the collapsed escape that shipped in itemCategory.js', () => {
    // Built from escapes and String.raw rather than typed, because the same
    // collapse can happen to a test file on its way through a tool.
    const collapsed = String.fromCharCode(8);
    const broken = `const WORD_MATCH = /${collapsed}(cola|ice|shake)${collapsed}/;`;
    const intact = String.raw`const WORD_MATCH = /\b(cola|ice|shake)\b/;`;
    expect([...broken.matchAll(CONTROL_BYTE)]).toHaveLength(2);
    expect([...intact.matchAll(CONTROL_BYTE)]).toHaveLength(0);
    expect(intact).toContain(String.fromCharCode(92) + 'b(cola');
  });

  it('holds no copy of the email pattern that froze the server', () => {
    // [^\s@]+@[^\s@]+\.[^\s@]+ lets the domain split at any dot, so a long
    // dotted string backtracks quadratically: 1.4 s at 40,000 characters, on a
    // login any stranger can send. Seven copies had drifted across src; email
    // checks now go through utils/email.js, which never runs a regex on
    // anything longer than an address can be.
    const legacy = String.raw`[^\s@]+@[^\s@]+\.[^\s@]+`;
    const copies = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes(legacy))
      .map((file) => path.relative(SRC_ROOT, file));
    expect(copies).toEqual([]);
  });

  it('gives every csv-parser a row byte limit', () => {
    const sites = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bcsv\(\{/g)) {
        let depth = 0;
        let end = match.index + 'csv('.length;
        for (; end < source.length; end += 1) {
          if (source[end] === '{') depth += 1;
          if (source[end] === '}' && --depth === 0) break;
        }
        sites.push({
          where: `${path.relative(SRC_ROOT, file)}:${lineOf(source, match.index)}`,
          options: source.slice(match.index, end + 1),
        });
      }
    }
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter((site) => !/maxRowBytes\s*:/.test(site.options)).map((site) => site.where)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Source structure (BE-11-T07). BE-11 split the files over 800 lines and gave every
// copied helper one home; these cases keep it that way. The contract itself is data
// in tests/fixtures/sourceHomes.js, so adding a shared helper is a one-line change.
// ---------------------------------------------------------------------------
const {
  MAX_SOURCE_LINES, CONSOLE_LOG_ALLOWED, HELPER_HOMES, RETIRED_NAMES, SOURCE_PATTERNS, BARREL_FOLDERS, BARREL_EXCEPTIONS,
} = require('../fixtures/sourceHomes');

const relativeToSrc = (full) => path.relative(SRC_ROOT, full).split(path.sep).join('/');
const TOP_LEVEL_DECLARATION = /^(?:const|let|var|async function|function|class)\s+([A-Za-z_$][\w$]*)/;
const RELATIVE_REQUIRE = /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g;

// Each scanner is pure (file path relative to src, file text) so the self-test below can feed it a probe.
const declarationViolations = (file, source) => source.split('\n').flatMap((line, index) => {
  const declared = line.match(TOP_LEVEL_DECLARATION);
  if (!declared) return [];
  const name = declared[1];
  const where = `${file}:${index + 1}  ${line.trim()}`;
  if (RETIRED_NAMES.includes(name)) return [`retired name redefined  ${where}`];
  const home = Object.prototype.hasOwnProperty.call(HELPER_HOMES, name) ? HELPER_HOMES[name] : null;
  return home && home !== file ? [`defined outside ${home}  ${where}`] : [];
});

const patternViolations = (file, source) => source.split('\n').flatMap((line, index) => SOURCE_PATTERNS
  .filter(({ re, allow, deny }) => re.test(line)
    && ((allow && !allow.includes(file)) || (deny && deny.some((prefix) => file.startsWith(prefix)))))
  .map(({ rule }) => `${rule}  ${file}:${index + 1}  ${line.trim()}`));

const barrelViolations = (file, source) => [...source.matchAll(RELATIVE_REQUIRE)].flatMap((match) => {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2])).replace(/\.js$/, '');
  return Object.entries(BARREL_FOLDERS)
    .filter(([folder, barrel]) => target.startsWith(folder) && !file.startsWith(folder) && file !== barrel)
    .filter(() => !BARREL_EXCEPTIONS.some(([from, to]) => from === file && to === target))
    .map(([, barrel]) => `reached past its barrel ${barrel}  ${file}:${lineOf(source, match.index)}  ${match[0]}`);
});

const sourceLineCount = (source) => source.split('\n').length - Number(source.endsWith('\n'));

describe('source structure (BE-11-T07)', () => {
  const sources = walk(SRC_ROOT).map((full) => ({ file: relativeToSrc(full), source: fs.readFileSync(full, 'utf8') }));
  const all = (scan) => sources.flatMap(({ file, source }) => scan(file, source));

  it('keeps every src file at or under 800 lines', () => {
    const over = sources
      .map(({ file, source }) => [file, sourceLineCount(source)])
      .filter(([, lines]) => lines > MAX_SOURCE_LINES)
      .map(([file, lines]) => `${file} (${lines})`);
    expect(over).toEqual([]);
  });

  it('counts an unterminated final line at the 800-line boundary, with LF or CRLF', () => {
    for (const newline of ['\n', '\r\n']) {
      const boundary = Array(800).fill('// line').join(newline);
      expect(sourceLineCount(boundary)).toBe(800);
      expect(sourceLineCount(boundary + newline)).toBe(800);
      expect(sourceLineCount(boundary + newline + '// line')).toBe(801);
    }
  });

  it('pins every guard name, home, barrel, regex and exception', () => {
    // Adding or removing a guard requires updating this explicit contract.
    expect(Object.entries(HELPER_HOMES).sort()).toEqual([
      ["DATE_ONLY_RE", "utils/timezone.js"],
      ["DEFAULT_TIMEZONE", "utils/timezone.js"],
      ["DEMAND_LINE_MATCH", "utils/demand.js"],
      ["EMAIL_MAX_LENGTH", "utils/email.js"],
      ["IGNORED_LINE_STATUS", "utils/demand.js"],
      ["ITEM_CATEGORIES", "utils/itemCategory.js"],
      ["MAX_BULK_CONFIRM", "services/menuItems.service.js"],
      ["MAX_PASSWORD_BYTES", "utils/password.js"],
      ["MAX_ROW_ERRORS", "services/parser/rowErrors.js"],
      ["MIN_PASSWORD_LENGTH", "utils/password.js"],
      ["OPAQUE_TOKEN_RE", "utils/authPrimitives.js"],
      ["OUTBOUND_SERVICES", "utils/http.js"],
      ["REFRESH_COOKIE_MAX_AGE_MS", "config/posture.js"],
      ["REFRESH_COOKIE_NAME", "utils/authPrimitives.js"],
      ["REQUIRED_FIELDS", "services/parser/headers.js"],
      ["SOURCE_ROW_NUMBERS", "services/parser/rowErrors.js"],
      ["TIME_OF_DAY_RE", "utils/timezone.js"],
      ["VALID_ITEMS_MODES", "services/parser/parse.js"],
      ["activeCafeId", "utils/tenancy.js"],
      ["addDatePartsDays", "utils/timezone.js"],
      ["addZonedDays", "utils/timezone.js"],
      ["boundedInteger", "services/parser/limits.js"],
      ["cafeLocalToday", "utils/timezone.js"],
      ["chunksOf", "services/transactionIdentity.js"],
      ["clearRefreshCookie", "utils/authPrimitives.js"],
      ["confirmAllNeedsReview", "services/menuCorrections.service.js"],
      ["contentKey", "services/transactionIdentity.js"],
      ["contentSignature", "services/transactionIdentity.js"],
      ["createClientInputError", "services/parser/limits.js"],
      ["dateOnlyParts", "utils/timezone.js"],
      ["demandItemsExpression", "utils/demand.js"],
      ["demandLines", "utils/demand.js"],
      ["formatDateOnly", "utils/timezone.js"],
      ["generateAccessToken", "utils/authPrimitives.js"],
      ["generateOpaqueToken", "utils/authPrimitives.js"],
      ["getCafeTimezone", "utils/timezone.js"],
      ["getTimeZoneOffsetMs", "utils/timezone.js"],
      ["getZonedDateParts", "utils/timezone.js"],
      ["hashPassword", "utils/password.js"],
      ["inclusiveDateOnlyDays", "utils/timezone.js"],
      ["isDemandLine", "utils/demand.js"],
      ["isHardenedEnvironment", "config/posture.js"],
      ["isItemCategory", "utils/itemCategory.js"],
      ["isRelaxedEnvironment", "config/posture.js"],
      ["isTestEnvironment", "config/posture.js"],
      ["isValidEmail", "utils/email.js"],
      ["normalizedOpaqueToken", "utils/authPrimitives.js"],
      ["outboundGet", "utils/http.js"],
      ["outboundPolicy", "utils/http.js"],
      ["outboundPost", "utils/http.js"],
      ["parseDateOnly", "utils/timezone.js"],
      ["parserLimits", "services/parser/limits.js"],
      ["passwordInputError", "utils/password.js"],
      ["passwordTooLong", "utils/password.js"],
      ["processLocalCalendarDate", "utils/timezone.js"],
      ["refreshCookieOptions", "config/posture.js"],
      ["requiredFieldsForMode", "services/parser/headers.js"],
      ["resolveIdentities", "services/transactionIdentity.js"],
      ["safeTimezone", "utils/timezone.js"],
      ["scoped", "utils/tenancy.js"],
      ["setRefreshCookie", "utils/authPrimitives.js"],
      ["sha256Hex", "utils/authPrimitives.js"],
      ["transactionLinkOps", "services/menuItems.service.js"],
      ["yieldToEventLoop", "utils/lifecycle.js"],
      ["zonedDateKey", "utils/timezone.js"],
      ["zonedDateTimeToUtc", "utils/timezone.js"],
      ["zonedDayEnd", "utils/timezone.js"],
      ["zonedDayOfWeek", "utils/timezone.js"],
      ["zonedDayOrdinal", "utils/timezone.js"],
      ["zonedDayStart", "utils/timezone.js"],
    ]);
    expect([...RETIRED_NAMES].sort()).toEqual([
      "ACTION_TOKEN_RE",
      "COOKIE_OPTIONS",
      "EMAIL_RE",
      "HOURS_TIME_RE",
      "INVITE_TOKEN_RE",
      "PROFILE_EMAIL_RE",
      "REFRESH_COOKIE_OPTIONS",
      "REQUIRED",
      "REQUIRED_UPLOAD_MAPPING",
      "TIME_RE",
      "VALID_CATEGORIES",
      "addLocalDays",
      "computeDedupKey",
      "duplicateIdentityForRow",
      "findExistingIdentities",
      "generateActionToken",
      "generateInvitationToken",
      "getLocalDateParts",
      "hashActionToken",
      "hashInvitationToken",
      "hashRefreshToken",
      "identityComparisonKey",
      "inclusiveDays",
      "localDateKey",
      "localDayOrdinal",
      "localMidnightUtc",
      "normalizedActionToken",
      "normalizedInvitationToken",
      "receiptIdentityKey",
      "requiredUploadMappingForMode",
      "sha256",
      "storedIdentityKeys",
      "timezoneOffsetMs",
      "transactionIdentity",
      "zonedTimeToUtc",
    ]);
    expect(Object.entries(BARREL_FOLDERS).sort()).toEqual([
      ["controllers/analytics/", "controllers/analytics.controller.js"],
      ["controllers/auth/", "controllers/auth.controller.js"],
      ["controllers/team/", "controllers/team.controller.js"],
      ["controllers/uploads/", "controllers/uploads.controller.js"],
      ["services/ai/", "services/anthropic.service.js"],
      ["services/billing/", "services/billingPayments.service.js"],
      ["services/forecast/", "services/forecast.service.js"],
      ["services/parser/", "services/parser.service.js"],
      ["services/usage/", "services/usage.service.js"],
    ]);
    expect(SOURCE_PATTERNS.map(({ re }) => re.source)).toEqual([
      "\\breq\\??\\.user\\??\\.cafeId\\b",
      "\\.toISOString\\(\\)\\.slice\\(0,\\s*10\\)",
      "\\.getTimezoneOffset\\(",
      "jwt\\.sign\\(",
      "createHash\\('sha256'\\)\\.update\\(String\\(",
      "\\^\\[A-Za-z0-9_-\\]\\{43\\}\\$",
      "\\.cookie\\('refreshToken'",
      "clearCookie\\('refreshToken'",
      "const chunks = \\(values",
      "\\bcode:\\s*(?:err|error)\\??\\.(?:code|publicCode)\\b(?!\\s*(?:\\|\\||\\?\\?))",
    ]);
    expect(BARREL_EXCEPTIONS).toEqual([['server.js', 'services/billing/reminders']]);
    expect(CONSOLE_LOG_ALLOWED).toEqual(['seed.js']);
    const patternAllowEntries = SOURCE_PATTERNS.flatMap(({ allow = [] }) => allow);
    expect(patternAllowEntries).toHaveLength(7);
    expect([...patternAllowEntries, ...CONSOLE_LOG_ALLOWED, ...BARREL_EXCEPTIONS]).toHaveLength(9);
    expect(SOURCE_PATTERNS.map(({ allow, deny }) => ({ allow, deny }))).toEqual([
      { allow: ['utils/tenancy.js'] },
      { deny: ['controllers/'] },
      { deny: ['controllers/'] },
      { allow: ['utils/authPrimitives.js', 'controllers/auth/tokens.js'] },
      { allow: ['utils/authPrimitives.js'] },
      { allow: ['utils/authPrimitives.js'] },
      { allow: ['utils/authPrimitives.js'] },
      { allow: ['utils/authPrimitives.js'] },
      { allow: [] },
      { deny: ['controllers/', 'middleware/', 'services/workforce/errors.js'] },
    ]);
    expect(Object.keys(BARREL_FOLDERS)).toHaveLength(9);
    expect(SOURCE_PATTERNS.map(({ rule }) => rule)).toEqual([
      'req.user.cafeId read outside the tenancy helper',
      'UTC day key in a controller',
      'process-zone offset in a controller',
      'token minted outside the token modules',
      'SHA-256 hasher copy (use sha256Hex)',
      'opaque token pattern copy',
      'refresh cookie set by hand',
      'refresh cookie cleared by hand',
      'chunk helper copy (use chunksOf)',
      'response code forwarded from the error (use refusalBody)',
    ]);
    expect(HELPER_HOMES).toMatchObject({
      isTestEnvironment: 'config/posture.js',
      isDemandLine: 'utils/demand.js',
      outboundGet: 'utils/http.js',
    });
    expect(RETIRED_NAMES).toContain('computeDedupKey');
    expect(declarationViolations('utils/probe.js', 'const computeDedupKey = () => {};'))
      .toEqual([expect.stringContaining('retired name redefined')]);
  });

  it('declares each consolidated helper only in its home, and no retired helper at all', () => {
    expect(all(declarationViolations)).toEqual([]);
  });

  it('keeps each shared rule in its one module (active cafe, day keys, tokens, cookies, chunking)', () => {
    expect(all(patternViolations)).toEqual([]);
  });

  it('reaches a split module only through its barrel, which the tests mock', () => {
    expect(all(barrelViolations)).toEqual([]);
  });

  it('has every home module the table names', () => {
    const missing = [...new Set(Object.values(HELPER_HOMES))].filter((file) => !fs.existsSync(path.join(SRC_ROOT, file)));
    expect(missing).toEqual([]);
  });

  it('would catch a planted copy of each kind, and stays quiet in the homes', () => {
    const probe = [
      'const safeTimezone = (timezone) => timezone;',
      'const hashActionToken = (token) => token;',
      'const cafeOf = (req) => req.user.cafeId;',
      "const insights = require('../services/ai/insights');",
    ].join('\n');
    expect(declarationViolations('utils/probe.js', probe)).toEqual([
      expect.stringContaining('defined outside utils/timezone.js'),
      expect.stringContaining('retired name redefined'),
    ]);
    expect(patternViolations('utils/probe.js', probe)).toEqual([expect.stringContaining('utils/probe.js:3')]);
    expect(barrelViolations('utils/probe.js', probe)).toEqual([expect.stringContaining('services/anthropic.service.js')]);
    expect(declarationViolations('utils/timezone.js', 'const safeTimezone = (timezone) => timezone;')).toEqual([]);
    expect(patternViolations('utils/tenancy.js', 'const activeCafeId = (req) => req?.user?.cafeId ?? null;')).toEqual([]);
    expect(patternViolations('utils/tenancy.js.copy.js', 'module.exports = (req) => req.user.cafeId;'))
      .toEqual([expect.stringContaining('utils/tenancy.js.copy.js:1')]);
    expect(patternViolations('controllers/probe.js', 'const chunks = (values, size) => values;'))
      .toEqual([expect.stringContaining('chunk helper copy')]);
    expect(declarationViolations('utils/probe.js', 'const passwordTooLong = () => false;'))
      .toEqual([expect.stringContaining(`defined outside ${HELPER_HOMES.passwordTooLong}`)]);
    expect(barrelViolations('controllers/probe.js', "module.exports = require('../services/ai/../ai/insights.js');"))
      .toEqual([expect.stringContaining('services/anthropic.service.js')]);
    expect(barrelViolations('services/ai/chat.js', "const { buildBusinessContext } = require('./context');")).toEqual([]);
  });
});

