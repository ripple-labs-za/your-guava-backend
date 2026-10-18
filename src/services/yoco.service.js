const logger = require('../utils/logger');
const { safeTimezone, getZonedDateParts, zonedDayOfWeek } = require('../utils/timezone');
const { invalidateDerivedViews } = require('./postImport.service');
const { outboundGet, outboundPost } = require('../utils/http');
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
  const { data } = await outboundPost('yoco',
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
  const { data } = await outboundPost('yoco',
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
    return Cafe.readSecret(cafe, 'yocoTokens.accessToken');
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
async function fetchOrders(accessToken, params = {}, { signal } = {}) {
  signal?.throwIfAborted();
  const { data } = await outboundGet('yoco', `${process.env.YOCO_API_URL}/v1/orders/`, {
    signal,
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { limit: 50, status: 'completed', ...params },
  });
  return data;
}

const YOCO_DEFAULT_MAX_PAGES = 200;
const YOCO_MAX_PAGES_CEILING = 2000;
const yocoMaxPages = () => {
  const configured = Number.parseInt(process.env.YOCO_SYNC_MAX_PAGES, 10);
  if (!Number.isFinite(configured)) return YOCO_DEFAULT_MAX_PAGES;
  return Math.max(1, Math.min(configured, YOCO_MAX_PAGES_CEILING));
};

/** Fetch a bounded number of pages and report any truncation to the caller. */
async function fetchAllOrders(accessToken, startDate, endDate, { signal, onPage } = {}) {
  const maxPages = yocoMaxPages();
  const orders = [];
  const seenCursors = new Set();
  let cursor = null;
  let pages = 0;
  let truncated = null;

  do {
    signal?.throwIfAborted();
    if (pages >= maxPages) {
      truncated = 'page_limit';
      break;
    }
    const params = {
      created_at__gte: startDate.toISOString(),
      created_at__lte: endDate.toISOString(),
      status: 'completed',
    };
    if (cursor) params.cursor = cursor;

    const result = await fetchOrders(accessToken, params, { signal });
    signal?.throwIfAborted();
    pages += 1;
    const pageOrders = Array.isArray(result?.data) ? result.data : [];
    if (onPage) await onPage(pageOrders, pages);
    else orders.push(...pageOrders);
    cursor = typeof result?.next_cursor === 'string' && result.next_cursor ? result.next_cursor : null;
    if (cursor && seenCursors.has(cursor)) {
      truncated = 'cursor_repeated';
      break;
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  if (truncated) {
    logger.warn('yoco_sync_truncated', { reason: truncated, pages });
  }
  return { orders, pages, truncated };
}

// A manual history import has many bounded provider calls and gets its own
// overall budget. Every completed page is committed before the next is fetched.
const yocoSyncTotalMs = () => {
  const raw = process.env.YOCO_SYNC_TOTAL_MS;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 120000;
  return Math.max(100, Math.min(Number(raw), 600000));
};

async function syncHistory(cafe, range) {
  const controller = new AbortController();
  const { signal } = controller;
  const progress = { imported: 0, skipped: 0, errors: 0, totalOrders: 0, pages: 0, lastDateCovered: null };
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('Yoco sync did not finish in time. Retry to continue importing your orders.'), {
        code: 'UPSTREAM_TIMEOUT', statusCode: 504, exposeMessage: true,
      });
      controller.abort(error);
      reject(error);
    }, yocoSyncTotalMs());
    timer.unref?.();
  });
  const work = async () => {
    const token = await getValidToken(cafe);
    signal.throwIfAborted();
    const { truncated } = await fetchAllOrders(token, range.start, range.end, {
      signal,
      onPage: async (orders, pages) => {
        const synced = await syncOrders(cafe._id, orders, { signal });
        for (const key of ['imported', 'skipped', 'errors']) progress[key] += synced[key];
        progress.totalOrders += orders.length;
        progress.pages = pages;
        const last = orders.at(-1);
        const date = new Date(last?.created_at || last?.closed_at);
        if (!Number.isNaN(date.getTime())) progress.lastDateCovered = date.toISOString();
      },
    });
    signal.throwIfAborted();
    await Cafe.findByIdAndUpdate(cafe._id, { dataUploaded: true, lastSyncAt: new Date() });
    return { ...progress, truncated };
  };
  try {
    return await Promise.race([work(), deadline]);
  } catch (error) {
    if (error.code === 'UPSTREAM_TIMEOUT') error.syncProgress = { ...progress, truncated: 'deadline' };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_DAYS = 180;
const MAX_SYNC_DAYS = 366;

const parseSyncDate = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > 40) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Validate a manual sync range before any token refresh or provider call. */
function parseSyncRange(body, now = new Date()) {
  const end = parseSyncDate(body?.endDate, now);
  const start = end && parseSyncDate(body?.startDate, new Date(end.getTime() - DEFAULT_SYNC_DAYS * DAY_MS));
  if (!start || !end) return { error: 'startDate and endDate must be valid dates' };
  if (start > end) return { error: 'startDate must be on or before endDate' };
  if (end.getTime() - start.getTime() > MAX_SYNC_DAYS * DAY_MS) {
    return { error: `A sync can cover at most ${MAX_SYNC_DAYS} days` };
  }
  return { start, end };
}

// --- Data Sync ---

