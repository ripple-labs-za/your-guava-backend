const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { requireCreditSpend } = require('../middleware/rbac.middleware');
const { aiLimiter } = require('../middleware/rateLimit.middleware');
const items = require('../controllers/items.controller');
const { requireActiveCafe } = require('../middleware/requireCafe.middleware');

router.use(authMiddleware);
// A token with no cafe made ObjectId.createFromHexString(null) throw: a 500 instead of a clear 400 (BE-03-T12).
router.use(requireActiveCafe);

router.get('/', items.list);
router.post('/', items.create);
router.get('/reconciliation', items.reconciliation);
router.post(
  '/reconciliation/suggestions',
  requireCreditSpend,
  aiLimiter,
  items.generateReconciliationSuggestions
);
router.put('/:id', items.update);
router.post('/confirm-all-new', items.confirmAllNew);
router.post('/:id/resolve', items.resolve);

module.exports = router;
