const { chatWriteLimiter } = require('../middleware/rateLimit.middleware');
const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { list, create, getOne, update, remove } = require('../controllers/insightChats.controller');

const router = express.Router();

router.use(authMiddleware);
// Authenticate before allocating a legitimate saved chat's larger JSON body.
router.use(express.json({ limit: '2mb' }));

router.get('/', list);
router.post('/', chatWriteLimiter, create);
router.get('/:id', getOne);
router.patch('/:id', chatWriteLimiter, update);
router.delete('/:id', chatWriteLimiter, remove);

module.exports = router;
