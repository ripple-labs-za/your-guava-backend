const { apiCacheEnabled } = require('../config/flags');
const { activeCafeId } = require('../utils/tenancy');
// Process-local response cache for read endpoints (D-005: one instance). Each entry remembers whose data it holds, so a
// write evicts only that cafe's (or organisation's) entries instead of every tenant's (platform-12, forecasting-21).
const cacheStore = new Map();

const normaliseQuery = (query = {}, keyParams = null) =>
  Object.keys(query)
    .filter((key) => key !== 'refresh' && key !== '_')
    .filter((key) => !keyParams || keyParams.includes(key))
    .sort()
    .map((key) => `${key}=${JSON.stringify(query[key])}`)
    .join('&');

const trimCache = (maxEntries) => {
  while (cacheStore.size > maxEntries) {
    const oldestKey = cacheStore.keys().next().value;
    cacheStore.delete(oldestKey);
  }
};

const idOf = (value, fallback) => (value == null || value === '' ? fallback : String(value));

const apiCache = ({ ttlMs = 30000, keyPrefix = 'api', maxEntries = 250, keyParams = null } = {}) => (req, res, next) => {
  if (!apiCacheEnabled() || req.method !== 'GET' || req.query.refresh === 'true') {
    return next();
  }

  const orgId = idOf(req.user?.orgId, 'no-org');
  const cafeId = idOf(activeCafeId(req), 'no-cafe');
  const userId = idOf(req.user?.id, 'no-user');
  const cacheKey = `${keyPrefix}:${orgId}:${cafeId}:${userId}:${req.baseUrl}${req.path}?${normaliseQuery(req.query, keyParams)}`;
  const cached = cacheStore.get(cacheKey);

  if (cached && Date.now() - cached.cachedAt < ttlMs) {
    res.set('X-Guava-Cache', 'hit');
    return res.status(cached.statusCode).json(cached.body);
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      cacheStore.set(cacheKey, { statusCode: res.statusCode, body, cachedAt: Date.now(), keyPrefix, orgId, cafeId });
      trimCache(maxEntries);
      res.set('X-Guava-Cache', 'miss');
    }
    return originalJson(body);
  };

  return next();
};

/**
 * Evict the cached responses of one cafe or one organisation, optionally for one key prefix only. There is deliberately
 * no "evict everything": one tenant's write must not cost every other tenant its cache, and no request path, least of all
 * an unauthenticated payment callback, may flush it (billing-13).
 * @param {{ cafeId?: unknown, orgId?: unknown, keyPrefix?: string }} scope ids may be strings or ObjectIds
 * @returns {number} entries evicted
 */
const clearApiCache = (scope) => {
  const cafeId = scope?.cafeId != null ? String(scope.cafeId) : null;
  const orgId = scope?.orgId != null ? String(scope.orgId) : null;
  if (!cafeId && !orgId) {
    throw new TypeError('clearApiCache needs { cafeId } or { orgId }: a global flush would evict every tenant');
  }
  const keyPrefix = scope.keyPrefix || null;
  let evicted = 0;
  for (const [key, entry] of cacheStore) {
    if (cafeId && entry.cafeId !== cafeId) continue;
    if (orgId && entry.orgId !== orgId) continue;
    if (keyPrefix && entry.keyPrefix !== keyPrefix) continue;
    cacheStore.delete(key);
    evicted += 1;
  }
  return evicted;
};

module.exports = { apiCache, clearApiCache };
