// Bounds for the analytics endpoints (analytics-ai-9, security-16). Configurable for operations, with hard limits so a
// typo cannot turn a bound off. BE-10-T04 validates these at startup; until then an invalid value falls back to the default.
const DEFAULT_MAX_RANGE_DAYS = 400;
const HARD_MAX_RANGE_DAYS = 1830;
const DEFAULT_QUERY_MAX_TIME_MS = 20000;
const DEFAULT_COMBOS_MAX_BASKETS = 20000;
const COMBO_MAX_ITEMS_PER_BASKET = 20; // 190 pairs per basket at most, instead of 4,950 for a 100-item basket
const MAX_COMBO_FALLBACK_TRANSACTIONS = 5000; // the JS fallback holds these in memory
const MAX_COMBO_FALLBACK_PAIR_WORK = 100000;

const boundedEnvInt = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

const analyticsMaxRangeDays = () => boundedEnvInt('ANALYTICS_MAX_RANGE_DAYS', DEFAULT_MAX_RANGE_DAYS, 7, HARD_MAX_RANGE_DAYS);
const analyticsQueryMaxTimeMs = () => boundedEnvInt('ANALYTICS_QUERY_MAX_TIME_MS', DEFAULT_QUERY_MAX_TIME_MS, 1000, 120000);
const combosMaxBaskets = () => boundedEnvInt('COMBOS_MAX_BASKETS', DEFAULT_COMBOS_MAX_BASKETS, 1, 200000);
const aggregateOptions = () => ({ maxTimeMS: analyticsQueryMaxTimeMs() });

const isQueryTimeout = (error) => error?.code === 50 || error?.codeName === 'MaxTimeMSExpired';

const queryTimeoutError = () => {
  const error = new Error('This range took too long to analyse. Choose a shorter range and try again.');
  error.statusCode = 503;
  // A fixed, product-written sentence and code: both must survive production's 5xx redaction (step 7e).
  error.exposeMessage = true;
  error.exposeDetails = true;
  error.details = { code: 'ANALYTICS_QUERY_TIMEOUT' };
  return error;
};

module.exports = {
  COMBO_MAX_ITEMS_PER_BASKET,
  MAX_COMBO_FALLBACK_TRANSACTIONS,
  MAX_COMBO_FALLBACK_PAIR_WORK,
  analyticsMaxRangeDays,
  analyticsQueryMaxTimeMs,
  combosMaxBaskets,
  aggregateOptions,
  isQueryTimeout,
  queryTimeoutError,
};
