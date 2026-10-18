const { clearApiCache } = require('../middleware/cache.middleware');
const axios = require('axios');
const crypto = require('crypto');
const Cafe = require('../models/Cafe.model');
const Transaction = require('../models/Transaction.model');
const {
  rebuildItemsForCafe,
  reconcileTransactionItems,
} = require('./menuItems.service');
const { encryptSecret, decryptSecret } = require('./secrets.service');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_TIMESTAMP_TOLERANCE_S = 5 * 60;

// --- OAuth state (CSRF protection) ---

const signOAuthState = (cafeId, expiresAt) =>
  crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`yoco-oauth.${cafeId}.${expiresAt}`)
    .digest('base64url');

/**
 * Builds an HMAC-signed OAuth state value bound to the cafe.
 * Format: <cafeId>.<expiresAtMs>.<signature>
 */
function createOAuthState(cafeId) {
  const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
  return `${cafeId}.${expiresAt}.${signOAuthState(cafeId, expiresAt)}`;
}

/**
 * Verifies an OAuth state value and that it belongs to the given cafe.
 * @returns {boolean}
 */
function verifyOAuthState(state, cafeId) {
  if (typeof state !== 'string') return false;
  const [stateCafeId, expiresAt, sig] = state.split('.');
  if (!stateCafeId || !expiresAt || !sig) return false;
  if (stateCafeId !== String(cafeId)) return false;
  if (Number(expiresAt) < Date.now()) return false;

  const expected = signOAuthState(stateCafeId, expiresAt);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');
  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// --- Webhook signature verification (svix-compatible scheme used by Yoco) ---

/**
 * Verifies the webhook-id/webhook-timestamp/webhook-signature headers
 * against the raw request body using YOCO_WEBHOOK_SECRET.
 * @param {object} req – Express request with req.rawBody populated
 * @returns {{valid: boolean, reason?: string}}
 */
function verifyWebhookSignature(req) {
  const secret = process.env.YOCO_WEBHOOK_SECRET;
  if (!secret) {
    return { valid: false, reason: 'YOCO_WEBHOOK_SECRET not configured' };
  }

  const id = req.headers['webhook-id'];
  const timestamp = req.headers['webhook-timestamp'];
  const signatureHeader = req.headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader || !req.rawBody) {
    return { valid: false, reason: 'Missing webhook signature headers' };
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_S) {
    return { valid: false, reason: 'Webhook timestamp outside tolerance' };
  }

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${req.rawBody.toString('utf8')}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');

  // Header may contain several space-separated "v1,<sig>" entries (key rotation).
  // Compare against all candidates without short-circuiting so timing does not
  // leak which entry matched.
  const candidates = String(signatureHeader)
    .split(' ')
    .map((part) => (part.includes(',') ? part.split(',')[1] : part))
    .filter(Boolean);

  let valid = false;
  for (const candidate of candidates) {
    const candidateBuf = Buffer.from(candidate, 'base64');
    if (candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf)) {
      valid = true;
    }
  }

  return valid ? { valid: true } : { valid: false, reason: 'Signature mismatch' };
}

// --- OAuth ---

/**
 * Build the Yoco OAuth authorization URL.
 * @param {string} state – opaque value returned after auth (we use cafeId)
 * @returns {string}
 */
function getAuthorizationUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.YOCO_CLIENT_ID,
    redirect_uri: process.env.YOCO_REDIRECT_URI,
    response_type: 'code',
    scope:
      'business/orders:read business/locations:read application/webhooks:read application/webhooks:write offline_access openid',
    state,
  });
  return `${process.env.YOCO_IAM_URL}/oauth2/auth?${params}`;
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number, token_type: string}>}
 */
