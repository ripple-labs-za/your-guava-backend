const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const { parseLimiter } = require('../middleware/rateLimit.middleware');
const uploads = require('../controllers/uploads.controller');
const { requireActiveCafe } = require('../middleware/requireCafe.middleware');

const router = express.Router();
// Every route but the signed, unauthenticated local download is cafe-scoped (BE-03-T12).
const cafe = [authMiddleware, requireActiveCafe];

router.get('/local-download', uploads.localDownload);
router.get('/', ...cafe, uploads.list);
router.get('/:id/rows', ...cafe, uploads.rows);
// Any cafe member may see which uploads share an upload's days; deleting stays owner-only (BE-03-T02).
router.get('/:id/overlaps', ...cafe, uploads.overlaps);
router.get('/:id', ...cafe, uploads.detail);
router.post('/:id/confirm', ...cafe, parseLimiter, uploads.confirm);
// Re-mapping deletes and re-imports the upload: owner-only, like DELETE (security-4, WS-07-T02).
router.patch('/:id/mapping', ...cafe, ownerOnly, parseLimiter, uploads.remap);
router.delete('/:id', ...cafe, ownerOnly, uploads.remove);

module.exports = router;
