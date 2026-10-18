const Cafe = require('../../models/Cafe.model');
const { encryptSecret, decryptSecret } = require('../secrets.service');
const { singleFlight } = require('../../utils/singleFlight');
const { isOutboundTimeout, toUpstreamError } = require('../../utils/http');
const { integrationError, PROVIDER_LABELS } = require('./common');

const DEFAULT_EXPIRES_IN_S = 1800;

/**
 * invalid_grant means the owner revoked access or the grant lapsed: only reconnecting helps, so the
 * answer is 502 INTEGRATION_REAUTH_REQUIRED. Anything else is a provider or client-credential failure:
 * 502/504 with an upstream code. Never the provider's status (workforce-integrations-8).
 */
const classifyRefreshFailure = (provider, error) => {
  if (isOutboundTimeout(error)) return error;
  if (error?.response?.data?.error === 'invalid_grant') {
    const label = PROVIDER_LABELS[provider];
    return integrationError(502, 'INTEGRATION_REAUTH_REQUIRED',
      `${label} no longer accepts this connection. Reconnect ${label} to resume syncing.`,
      { upstreamStatus: error.response.status ?? null, upstreamMessage: 'invalid_grant' });
  }
  return toUpstreamError(provider, error);
};

const markReauthRequired = (cafeId, provider, storedRefreshToken, message) => {
  const base = `accountingIntegrations.${provider}`;
  return Cafe.updateOne({ _id: cafeId, [`${base}.refreshToken`]: storedRefreshToken }, { $set: {
    [`${base}.connected`]: false,
    [`${base}.accessToken`]: null,
    [`${base}.refreshToken`]: null,
    [`${base}.expiresAt`]: null,
    [`${base}.lastSyncStatus`]: 'failed',
    [`${base}.lastSyncError`]: message,
  } });
};

/**
 * One refresh per cafe and provider at a time (workforce-integrations-12), and a compare-and-set write:
 * if another request already replaced the stored refresh token, its tokens win and ours are dropped, so
 * a superseded refresh token is never persisted.
 */
const refreshIntegrationAccessToken = ({ cafeId, provider, service, storedRefreshToken }) =>
  singleFlight(`integration-refresh:${cafeId}:${provider}`, async () => {
    const base = `accountingIntegrations.${provider}`;
    const refreshToken = decryptSecret(storedRefreshToken);
    let refreshed;
    try {
      refreshed = await service.refreshAccessToken(refreshToken);
    } catch (error) {
      const failure = classifyRefreshFailure(provider, error);
      if (failure.publicCode === 'INTEGRATION_REAUTH_REQUIRED') {
        await markReauthRequired(cafeId, provider, storedRefreshToken, failure.message);
      }
      throw failure;
    }
    const written = await Cafe.updateOne(
      { _id: cafeId, [`${base}.refreshToken`]: storedRefreshToken },
      { $set: {
        [`${base}.accessToken`]: encryptSecret(refreshed.accessToken),
        [`${base}.refreshToken`]: encryptSecret(refreshed.refreshToken) || storedRefreshToken,
        [`${base}.expiresAt`]: new Date(Date.now() + (refreshed.expiresIn || DEFAULT_EXPIRES_IN_S) * 1000),
      } }
    );
    if (written.matchedCount === 1) return refreshed.accessToken;

    const current = await Cafe.findById(cafeId).select(`+${base}.accessToken`).lean();
    const winner = current?.accountingIntegrations?.[provider]?.accessToken;
    if (!winner) {
      throw integrationError(409, 'INTEGRATION_DISCONNECTED',
        `${PROVIDER_LABELS[provider]} was disconnected while this sync was running.`);
    }
    return decryptSecret(winner);
  });

module.exports = { refreshIntegrationAccessToken, classifyRefreshFailure };
