const logger = require('../utils/logger');
const Cafe = require('../models/Cafe.model');
const { encryptSecret, decryptSecret } = require('../services/secrets.service');
const {
  createIntegrationOAuthState,
  consumeIntegrationOAuthState,
} = require('../services/integrationOAuthState.service');

const xeroService = require('../services/integrations/xero.service');
const quickbooksService = require('../services/integrations/quickbooks.service');
const sageService = require('../services/integrations/sage.service');
const { activeCafeId } = require('../utils/tenancy');
const { singleFlight } = require('../utils/singleFlight');
const { refreshIntegrationAccessToken } = require('../services/integrations/tokens');
const { syncWindow, buildSalesSummary } = require('../services/integrations/salesSummary');
const { PROVIDER_LABELS, ACCOUNT_ID_FIELD, isValidAccountId } = require('../services/integrations/common');

const SERVICES = Object.freeze({
  xero: xeroService,
  quickbooks: quickbooksService,
  sage: sageService,
});

/**
 * Map provider name → service module. Returns null for unknown providers.
 * Own keys only: on a plain lookup, "constructor", "__proto__" or "toString"
 * resolved to a built-in, walked past the "Unknown provider" guard and ended
 * in a 500.
 */
const isKnownProvider = (provider) => typeof provider === 'string' && Object.hasOwn(SERVICES, provider);

const getService = (provider) => (isKnownProvider(provider) ? SERVICES[provider] : null);

/**
 * router.param('provider', ...): every /:provider route is checked here once,
 * before its handler and before the feature flag, against the one list. With
 * the flag off, an unknown provider used to answer 503 like a real one.
 */
const validateProviderParam = (req, res, next, provider) => {
  if (!isKnownProvider(provider)) return res.status(400).json({ success: false, message: 'Unknown provider' });
  return next();
};

const isConfigError = (error) =>
  /CLIENT_ID|CLIENT_SECRET|REDIRECT_URI|is not set/i.test(error?.message || '');

const accountingIntegrationsEnabled = () =>
  String(process.env.ACCOUNTING_INTEGRATIONS_ENABLED || '').toLowerCase() === 'true';

const unavailable = (res) =>
  res.status(503).json({
    success: false,
    code: 'ACCOUNTING_INTEGRATIONS_NOT_AVAILABLE',
    message: 'Accounting integrations are not available yet. This feature is coming soon.',
  });

/**
 * GET /api/integrations
 * Returns connection status for all 3 providers. Tokens are never included.
 */
const list = async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(activeCafeId(req)).lean();
    const providers = Object.keys(SERVICES);
    const status = {};
    for (const p of providers) {
      const integ = cafe?.accountingIntegrations?.[p] || {};
      status[p] = {
        connected: integ.connected || false,
        connectedAt: integ.connectedAt || null,
        lastSyncAt: integ.lastSyncAt || null,
        lastSyncStatus: integ.lastSyncStatus || null,
        lastSyncError: integ.lastSyncError || null,
      };
    }
    return res.status(200).json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/integrations/:provider/auth
 * Returns the provider's OAuth authorize URL. The frontend should redirect
 * the user to this URL to begin the OAuth flow.
 */
const getAuthUrl = async (req, res, next) => {
  try {
    if (!accountingIntegrationsEnabled()) return unavailable(res);

    const { provider } = req.params;
    const service = getService(provider);
    if (!service) return res.status(400).json({ success: false, message: 'Unknown provider' });

    // Persist a short-lived, one-time, opaque state token. Binding the token to
    // the live user, cafe and provider prevents tampering, replay and cross-cafe
    // callback confusion.
    const state = await createIntegrationOAuthState({
      cafeId: activeCafeId(req),
      userId: req.user.id,
      provider,
    });

    const url = service.buildAuthorizeUrl(state);
    return res.status(200).json({ success: true, url });
  } catch (error) {
    if (isConfigError(error)) {
      return res.status(503).json({ success: false, code: 'INTEGRATION_NOT_CONFIGURED', message: error.message });
    }
    return next(error);
  }
};

