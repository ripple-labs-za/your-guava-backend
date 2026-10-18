const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { apiCache } = require('../middleware/cache.middleware');
const { requireActiveCafe } = require('../middleware/requireCafe.middleware');
const analytics = require('../controllers/analytics.controller');
const { analyticsLimiter, analyticsRefreshLimiter } = require('../middleware/rateLimit.middleware');

router.use(authMiddleware);
router.use(requireActiveCafe);
router.use(analyticsLimiter, analyticsRefreshLimiter);

const analyticsCache = apiCache({ ttlMs: 60000, keyPrefix: 'analytics', keyParams: ['startDate', 'endDate', 'period', 'days'] });

router.get('/revenue', analyticsCache, analytics.getRevenue);
router.get('/items', analyticsCache, analytics.getItems);
router.get('/heatmap', analyticsCache, analytics.getHeatmap);
router.get('/customers', analyticsCache, analytics.getCustomers);
router.get('/combos', analyticsCache, analytics.getCombos);

module.exports = router;
