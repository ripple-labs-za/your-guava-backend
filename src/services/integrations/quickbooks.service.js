/**
 * QuickBooks (Intuit) OAuth + sync service
 *
 * OAuth endpoints:
 *   Authorize: https://appcenter.intuit.com/connect/oauth2
 *   Token:     https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *
 * Required env vars:
 *   QUICKBOOKS_CLIENT_ID      — from https://developer.intuit.com/app/developer/myapps
 *   QUICKBOOKS_CLIENT_SECRET
 *   QUICKBOOKS_REDIRECT_URI   — e.g. http://localhost:5173/integrations/quickbooks/callback
 *   QUICKBOOKS_ENV            — 'sandbox' (default) or 'production'
 *
 * After the OAuth redirect, Intuit appends `realmId` (the company/tenant ID)
 * as a query-string parameter alongside the authorization code. The frontend
 * must forward it in the callback POST body.
 */

const { outboundGet, outboundPost } = require('../../utils/http');

const { isValidAccountId, integrationError } = require('./common');

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPES = 'com.intuit.quickbooks.accounting';

// API base — used by pushSalesSummary when implemented:
//   process.env.QUICKBOOKS_ENV === 'production'
//     ? 'https://quickbooks.api.intuit.com/v3/company/'
//     : 'https://sandbox-quickbooks.api.intuit.com/v3/company/'

/** Return the OAuth 2 authorization URL. */
const buildAuthorizeUrl = (state) => {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI;

  if (!clientId) throw new Error('QUICKBOOKS_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('QUICKBOOKS_CLIENT_SECRET is not set — see docs/integrations.md');
  if (!redirectUri) throw new Error('QUICKBOOKS_REDIRECT_URI is not set — see docs/integrations.md');

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
 *  `providerExtras` must contain `realmId` (Intuit appends it to the redirect). */
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const apiBase = () => (process.env.QUICKBOOKS_ENV === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com');

/** Intuit puts realmId on the redirect; prove the new token can read that company before storing it. */
const verifyRealm = async (accessToken, realmId) => {
  const mismatch = () => integrationError(400, 'INTEGRATION_ACCOUNT_MISMATCH',
    'QuickBooks did not authorise that company for this connection. Connect again and choose it on the QuickBooks screen.');
  if (!isValidAccountId(realmId)) throw mismatch();
  const id = encodeURIComponent(realmId);
  try {
    await outboundGet('quickbooks', `${apiBase()}/v3/company/${id}/companyinfo/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    return realmId;
  } catch (error) {
    if ([401, 403, 404].includes(error?.response?.status)) throw mismatch();
    throw error;
  }
};

const revokeToken = async (refreshToken) => {
  if (!refreshToken) return;
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId) throw new Error('QUICKBOOKS_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('QUICKBOOKS_CLIENT_SECRET is not set — see docs/integrations.md');
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  await outboundPost('quickbooks', REVOKE_URL, { token: refreshToken }, {
    headers: { Authorization: `Basic ${basicAuth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
  });
};

const exchangeCodeForTokens = async (code, providerExtras = {}) => {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI;

  if (!clientId) throw new Error('QUICKBOOKS_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('QUICKBOOKS_CLIENT_SECRET is not set — see docs/integrations.md');
  if (!redirectUri) throw new Error('QUICKBOOKS_REDIRECT_URI is not set — see docs/integrations.md');

  // Intuit requires Basic auth
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const response = await outboundPost('quickbooks', TOKEN_URL, body.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });

  const data = response.data;

  try {
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in, realmId: await verifyRealm(data.access_token, providerExtras.realmId) };
  } catch (error) {
    await revokeToken(data.refresh_token).catch(() => {});
    throw error;
  }
};

/** Refresh an expired access token. */
const refreshAccessToken = async (refreshToken) => {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;

  if (!clientId) throw new Error('QUICKBOOKS_CLIENT_ID is not set — see docs/integrations.md');
  if (!clientSecret) throw new Error('QUICKBOOKS_CLIENT_SECRET is not set — see docs/integrations.md');

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await outboundPost('quickbooks', TOKEN_URL, body.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
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
 * Push a 7-day sales summary to QuickBooks.
 *
 * TODO: implement real QuickBooks data push.
 *
 * Suggested approach — POST a SalesReceipt (preferred for POS data) or Invoice:
 *   POST https://sandbox-quickbooks.api.intuit.com/v3/company/<realmId>/salesreceipt
 *   Docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/salesreceipt
 *
 * Alternatively, POST an Invoice:
 *   POST https://[sandbox-]quickbooks.api.intuit.com/v3/company/<realmId>/invoice
 *   Docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
 *
 * Required headers for all QB API calls:
 *   Authorization: Bearer <accessToken>
 *   Accept: application/json
 *   Content-Type: application/json
 *
 * The `cafe` object passed here will have `accessToken` and `realmId`
 * populated from the stored integration fields.
 */
const pushSalesSummary = async () => {
  // TODO: push to QuickBooks — POST {apiBase}/v3/company/{realmId}/salesreceipt
  // Doc: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/salesreceipt
  // When implementing: use _cafe.accessToken + _cafe.realmId; pick apiBase via process.env.QUICKBOOKS_ENV.
  return {
    ok: false,
    statusCode: 501,
    error: 'QuickBooks sales posting is not implemented yet',
  };
};

module.exports = {
  verifyRealm,
  revokeToken,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  isTokenExpired,
  pushSalesSummary,
};