/**
 * POST /api/integrations/:provider/callback
 * Body: { code, state, [tenantId|realmId|businessId] }
 *
 * The frontend calls this after the provider redirects back with an auth code.
 * We exchange the code for tokens and store them on the cafe document.
 *
 * Xero and Sage accounts are checked against the provider's list for the new
 * token. An optional requested id must be in that list; ambiguity is refused.
 *
 * QuickBooks note: Intuit appends `realmId` to the redirect URL as a query
 * param — the frontend must extract it and pass it in this request body.
 *
 * QuickBooks realm access is verified server-side before the grant is stored.
 */
const isHttpStatus = (value) => Number.isInteger(value) && value >= 400 && value <= 599;
const pushFailureStatus = (statusCode) => (statusCode === 501 ? 501 : 502);

// callback: validate the account id before spending the one-time state, pass only that one field on,
// and answer a provider-authored refusal (400/409/502/504 with publicCode) as it is.
const callback = async (req, res, _next) => {
  const { provider } = req.params;
  try {
    if (!accountingIntegrationsEnabled()) return unavailable(res);
    const service = getService(provider);
    if (!service) return res.status(400).json({ success: false, message: 'Unknown provider' });
    const { code, state } = req.body || {};
    if (typeof code !== 'string' || code.length < 1 || code.length > 4096) {
      return res.status(400).json({ success: false, message: 'Invalid authorization code' });
    }
    const accountField = ACCOUNT_ID_FIELD[provider];
    const requestedAccountId = req.body?.[accountField];
    if (requestedAccountId != null && !isValidAccountId(requestedAccountId)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_PROVIDER_ACCOUNT_ID',
        message: `${accountField} must be a short identifier issued by ${PROVIDER_LABELS[provider]}`,
      });
    }

    const validState = await consumeIntegrationOAuthState({
      state, cafeId: activeCafeId(req), userId: req.user.id, provider,
    });
    if (!validState) {
      return res.status(400).json({ success: false, message: 'Invalid or expired authorization state' });
    }

    const tokens = await service.exchangeCodeForTokens(
      code,
      requestedAccountId ? { [accountField]: requestedAccountId } : {}
    );
    const base = `accountingIntegrations.${provider}`;
    await Cafe.updateOne({ _id: activeCafeId(req) }, { $set: {
      [`${base}.connected`]: true,
      [`${base}.accessToken`]: encryptSecret(tokens.accessToken),
      [`${base}.refreshToken`]: encryptSecret(tokens.refreshToken),
      [`${base}.expiresAt`]: new Date(Date.now() + (tokens.expiresIn || 1800) * 1000),
      [`${base}.connectedAt`]: new Date(),
      [`${base}.${accountField}`]: tokens[accountField],
    } });
    return res.status(200).json({ success: true });
  } catch (error) {
    if (isConfigError(error)) {
      return res.status(503).json({ success: false, code: 'INTEGRATION_NOT_CONFIGURED', message: error.message });
    }
    if (error?.publicCode && isHttpStatus(error.statusCode)) {
      return res.status(error.statusCode).json({ success: false, code: error.publicCode, message: error.message });
    }
    logger.error('integration_oauth_callback_failed', { provider, ...logger.errorFields(error) });
    return res.status(502).json({
      success: false,
      code: 'OAUTH_CALLBACK_FAILED',
      message: 'The accounting provider could not complete authorization',
    });
  }
};


/**
 * POST /api/integrations/:provider/sync
 * Aggregates closed cafe-local days after the high-water mark and pushes a summary
 * to the accounting provider. Token refresh is handled automatically.
 */
