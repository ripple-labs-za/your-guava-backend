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
const { demandLines } = require('../utils/demand');

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
const getAuthUrl = async (req, res, _next) => {
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
    return res.status(isConfigError(error) ? 503 : 500).json({
      success: false,
      code: isConfigError(error) ? 'INTEGRATION_NOT_CONFIGURED' : 'INTEGRATION_AUTH_URL_FAILED',
      message: error.message,
    });
  }
};

/**
 * POST /api/integrations/:provider/callback
 * Body: { code, state, [tenantId|realmId|businessId] }
 *
 * The frontend calls this after the provider redirects back with an auth code.
 * We exchange the code for tokens and store them on the cafe document.
 *
 * Xero note: the tenantId (Xero org GUID) is obtained by the frontend after
 * the redirect by calling GET https://api.xero.com/connections with the new
 * access token, then passed back here.
 *
 * QuickBooks note: Intuit appends `realmId` to the redirect URL as a query
 * param — the frontend must extract it and pass it in this request body.
 *
 * Sage note: the businessId can be fetched from
 * GET https://api.accounting.sage.com/v3.1/business after token exchange.
 */
const callback = async (req, res, _next) => {
  try {
    if (!accountingIntegrationsEnabled()) return unavailable(res);

    const { provider } = req.params;
    const { code, state, ...providerExtras } = req.body || {};
    const service = getService(provider);
    if (!service) return res.status(400).json({ success: false, message: 'Unknown provider' });
    if (typeof code !== 'string' || code.length < 1 || code.length > 4096) {
      return res.status(400).json({ success: false, message: 'Invalid authorization code' });
    }

    const validState = await consumeIntegrationOAuthState({
      state,
      cafeId: activeCafeId(req),
      userId: req.user.id,
      provider,
    });
    if (!validState) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired authorization state',
      });
    }

    const tokens = await service.exchangeCodeForTokens(code, providerExtras);
    const expiresAt = new Date(Date.now() + (tokens.expiresIn || 1800) * 1000);

    const update = {
      [`accountingIntegrations.${provider}.connected`]: true,
      [`accountingIntegrations.${provider}.accessToken`]: encryptSecret(tokens.accessToken),
      [`accountingIntegrations.${provider}.refreshToken`]: encryptSecret(tokens.refreshToken),
      [`accountingIntegrations.${provider}.expiresAt`]: expiresAt,
      [`accountingIntegrations.${provider}.connectedAt`]: new Date(),
    };
    if (tokens.tenantId) update[`accountingIntegrations.${provider}.tenantId`] = tokens.tenantId;
    if (tokens.realmId) update[`accountingIntegrations.${provider}.realmId`] = tokens.realmId;
    if (tokens.businessId) update[`accountingIntegrations.${provider}.businessId`] = tokens.businessId;

    await Cafe.findByIdAndUpdate(activeCafeId(req), { $set: update });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[integrations] OAuth callback failed:', error?.message);
    return res.status(isConfigError(error) ? 503 : 502).json({
      success: false,
      code: isConfigError(error) ? 'INTEGRATION_NOT_CONFIGURED' : 'OAUTH_CALLBACK_FAILED',
      message: isConfigError(error)
        ? error.message
        : 'The accounting provider could not complete authorization',
    });
  }
};

/**
 * POST /api/integrations/:provider/sync
 * Aggregates the last 7 days of approved transactions and pushes a summary
 * to the accounting provider. Token refresh is handled automatically.
 */
