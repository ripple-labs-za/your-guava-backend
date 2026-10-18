const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly, requireCreditSpend } = require('../middleware/rbac.middleware');
const { aiLimiter, forecastComputeLimiter } = require('../middleware/rateLimit.middleware');
const { apiCache } = require('../middleware/cache.middleware');
const {
  getToday,
  getTomorrow,
  getWeek,
  generate,
  getFactors,
  updateFactors,
  getAccuracy,
  getHistory,
  getRecent,
} = require('../controllers/forecasts.controller');
const {
  getInsights,
  refreshGeneratedInsights,
  chatInsights,
  streamChatInsights,
} = require('../controllers/askGuava.controller');

router.use(authMiddleware);

const forecastCache = apiCache({ ttlMs: 30000, keyPrefix: 'forecasts' });
const historyCache = apiCache({ ttlMs: 10000, keyPrefix: 'forecast-history' });
const cacheHistoryReads = (req, res, next) => (
  req.query.backfill === 'sync' ? next() : historyCache(req, res, next)
);

router.get('/today', forecastCache, getToday);
router.get('/tomorrow', forecastCache, getTomorrow);
router.get('/week', forecastCache, getWeek);
router.get('/recent', forecastCache, getRecent);
const limitBackfillCompute = (req, res, next) => {
  if (req.query.backfill !== 'sync') return next();
  return requireCreditSpend(req, res, () => forecastComputeLimiter(req, res, next));
};
router.get('/history', cacheHistoryReads, limitBackfillCompute, getHistory);
router.get('/factors', getFactors);
// Owner-only: configuration and destructive re-processing (tests/fixtures/rbacTable.js states the whole policy).
router.put('/factors', ownerOnly, updateFactors);
router.post('/generate', ownerOnly, forecastComputeLimiter, generate);
router.get('/accuracy', getAccuracy);
router.get('/insights', getInsights);
router.post('/insights/refresh', requireCreditSpend, aiLimiter, refreshGeneratedInsights);
router.post('/insights/chat', requireCreditSpend, aiLimiter, chatInsights);
router.post('/insights/chat/stream', requireCreditSpend, aiLimiter, streamChatInsights);

module.exports = router;