async function exchangeCode(code) {
  const { data } = await axios.post(
    `${process.env.YOCO_IAM_URL}/oauth2/token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.YOCO_REDIRECT_URI,
      client_id: process.env.YOCO_CLIENT_ID,
      client_secret: process.env.YOCO_CLIENT_SECRET,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

/**
 * Refresh an expired access token.
 * @param {string} refreshToken
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
 */
async function refreshAccessToken(refreshToken) {
  const { data } = await axios.post(
    `${process.env.YOCO_IAM_URL}/oauth2/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.YOCO_CLIENT_ID,
      client_secret: process.env.YOCO_CLIENT_SECRET,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

// --- API Calls ---

/**
 * Return a valid access token for the given cafe, refreshing if expired.
 * @param {object} cafe – Mongoose Cafe document
 * @returns {Promise<string>}
 */
async function getValidToken(cafe) {
  if (!cafe.yocoTokens?.accessToken) throw new Error('Yoco not connected');

  const now = new Date();
  if (cafe.yocoTokens.expiresAt && cafe.yocoTokens.expiresAt > now) {
    return decryptSecret(cafe.yocoTokens.accessToken);
  }

  // Token expired — refresh it
  const tokens = await refreshAccessToken(decryptSecret(cafe.yocoTokens.refreshToken));
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await Cafe.findByIdAndUpdate(cafe._id, {
    $set: {
      'yocoTokens.accessToken': encryptSecret(tokens.access_token),
      'yocoTokens.refreshToken': encryptSecret(tokens.refresh_token) || cafe.yocoTokens.refreshToken,
      'yocoTokens.expiresAt': expiresAt,
    },
  });

  return tokens.access_token;
}

/**
 * Fetch a single page of orders from the Yoco API.
 * @param {string} accessToken
 * @param {object} params – query params (cursor, limit, created_at__gte, etc.)
 * @returns {Promise<{data: object[], next_cursor: string|null}>}
 */
async function fetchOrders(accessToken, params = {}) {
  const { data } = await axios.get(`${process.env.YOCO_API_URL}/v1/orders/`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { limit: 50, status: 'completed', ...params },
  });
  return data;
}

/**
 * Fetch all orders between two dates, paginating through every page.
 * @param {string} accessToken
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<object[]>}
 */
async function fetchAllOrders(accessToken, startDate, endDate) {
  const allOrders = [];
  let cursor = null;

  do {
    const params = {
      created_at__gte: startDate.toISOString(),
      created_at__lte: endDate.toISOString(),
      status: 'completed',
    };
    if (cursor) params.cursor = cursor;

    const result = await fetchOrders(accessToken, params);
    allOrders.push(...(result.data || []));
    cursor = result.next_cursor;
  } while (cursor);

  return allOrders;
}

// --- Data Sync ---

/**
 * Convert Yoco orders to Transaction documents and upsert them.
 * Also updates menu item totals.
 * @param {string} cafeId
 * @param {object[]} orders – raw Yoco order objects
 * @returns {Promise<{imported: number, skipped: number, errors: number}>}
 */
async function syncOrders(cafeId, orders) {
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of orders) {
    try {
      if (!order.line_items || order.line_items.length === 0) {
        skipped++;
        continue;
      }

      const createdAt = new Date(order.created_at || order.closed_at);
      const hour = createdAt.getHours();
      const dayOfWeek = createdAt.getDay();

      // Convert line items — amounts are in cents
      const items = order.line_items
        .filter((li) => li.item_type === 'product' || li.item_type === 'custom_amount')
        .map((li) => ({
          name: li.name || 'Unknown Item',
          quantity: Math.round(li.quantity) || 1,
          unitPrice: li.unit_price ? li.unit_price.amount / 100 : 0,
        }));

      if (items.length === 0) {
        skipped++;
        continue;
      }
      const reconciledItems = await reconcileTransactionItems(cafeId, items);

      const total = order.amounts?.gross_amount ? order.amounts.gross_amount.amount / 100 : 0;
      const tip = order.amounts?.tip_amount ? order.amounts.tip_amount.amount / 100 : 0;
      const discount = order.amounts?.discount_amount
        ? order.amounts.discount_amount.amount / 100
        : 0;

      const paymentMethod = order.payments?.[0]?.payment_method || 'unknown';

      // Use Yoco order ID as receiptId
      const receiptId = order.id || order.order_number;

      const result = await Transaction.findOneAndUpdate(
        { cafeId, receiptId },
        {
          $setOnInsert: {
            cafeId,
            receiptId,
            date: createdAt,
            hour,
            dayOfWeek,
            status: 'approved',
            paymentMethod,
            items: reconciledItems,
            total,
            tip,
            discount,
            source: 'api',
          },
        },
        { upsert: true, new: false }
      );

      if (result === null) {
        imported++;
      } else {
        skipped++;
      }
    } catch (err) {
      if (err.code === 11000) {
        skipped++;
      } else {
        console.error('[yoco sync] Order error:', err.message);
        errors++;
      }
    }
  }

  await rebuildItemsForCafe(cafeId);
  if (imported > 0) clearApiCache({ cafeId });

  return { imported, skipped, errors };
}

// --- Webhook ---

/**
 * Register a webhook subscription with Yoco.
 * @param {string} accessToken
 * @param {string} webhookUrl – public URL that Yoco will POST to
 * @returns {Promise<object>}
 */
async function subscribeWebhook(accessToken, webhookUrl) {
  const { data } = await axios.post(
    `${process.env.YOCO_API_URL}/v1/webhooks/subscriptions/`,
    {
      name: 'Your Guava Transaction Sync',
      url: webhookUrl,
      event_types: ['payment.created'],
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return data;
}

/**
 * Handle a payment.created webhook event from Yoco.
 * Fetches the full order and syncs it into our database.
 * @param {object} payload – webhook request body
 */
async function processWebhookEvent(payload) {
  const { business_id, order_id, event_type } = payload;

  if (event_type !== 'payment.created' || !order_id) return;

  // Find the cafe by yocoBusinessId
  const cafe = await Cafe.findOne({ yocoBusinessId: business_id }).select(
    '+yocoTokens.accessToken +yocoTokens.refreshToken'
  );
  if (!cafe) {
    console.warn(`[yoco webhook] No cafe found for business_id: ${business_id}`);
    return;
  }

  const token = await getValidToken(cafe);

  // Fetch the full order with line items
  const { data: order } = await axios.get(
    `${process.env.YOCO_API_URL}/v1/orders/${order_id}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const result = await syncOrders(cafe._id, [order]);
  console.log(`[yoco webhook] Synced order ${order_id}: ${result.imported} imported`);

  // Update last sync time
  await Cafe.findByIdAndUpdate(cafe._id, { lastSyncAt: new Date() });
}

module.exports = {
  getAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  getValidToken,
  fetchOrders,
  fetchAllOrders,
  syncOrders,
  subscribeWebhook,
  processWebhookEvent,
  createOAuthState,
  verifyOAuthState,
  verifyWebhookSignature,
};
