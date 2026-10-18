const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const {
  create, list, approve, reject, cancel, getCalendar, getBalances, adjustBalance,
} = require('../controllers/leave.controller');

router.use(authMiddleware);

router.post('/', create);
router.get('/', list);
router.get('/calendar', getCalendar);
router.get('/balances', getBalances);
router.put('/balances/:staffId', ownerOnly, adjustBalance);
router.put('/:id/approve', ownerOnly, approve);
router.put('/:id/reject', ownerOnly, reject);
router.put('/:id/cancel', ownerOnly, cancel);

module.exports = router;
