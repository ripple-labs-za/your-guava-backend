/**
 * The structure contract of src/ (BE-11-T07), enforced by tests/unit/sourceHygiene.test.js.
 *
 * BE-11 split the ten files over 800 lines and gave every helper that had been copied
 * between files one home (BE-11-T05). This table keeps it that way:
 *   HELPER_HOMES     a name may be declared at the top level only in its home file
 *   RETIRED_NAMES    old names of consolidated helpers; declared nowhere
 *   SOURCE_PATTERNS  a pattern may appear only where it is allowed
 *   BARREL_FOLDERS   code outside a split folder reaches it only through the barrel,
 *                    because the tests mock and spy on the barrels
 * Adding a shared helper or a split folder? Add its row here in the same commit.
 * It mirrors backend-90/02-build/BE-11-code-structure/tools/one-definition.cjs.
 * Paths are relative to src/ with forward slashes.
 */
const fs = require('fs');
const path = require('path');

const SRC_ROOT = path.resolve(__dirname, '../../src');
const exists = (relative) => fs.existsSync(path.join(SRC_ROOT, relative));
const mentions = (relative, text) => exists(relative) && fs.readFileSync(path.join(SRC_ROOT, relative), 'utf8').includes(text);

const MAX_SOURCE_LINES = 800;

// The seed script prints its progress for a person at a terminal; everything else logs through utils/logger.js (BE-10-T03).
const CONSOLE_LOG_ALLOWED = ['seed.js'];

// Password rules belong to utils/password.js (BE-02-T02) and refresh-cookie flags to config/posture.js
// (BE-02-T06); when either card was skipped, BE-11-T05 put them in utils/authPrimitives.js instead.
const PASSWORD_HOME = exists('utils/password.js') ? 'utils/password.js' : 'utils/authPrimitives.js';
const COOKIE_HOME = mentions('config/posture.js', 'refreshCookieOptions') ? 'config/posture.js' : 'utils/authPrimitives.js';

const home = (file, names) => Object.fromEntries(names.map((name) => [name, file]));
// Shared modules later cards create: guarded once they exist.
const homeIfPresent = (file, names) => (exists(file) ? home(file, names) : {});

const HELPER_HOMES = {
  ...home('utils/timezone.js', [
    'DEFAULT_TIMEZONE', 'DATE_ONLY_RE', 'TIME_OF_DAY_RE', 'safeTimezone', 'getTimeZoneOffsetMs', 'zonedDateTimeToUtc',
    'getZonedDateParts', 'dateOnlyParts', 'addDatePartsDays', 'zonedDayStart', 'zonedDayEnd', 'addZonedDays', 'zonedDayOrdinal',
    'zonedDateKey', 'zonedDayOfWeek', 'processLocalCalendarDate', 'getCafeTimezone', 'parseDateOnly', 'formatDateOnly',
    'inclusiveDateOnlyDays', 'cafeLocalToday',
  ]),
  ...home('services/transactionIdentity.js', [
    'chunksOf',
    'contentSignature', 'contentKey', 'resolveIdentities',
  ]),
  ...home('utils/authPrimitives.js', [
    'OPAQUE_TOKEN_RE', 'generateOpaqueToken', 'normalizedOpaqueToken', 'sha256Hex', 'REFRESH_COOKIE_NAME', 'setRefreshCookie',
    'clearRefreshCookie', 'generateAccessToken',
  ]),
  ...home(PASSWORD_HOME, ['MIN_PASSWORD_LENGTH', 'MAX_PASSWORD_BYTES', 'passwordTooLong', 'passwordInputError', 'hashPassword']),
  ...home(COOKIE_HOME, ['refreshCookieOptions', 'REFRESH_COOKIE_MAX_AGE_MS']),
  ...homeIfPresent('config/posture.js', ['isTestEnvironment', 'isRelaxedEnvironment', 'isHardenedEnvironment']),
  ...home('utils/email.js', ['EMAIL_MAX_LENGTH', 'isValidEmail']),
  ...home('utils/tenancy.js', ['activeCafeId', 'scoped']),
  ...home('services/parser/limits.js', ['boundedInteger', 'parserLimits', 'createClientInputError']),
  ...home('services/parser/rowErrors.js', ['MAX_ROW_ERRORS', 'SOURCE_ROW_NUMBERS']),
  ...home('services/parser/headers.js', ['REQUIRED_FIELDS', 'requiredFieldsForMode']),
  ...home('services/parser/parse.js', ['VALID_ITEMS_MODES']),
  ...home('utils/itemCategory.js', ['ITEM_CATEGORIES', 'isItemCategory']),
  ...homeIfPresent('utils/demand.js', [
    'IGNORED_LINE_STATUS', 'isDemandLine', 'demandLines', 'DEMAND_LINE_MATCH', 'demandItemsExpression',
  ]),
  ...homeIfPresent('utils/http.js', ['OUTBOUND_SERVICES', 'outboundPolicy', 'outboundGet', 'outboundPost']),
};

