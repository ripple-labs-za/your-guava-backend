/**
 * Sage Business Cloud Accounting OAuth + sync service
 *
 * OAuth endpoints:
 *   Authorize: https://www.sageone.com/oauth2/auth/central
 *   Token:     https://oauth.accounting.sage.com/token
 *
 * Required env vars:
 *   SAGE_CLIENT_ID      — from https://developer.sage.com/accounting/
 *   SAGE_CLIENT_SECRET
 *   SAGE_REDIRECT_URI   — e.g. http://localhost:5173/integrations/sage/callback
 *
 * After token exchange, the server verifies the selected business against
 * GET https://api.accounting.sage.com/v3.1/businesses and refuses ambiguity.
 */

const { outboundGet, outboundPost } = require('../../utils/http');

const { isValidAccountId, pickAccount } = require('./common');

const AUTHORIZE_URL = 'https://www.sageone.com/oauth2/auth/central';
const TOKEN_URL = 'https://oauth.accounting.sage.com/token';
const SCOPES = 'full_access';
const API_BASE = 'https://api.accounting.sage.com/v3.1/';

/** Return the OAuth 2 authorization URL. */
const buildAuthorizeUrl = (state) => {
  const clientId = process.env.SAGE_CLIENT_ID;
  const clientSecret = process.env.SAGE_CLIENT_SECRET;
  const redirectUri = process.env.SAGE_REDIRECT_URI;

  if (!clientId) throw new Error('SAGE_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('SAGE_CLIENT_SECRET is not set — see docs/integrations.md');
  if (!redirectUri) throw new Error('SAGE_REDIRECT_URI is not set — see docs/integrations.md');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
};

/** Exchange an authorization code for access + refresh tokens.
 *  `providerExtras` may contain `businessId` if the frontend obtained it. */
const REVOKE_URL = 'https://oauth.accounting.sage.com/revoke';

const listBusinesses = async (accessToken) => {
  const { data } = await outboundGet('sage', `${API_BASE}businesses`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.$items) ? data.$items : [];
};

const revokeToken = async (refreshToken) => {
  if (!refreshToken) return;
  const clientId = process.env.SAGE_CLIENT_ID;
  const clientSecret = process.env.SAGE_CLIENT_SECRET;
  if (!clientId) throw new Error('SAGE_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('SAGE_CLIENT_SECRET is not set — see docs/integrations.md');
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: refreshToken });
  await outboundPost('sage', REVOKE_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
};

const exchangeCodeForTokens = async (code, providerExtras = {}) => {
  const clientId = process.env.SAGE_CLIENT_ID;
  const clientSecret = process.env.SAGE_CLIENT_SECRET;
  const redirectUri = process.env.SAGE_REDIRECT_URI;

  if (!clientId) throw new Error('SAGE_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('SAGE_CLIENT_SECRET is not set — see docs/integrations.md');
  if (!redirectUri) throw new Error('SAGE_REDIRECT_URI is not set — see docs/integrations.md');

  // Sage accepts client credentials in the POST body (not Basic auth)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const response = await outboundPost('sage', TOKEN_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const data = response.data;

  try {
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in, businessId: pickAccount({ providerLabel: 'Sage', accountNoun: 'business', ids: (await listBusinesses(data.access_token)).map((business) => business?.id).filter(isValidAccountId), requestedId: providerExtras.businessId }) };
  } catch (error) {
    await revokeToken(data.refresh_token).catch(() => {});
    throw error;
  }
};

/** Refresh an expired access token. */
const refreshAccessToken = async (refreshToken) => {
  const clientId = process.env.SAGE_CLIENT_ID;
  const clientSecret = process.env.SAGE_CLIENT_SECRET;

  if (!clientId) throw new Error('SAGE_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('SAGE_CLIENT_SECRET is not set — see docs/integrations.md');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await outboundPost('sage', TOKEN_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const data = response.data;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
};

/** Returns true if the token is within 60 seconds of expiry. */
const isTokenExpired = (expiresAt) => {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - Date.now() < 60 * 1000;
};

/**
 * Push a 7-day sales summary to Sage Accounting.
 *
 * TODO: implement real Sage data push.
 *
 * Suggested approach — POST a Sales Invoice:
 *   POST https://api.accounting.sage.com/v3.1/sales_invoices
 *   Docs: https://developer.sage.com/accounting/reference/sales-invoices/
 *
 * Alternatively, POST a Sales Receipt for cash/card transactions:
 *   POST https://api.accounting.sage.com/v3.1/sales_quick_entries
 *   Docs: https://developer.sage.com/accounting/reference/sales/#tag/Sales-Quick-Entries
 *
 * Required headers for all Sage API calls:
 *   Authorization: Bearer <accessToken>
 *   Content-Type: application/json
 *
 * The `cafe` object passed here will have `accessToken` and `businessId`
 * populated from the stored integration fields.
 */
const pushSalesSummary = async () => {
  // TODO: push to Sage — POST /sales_invoices or /sales_quick_entries
  // Doc: https://developer.sage.com/accounting/reference/sales-invoices/
  // When implementing: use _cafe.accessToken + _cafe.businessId in the request headers.
  return {
    ok: false,
    statusCode: 501,
    error: 'Sage sales posting is not implemented yet',
  };
};

module.exports = {
  listBusinesses,
  revokeToken,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  isTokenExpired,
  pushSalesSummary,
  API_BASE, // exported for reference; not used until pushSalesSummary is implemented
};
