const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
// Connecting, syncing and disconnecting the POS are owner-only, like the accounting integrations (billing-5).
const { ownerOnly } = require('../middleware/rbac.middleware');
const Cafe = require('../models/Cafe.model');
const {
  getAuthorizationUrl,
  exchangeCode,
  getValidToken,
  fetchAllOrders,
  parseSyncRange,
  syncOrders,
  subscribeWebhook,
  processWebhookEvent,
  createOAuthState,
  verifyOAuthState,
  verifyWebhookSignature,
} = require('../services/yoco.service');
const { encryptSecret } = require('../services/secrets.service');
const { activeCafeId } = require('../utils/tenancy');

// GET /api/yoco/auth — Get OAuth authorization URL
router.get('/auth', authMiddleware, ownerOnly, (req, res) => {
  const state = createOAuthState(activeCafeId(req));
  const url = getAuthorizationUrl(state);
  res.json({ success: true, url });
});

// POST /api/yoco/callback — Exchange OAuth code for tokens
router.post('/callback', authMiddleware, ownerOnly, async (req, res, next) => {
  try {
    const { code, state } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Authorization code required' });
    }
    if (!verifyOAuthState(state, activeCafeId(req))) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OAuth state' });
    }

    const tokens = await exchangeCode(code);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await Cafe.findByIdAndUpdate(activeCafeId(req), {
      $set: {
        yocoConnected: true,
        'yocoTokens.accessToken': encryptSecret(tokens.access_token),
        'yocoTokens.refreshToken': encryptSecret(tokens.refresh_token),
        'yocoTokens.expiresAt': expiresAt,
      },
    });

    res.json({ success: true, message: 'Yoco connected successfully' });
  } catch (error) {
    next(error);
  }
});

// GET /api/yoco/status — Check connection status
router.get('/status', authMiddleware, async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(activeCafeId(req)).select(
      'yocoConnected lastSyncAt yocoTokens.expiresAt'
    );
    res.json({
      success: true,
      connected: cafe?.yocoConnected || false,
      lastSyncAt: cafe?.lastSyncAt || null,
      tokenExpiresAt: cafe?.yocoTokens?.expiresAt || null,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/yoco/sync — Manual full sync (pull all historical orders)
router.post('/sync', authMiddleware, ownerOnly, async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(activeCafeId(req)).select(
      '+yocoTokens.accessToken +yocoTokens.refreshToken'
    );
    if (!cafe?.yocoConnected) {
      return res.status(400).json({ success: false, message: 'Yoco not connected' });
    }

    const range = parseSyncRange(req.body);
    if (range.error) {
      return res.status(400).json({ success: false, code: 'INVALID_SYNC_RANGE', message: range.error });
    }
    const token = await getValidToken(cafe);
    const { orders, pages, truncated } = await fetchAllOrders(token, range.start, range.end);
    const result = await syncOrders(cafe._id, orders);

    // Update cafe
    await Cafe.findByIdAndUpdate(cafe._id, {
      dataUploaded: true,
      lastSyncAt: new Date(),
    });

    res.json({
      success: true,
      ...result,
      totalOrders: orders.length,
      pages,
      truncated,
      dateRange: { start: range.start.toISOString(), end: range.end.toISOString() },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/yoco/webhook — Webhook handler (no auth — called by Yoco, signature-verified)
router.post('/webhook', async (req, res) => {
  const verification = verifyWebhookSignature(req);
  if (!verification.valid) {
    console.warn(`[yoco webhook] Rejected: ${verification.reason}`);
    return res.status(401).json({ received: false, message: 'Invalid webhook signature' });
  }

  // Respond quickly to Yoco (must respond within 15s), then process asynchronously
  res.status(200).json({ received: true });
  processWebhookEvent(req.body).catch((err) => {
    console.error('[yoco webhook] Processing error:', err.message);
  });
});

// POST /api/yoco/disconnect — Disconnect Yoco
router.post('/disconnect', authMiddleware, ownerOnly, async (req, res, next) => {
  try {
    await Cafe.findByIdAndUpdate(activeCafeId(req), {
      $set: { yocoConnected: false },
      $unset: { yocoTokens: 1, yocoBusinessId: 1 },
    });
    res.json({ success: true, message: 'Yoco disconnected' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
