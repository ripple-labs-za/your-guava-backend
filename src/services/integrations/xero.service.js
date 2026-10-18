/**
 * Xero OAuth + sync service
 *
 * OAuth endpoints:
 *   Authorize: https://login.xero.com/identity/connect/authorize
 *   Token:     https://identity.xero.com/connect/token
 *
 * Required env vars:
 *   XERO_CLIENT_ID      — from https://developer.xero.com/myapps
 *   XERO_CLIENT_SECRET
 *   XERO_REDIRECT_URI   — e.g. http://localhost:5173/integrations/xero/callback
 *
 * After the user grants consent, Xero sends a code AND a list of authorised
 * tenants.  The frontend should pass `tenantId` in the callback body after
 * calling GET /api/integrations/xero/auth (Xero surfaces the tenant list at
 * https://api.xero.com/connections after the first token exchange — a future
 * enhancement can auto-select the single tenant or let the user pick).
 */

const { outboundGet, outboundPost, isOutboundTimeout } = require('../../utils/http');

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const SCOPES = 'openid profile email accounting.transactions accounting.contacts.read offline_access';

/** Return the OAuth 2 authorization URL. `state` is a base64url-encoded blob
 *  the backend uses to match the callback to the originating cafe. */
const buildAuthorizeUrl = (state) => {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri = process.env.XERO_REDIRECT_URI;

  if (!clientId) throw new Error('XERO_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('XERO_CLIENT_SECRET is not set — see docs/integrations.md');
  if (!redirectUri) throw new Error('XERO_REDIRECT_URI is not set — see docs/integrations.md');

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
 *  `providerExtras` may contain `tenantId` if the frontend obtained it
 *  via the Xero connections endpoint after redirect. */
const exchangeCodeForTokens = async (code, providerExtras = {}) => {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri = process.env.XERO_REDIRECT_URI;

  if (!clientId) throw new Error('XERO_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('XERO_CLIENT_SECRET is not set — see docs/integrations.md');
  if (!redirectUri) throw new Error('XERO_REDIRECT_URI is not set — see docs/integrations.md');

  // Xero requires Basic auth (base64 of client_id:client_secret)
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const response = await outboundPost('xero', TOKEN_URL, body.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const data = response.data;
  const accessToken = data.access_token;

  // Fetch the tenant ID from the Xero connections endpoint.
  // Xero does not include tenantId in the token response — it must be
  // retrieved separately from GET https://api.xero.com/connections.
  let tenantId = providerExtras.tenantId || null;
  if (!tenantId) {
    try {
      const connectionsRes = await outboundGet('xero', 'https://api.xero.com/connections', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const connections = connectionsRes.data;
      if (Array.isArray(connections) && connections.length > 0) {
        tenantId = connections[0].tenantId || null;
      }
    } catch (err) {
      if (isOutboundTimeout(err)) throw err;
      console.warn('[xero] Could not fetch tenantId from /connections:', err?.message);
    }
  }

  return {
    accessToken,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    tenantId,
  };
};

/** Refresh an expired access token using the stored refresh token. */
const refreshAccessToken = async (refreshToken) => {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!clientId) throw new Error('XERO_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('XERO_CLIENT_SECRET is not set — see docs/integrations.md');

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await outboundPost('xero', TOKEN_URL, body.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
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

/** Returns true if the token is within 60 seconds of expiry (proactive refresh). */
const isTokenExpired = (expiresAt) => {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - Date.now() < 60 * 1000;
};

/**
 * Push a 7-day sales summary to Xero.
 *
 * TODO: implement real Xero data push.
 *
 * Suggested approach — POST a BankTransaction per sales period:
 *   POST https://api.xero.com/api.xro/2.0/BankTransactions
 *   Docs: https://developer.xero.com/documentation/api/accounting/banktransactions
 *
 * Alternatively, POST an Invoice for the period:
 *   POST https://api.xero.com/api.xro/2.0/Invoices
 *   Docs: https://developer.xero.com/documentation/api/accounting/invoices
 *
 * Required headers for all Xero API calls:
 *   Authorization: Bearer <accessToken>
 *   Xero-tenant-id: <tenantId>
 *   Accept: application/json
 *
 * The `cafe` object passed here will have `accessToken` and `tenantId`
 * already populated from the stored integration fields.
 */
const pushSalesSummary = async () => {
  // TODO: push to Xero — POST /BankTransactions or /Invoices
  // Doc: https://developer.xero.com/documentation/api/accounting/banktransactions
  // When implementing: use _cafe.accessToken + _cafe.tenantId in the request headers.
  return {
    ok: false,
    statusCode: 501,
    error: 'Xero sales posting is not implemented yet',
  };
};

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  isTokenExpired,
  pushSalesSummary,
};
