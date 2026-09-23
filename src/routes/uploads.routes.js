const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const { parseLimiter } = require('../middleware/rateLimit.middleware');
const uploads = require('../controllers/uploads.controller');

const router = express.Router();

router.get('/local-download', uploads.localDownload);
router.get('/', authMiddleware, uploads.list);
router.get('/:id/rows', authMiddleware, uploads.rows);
// Any cafe member may see which uploads share an upload's days; deleting stays owner-only (BE-03-T02).
router.get('/:id/overlaps', authMiddleware, uploads.overlaps);
router.get('/:id', authMiddleware, uploads.detail);
router.post('/:id/confirm', authMiddleware, parseLimiter, uploads.confirm);
// Re-mapping deletes and re-imports the upload: owner-only, like DELETE (security-4, WS-07-T02).
router.patch('/:id/mapping', authMiddleware, ownerOnly, parseLimiter, uploads.remap);
router.delete('/:id', authMiddleware, ownerOnly, uploads.remove);

module.exports = router;