const sync = async (req, res, next) => {
  try {
    if (!accountingIntegrationsEnabled()) return unavailable(res);

    const { provider } = req.params;
    const service = getService(provider);
    if (!service) return res.status(400).json({ success: false, message: 'Unknown provider' });

    const cafe = await Cafe.findById(activeCafeId(req)).select(
      `+accountingIntegrations.${provider}.accessToken +accountingIntegrations.${provider}.refreshToken`
    );
    const integ = cafe?.accountingIntegrations?.[provider];
    if (!integ?.connected) {
      return res.status(400).json({ success: false, message: 'Not connected' });
    }

    // Proactively refresh if the token is within 60 s of expiry
    if (service.isTokenExpired(integ.expiresAt)) {
      try {
        const refreshed = await service.refreshAccessToken(decryptSecret(integ.refreshToken));
        const newExpiresAt = new Date(Date.now() + (refreshed.expiresIn || 1800) * 1000);
        await Cafe.findByIdAndUpdate(activeCafeId(req), {
          $set: {
            [`accountingIntegrations.${provider}.accessToken`]: encryptSecret(refreshed.accessToken),
            [`accountingIntegrations.${provider}.refreshToken`]:
              encryptSecret(refreshed.refreshToken) || integ.refreshToken,
            [`accountingIntegrations.${provider}.expiresAt`]: newExpiresAt,
          },
        });
        integ.accessToken = refreshed.accessToken;
      } catch (err) {
        return res
          .status(401)
          .json({ success: false, message: 'Token refresh failed: ' + err.message });
      }
    }

    // Build last-7-days sales summary
    const Transaction = require('../models/Transaction.model');
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const txns = await Transaction.find({
      cafeId: activeCafeId(req),
      status: 'approved',
      date: { $gte: sevenDaysAgo },
    }).lean();

    const summary = {
      cafeName: cafe.name,
      periodStart: sevenDaysAgo,
      periodEnd: new Date(),
      transactionCount: txns.length,
      totalRevenue: txns.reduce((s, t) => s + (t.total || 0), 0),
      totalTip: txns.reduce((s, t) => s + (t.tip || 0), 0),
      // No prototype: keyed by POS item names (see getService).
      itemBreakdown: Object.create(null),
    };

    // An ignored line (a delivery fee) is not an item sale; totalRevenue above still counts it as takings.
    for (const tx of txns) {
      for (const item of demandLines(tx.items)) {
        summary.itemBreakdown[item.name] =
          (summary.itemBreakdown[item.name] || 0) + (item.unitPrice || 0) * item.quantity;
      }
    }

    const result = await service.pushSalesSummary(
      { ...cafe.toObject(), accessToken: decryptSecret(integ.accessToken) },
      summary
    );

    const updateFields = {
      [`accountingIntegrations.${provider}.lastSyncAt`]: new Date(),
      [`accountingIntegrations.${provider}.lastSyncStatus`]: result.ok ? 'success' : 'failed',
      [`accountingIntegrations.${provider}.lastSyncError`]: result.ok
        ? null
        : result.error || 'Unknown error',
    };
    await Cafe.findByIdAndUpdate(activeCafeId(req), { $set: updateFields });

    return res.status(result.ok ? 200 : result.statusCode || 500).json({
      success: result.ok,
      providerRef: result.providerRef,
      summary: {
        ...summary,
        periodStart: summary.periodStart.toISOString(),
        periodEnd: summary.periodEnd.toISOString(),
      },
      message: result.ok
        ? `Sales summary sent to ${provider}`
        : `Sync failed: ${result.error}`,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/integrations/:provider/disconnect
 * Clears stored tokens and marks the provider as disconnected.
 */
const disconnect = async (req, res, next) => {
  try {
    const { provider } = req.params;
    if (!getService(provider)) {
      return res.status(400).json({ success: false, message: 'Unknown provider' });
    }
    await Cafe.findByIdAndUpdate(activeCafeId(req), {
      $set: {
        [`accountingIntegrations.${provider}.connected`]: false,
        [`accountingIntegrations.${provider}.accessToken`]: null,
        [`accountingIntegrations.${provider}.refreshToken`]: null,
        [`accountingIntegrations.${provider}.expiresAt`]: null,
      },
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

module.exports = { list, getAuthUrl, callback, sync, disconnect, isKnownProvider, validateProviderParam };