// A flight includes the fresh read, provider push and watermark write. Sharing only
// the refresh would still let two tabs send the same period with an unexpired token.
const syncConnection = async (cafeId, provider, service) => {
  const base = `accountingIntegrations.${provider}`;
  const cafe = await Cafe.findById(cafeId).select(`+${base}.accessToken +${base}.refreshToken`);
  const integ = cafe?.accountingIntegrations?.[provider];
  if (!integ?.connected) return { status: 400, body: { success: false, message: 'Not connected' } };
  const period = syncWindow({ timezone: cafe.timezone, lastSyncedThrough: integ.lastSyncedThrough });
  if (!period) return { status: 200, body: {
    success: true, upToDate: true, syncedThrough: integ.lastSyncedThrough,
    message: `${PROVIDER_LABELS[provider]} already has every closed day`,
  } };
  const accessToken = service.isTokenExpired(integ.expiresAt)
    ? await refreshIntegrationAccessToken({ cafeId, provider, service, storedRefreshToken: integ.refreshToken })
    : await Cafe.readSecret(cafe, `${base}.accessToken`);
  const summary = await buildSalesSummary({ cafeId, cafeName: cafe.name, ...period });
  const result = await service.pushSalesSummary({ ...cafe.toObject(), accessToken }, summary);
  const failureMessage = result.statusCode === 501
    ? `${PROVIDER_LABELS[provider]} sales posting is not implemented yet`
    : `${PROVIDER_LABELS[provider]} could not complete the sync. Please try again in a minute.`;
  await Cafe.updateOne({ _id: cafeId, [`${base}.connected`]: true, [`${base}.connectedAt`]: integ.connectedAt || null }, { $set: {
    [`${base}.lastSyncAt`]: new Date(),
    [`${base}.lastSyncStatus`]: result.ok ? 'success' : 'failed',
    [`${base}.lastSyncError`]: result.ok ? null : failureMessage,
    ...(result.ok ? { [`${base}.lastSyncedThrough`]: period.periodEnd } : {}),
  } });
  return { status: result.ok ? 200 : pushFailureStatus(result.statusCode), body: {
    success: result.ok, providerRef: result.providerRef,
    summary: { ...summary, periodStart: summary.periodStart.toISOString(), periodEnd: summary.periodEnd.toISOString() },
    message: result.ok ? `Sales summary sent to ${provider}` : failureMessage,
  } };
};

const sync = async (req, res, next) => {
  try {
    if (!accountingIntegrationsEnabled()) return unavailable(res);
    const { provider } = req.params;
    const service = getService(provider);
    if (!service) return res.status(400).json({ success: false, message: 'Unknown provider' });
    const cafeId = activeCafeId(req);
    const outcome = await singleFlight(`integration-sync:${cafeId}:${provider}`, () => syncConnection(cafeId, provider, service));
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return next(error);
  }
};


/**
 * POST /api/integrations/:provider/disconnect
 * Clears stored tokens and marks the provider as disconnected.
 */
const revokeQuietly = async (provider, service, storedRefreshToken) => {
  if (!storedRefreshToken) return 'not_needed';
  try {
    await service.revokeToken(decryptSecret(storedRefreshToken));
    return 'revoked';
  } catch (error) {
    const outcome = isConfigError(error) ? 'skipped' : 'failed';
    logger.warn('integration_revoke_failed', {
      provider,
      outcome,
      upstreamStatus: error?.response?.status ?? null,
      code: error?.code ?? null,
    });
    return outcome;
  }
};

const disconnect = async (req, res, next) => {
  try {
    const { provider } = req.params;
    const service = getService(provider);
    if (!service) return res.status(400).json({ success: false, message: 'Unknown provider' });
    const cafeId = activeCafeId(req);
    const base = `accountingIntegrations.${provider}`;
    const cafe = await Cafe.findById(cafeId).select(`+${base}.refreshToken`).lean();
    const revocation = await revokeQuietly(provider, service, cafe?.accountingIntegrations?.[provider]?.refreshToken);
    await Cafe.updateOne({ _id: cafeId }, {
      $set: {
        [`${base}.connected`]: false,
        [`${base}.accessToken`]: null,
        [`${base}.refreshToken`]: null,
        [`${base}.expiresAt`]: null,
      },
      $unset: {
        [`${base}.${ACCOUNT_ID_FIELD[provider]}`]: '',
        [`${base}.connectedAt`]: '',
        [`${base}.lastSyncAt`]: '',
        [`${base}.lastSyncStatus`]: '',
        [`${base}.lastSyncError`]: '',
        [`${base}.lastSyncedThrough`]: '',
      },
    });
    return res.status(200).json({ success: true, revocation });
  } catch (error) {
    return next(error);
  }
};


module.exports = { list, getAuthUrl, callback, sync, disconnect, isKnownProvider, validateProviderParam };
