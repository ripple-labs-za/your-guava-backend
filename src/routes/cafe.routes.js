const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const {
  listCafes, getMe, updateMe, getSavedMapping, clearSavedMapping,
} = require('../controllers/cafe.controller');

router.use(authMiddleware);

router.get('/list', listCafes);
router.get('/me', getMe);
// Owner-only: configuration and destructive re-processing (tests/fixtures/rbacTable.js states the whole policy).
router.put('/me', ownerOnly, updateMe);
// The saved column mapping (BE-03-T05): any member may see it; only the owner may make the wizard ask again.
router.get('/me/column-mapping', getSavedMapping);
router.delete('/me/column-mapping', ownerOnly, clearSavedMapping);

module.exports = router;