/**
 * Convert Yoco orders to Transaction documents and upsert them.
 * Also updates menu item totals.
 * @param {string} cafeId
 * @param {object[]} orders – raw Yoco order objects
 * @returns {Promise<{imported: number, skipped: number, errors: number}>}
 */
async function syncOrders(cafeId, orders, { signal } = {}) {
  signal?.throwIfAborted();
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  const timezone = safeTimezone(cafe?.timezone);
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    for (const order of orders) {
      signal?.throwIfAborted();
      try {
        if (!order.line_items || order.line_items.length === 0) {
          skipped++;
          continue;
        }

        const createdAt = new Date(order.created_at || order.closed_at);
        if (Number.isNaN(createdAt.getTime())) {
          errors++;
          continue;
        }
        const { hour } = getZonedDateParts(createdAt, timezone);
        const dayOfWeek = zonedDayOfWeek(createdAt, timezone);

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

        signal?.throwIfAborted();
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
        signal?.throwIfAborted();
        if (err.code === 11000) {
          skipped++;
        } else {
          logger.error('yoco_order_sync_failed', logger.errorFields(err));
          errors++;
        }
      }
    }

  } finally {
    // Cancellation can stop a partial sync. The rows already committed must still
    // refresh the menu and derived views before this task finishes.
    try {
      await rebuildItemsForCafe(cafeId);
    } finally {
      if (imported > 0) {
        try {
          await invalidateDerivedViews(cafeId);
        } catch (error) {
          // Committed rows stay imported even when refreshing a derived view fails.
          logger.error('yoco_derived_invalidation_failed', { cafeId: String(cafeId), ...logger.errorFields(error) });
        }
      }
    }
  }

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
  const { data } = await outboundPost('yoco',
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
async function processWebhookEvent(payload = {}) {
  const { business_id: businessId, order_id: orderId, event_type: eventType } = payload || {};
  if (eventType !== 'payment.created' || !isYocoId(orderId)) return { status: 'ignored' };
  if (!isYocoId(businessId)) {
    logger.warn('yoco_webhook_rejected', { reason: 'missing_business_id' });
    return { status: 'rejected', reason: 'missing_business_id' };
  }
  const cafes = await Cafe.find({ yocoBusinessId: businessId, yocoConnected: true, archivedAt: null })
    .select('+yocoTokens.accessToken +yocoTokens.refreshToken')
    .limit(2);
  if (cafes.length !== 1) {
    logger.warn('yoco_webhook_unrouted', { reason: cafes.length ? 'ambiguous_business_id' : 'no_connected_cafe' });
    return { status: 'unrouted', matches: cafes.length };
  }
  const [cafe] = cafes;

  const token = await getValidToken(cafe);

  // Fetch the full order with line items
  const { data: order } = await outboundGet('yoco',
    `${process.env.YOCO_API_URL}/v1/orders/${encodeURIComponent(orderId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const result = await syncOrders(cafe._id, [order]);
  logger.info('yoco_webhook_synced', { orderId, imported: result.imported });

  // Update last sync time
  await Cafe.findByIdAndUpdate(cafe._id, { lastSyncAt: new Date() });
  return { status: 'synced', ...result };
}

const isYocoId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_.:-]/.test(value);

const claimsOf = (idToken) => {
  if (typeof idToken !== 'string' || idToken.length > 32_768) return null;
  try {
    const [, payload] = idToken.split('.');
    if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
};

/**
 * Only for the token response received directly from the OAuth endpoint over TLS.
 * Yoco's token reference names authorized_business_id as the selected business;
 * default_business_id and business_ids do not establish that selection.
 * https://developer.yoco.com/api-reference/oauth-api/oauth/token
 */
const businessIdFromTokens = (tokens) => {
  const claims = claimsOf(tokens?.id_token);
  const candidate = tokens?.authorized_business_id ?? claims?.authorized_business_id
    ?? tokens?.business_id ?? claims?.business_id ?? claims?.ext?.business_id;
  return isYocoId(candidate) ? candidate : null;
};

const publicWebhookUrl = () => {
  try {
    const url = new URL(process.env.API_PUBLIC_URL || '');
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.href.replace(/\/$/, '')}/api/yoco/webhook`;
  } catch {
    return null;
  }
};

async function registerWebhookIfPublic(cafeId, accessToken) {
  const url = publicWebhookUrl();
  if (!url) return 'skipped';
  try {
    const subscription = await subscribeWebhook(accessToken, url);
    if (isYocoId(subscription?.id)) {
      await Cafe.updateOne({ _id: cafeId }, { $set: { yocoWebhookSubscriptionId: subscription.id } });
    }
    return 'registered';
  } catch (error) {
    logger.warn('yoco_webhook_subscribe_failed', { upstreamStatus: error?.response?.status ?? null, code: error?.code ?? null });
    return 'failed';
  }
}

module.exports = {
  getAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  getValidToken,
  fetchOrders,
  fetchAllOrders,
  syncHistory,
  yocoSyncTotalMs,
  parseSyncRange,
  syncOrders,
  subscribeWebhook,
  processWebhookEvent,
  createOAuthState,
  verifyOAuthState,
  verifyWebhookSignature,
  isYocoId,
  businessIdFromTokens,
  registerWebhookIfPublic,
};