// The names the copies had before BE-11-T05 gave them one home.
const RETIRED_NAMES = [
  // BE-11-T06 (056dfaf) removed the old key helpers; content-v1 resolves old rows too.
  'transactionIdentity', 'identityComparisonKey', 'storedIdentityKeys', 'findExistingIdentities',
  'zonedTimeToUtc', 'getLocalDateParts', 'addLocalDays', 'localDayOrdinal', 'localDateKey', 'timezoneOffsetMs',
  'localMidnightUtc', 'inclusiveDays', 'TIME_RE', 'HOURS_TIME_RE', 'duplicateIdentityForRow', 'receiptIdentityKey',
  'hashRefreshToken', 'hashActionToken', 'hashInvitationToken', 'generateActionToken', 'generateInvitationToken',
  'normalizedActionToken', 'normalizedInvitationToken', 'ACTION_TOKEN_RE', 'INVITE_TOKEN_RE', 'COOKIE_OPTIONS',
  'REFRESH_COOKIE_OPTIONS', 'EMAIL_RE', 'PROFILE_EMAIL_RE', 'sha256', 'REQUIRED', 'REQUIRED_UPLOAD_MAPPING',
  'requiredUploadMappingForMode', 'VALID_CATEGORIES',
];

const SOURCE_PATTERNS = [
  { rule: 'req.user.cafeId read outside the tenancy helper', re: /\breq\??\.user\??\.cafeId\b/, allow: ['utils/tenancy.js'] },
  { rule: 'UTC day key in a controller', re: /\.toISOString\(\)\.slice\(0,\s*10\)/, deny: ['controllers/'] },
  { rule: 'process-zone offset in a controller', re: /\.getTimezoneOffset\(/, deny: ['controllers/'] },
  { rule: 'token minted outside the token modules', re: /jwt\.sign\(/, allow: ['utils/authPrimitives.js', 'controllers/auth/tokens.js'] },
  { rule: 'SHA-256 hasher copy (use sha256Hex)', re: /createHash\('sha256'\)\.update\(String\(/, allow: ['utils/authPrimitives.js'] },
  { rule: 'opaque token pattern copy', re: /\^\[A-Za-z0-9_-\]\{43\}\$/, allow: ['utils/authPrimitives.js'] },
  { rule: 'refresh cookie set by hand', re: /\.cookie\('refreshToken'/, allow: ['utils/authPrimitives.js'] },
  { rule: 'refresh cookie cleared by hand', re: /clearCookie\('refreshToken'/, allow: ['utils/authPrimitives.js'] },
  { rule: 'chunk helper copy (use chunksOf)', re: /const chunks = \(values/, allow: [] },
];

const BARREL_FOLDERS = {
  'services/parser/': 'services/parser.service.js',
  'services/ai/': 'services/anthropic.service.js',
  'services/usage/': 'services/usage.service.js',
  'services/billing/': 'services/billingPayments.service.js',
  'services/forecast/': 'services/forecast.service.js',
  'controllers/uploads/': 'controllers/uploads.controller.js',
  'controllers/team/': 'controllers/team.controller.js',
  'controllers/auth/': 'controllers/auth.controller.js',
  'controllers/analytics/': 'controllers/analytics.controller.js',
};

// [requiring file, required module without .js]: allowed past a barrel, each with its reason.
const BARREL_EXCEPTIONS = [
  // BE-07-T03: server.js schedules the billing reminder job beside the other jobs; no test mocks it via the barrel.
  ['server.js', 'services/billing/reminders'],
];

module.exports = {
  MAX_SOURCE_LINES,
  CONSOLE_LOG_ALLOWED,
  HELPER_HOMES,
  RETIRED_NAMES,
  SOURCE_PATTERNS,
  BARREL_FOLDERS,
  BARREL_EXCEPTIONS,
};

