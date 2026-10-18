const crypto = require('crypto');
const { outboundGet, outboundPost, toUpstreamError } = require('../utils/http');

const DEFAULT_BASE_URL = 'https://payments.onegate.co.za';
const OFFICIAL_ONEGATE_HOSTS = new Set(['payments.onegate.co.za']);

const cleanBaseUrl = (value) => {
  let url;
  try {
    url = new URL(value || DEFAULT_BASE_URL);
  } catch (_error) {
    throw new Error('ONEGATE_API_URL must be a valid URL');
  }
  if (url.username || url.password) {
    throw new Error('ONEGATE_API_URL must not contain credentials');
  }
  if (process.env.NODE_ENV === 'production') {
    if (url.protocol !== 'https:') {
      throw new Error('ONEGATE_API_URL must use HTTPS in production');
    }
    if (!OFFICIAL_ONEGATE_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error('ONEGATE_API_URL must use the official OneGate payment host in production');
    }
    if ((url.port && url.port !== '443') || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      throw new Error('ONEGATE_API_URL must be the origin of the official OneGate payment host');
    }
  }
  return url.toString().replace(/\/$/, '');
};

const getConfig = () => ({
  baseUrl: cleanBaseUrl(process.env.ONEGATE_API_URL),
  organisationId: process.env.ONEGATE_ORGANISATION_ID || process.env.ONEGATE_ORG_ID,
  apiSalt: process.env.ONEGATE_API_SALT,
});

const isOneGateEnabled = () => process.env.PAYMENT_PROVIDER === 'onegate';

const isOneGateConfigured = () => {
  const config = getConfig();
  return Boolean(config.organisationId && config.apiSalt);
};

const assertConfigured = () => {
  if (!isOneGateConfigured()) {
    const err = new Error('OneGate card payments are not configured');
    err.statusCode = 503;
    throw err;
  }
};

const buildAuthHeaders = () => {
  const config = getConfig();
  assertConfigured();

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const token = crypto
    .createHash('sha256')
    .update(`${config.apiSalt}_${config.organisationId}_${timestamp}`)
    .digest('hex');

  return {
    'Auth-Token': token,
    'Org-Id': config.organisationId,
    Timestamp: timestamp,
  };
};

const appBaseUrl = () =>
  (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');

const clientBaseUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

const isLocalUrl = (value) => {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch (_error) {
    return true;
  }
};

const assertPublicCallbackBaseUrl = () => {
  const baseUrl = appBaseUrl();
  if (isLocalUrl(baseUrl)) {
    const err = new Error(
      'OneGate hosted checkout needs API_PUBLIC_URL to be a public URL for return and webhook callbacks. Use an ngrok, Cloudflare Tunnel, or deployed API URL, then restart the backend.'
    );
    err.statusCode = 400;
    throw err;
  }
};

const returnUrl = (reference, result) =>
  `${appBaseUrl()}/api/account/payments/onegate/return?reference=${encodeURIComponent(reference)}&result=${result}`;

const notifyUrl = () => `${appBaseUrl()}/api/account/payments/onegate/notify`;

const formatAmount = (amount) => Number(amount || 0).toFixed(2);

const createPaymentKey = async ({ reference, amount, customerReference }) => {
  const config = getConfig();
  assertConfigured();
  assertPublicCallbackBaseUrl();

  const body = new URLSearchParams({
    payment_type: 'credit_card',
    amount: formatAmount(amount),
    merchant_reference: reference,
    customer_reference: customerReference || reference,
    currency_code: 'ZAR',
    success_url: returnUrl(reference, 'success'),
    error_url: returnUrl(reference, 'error'),
    cancel_url: returnUrl(reference, 'cancel'),
    pending_url: returnUrl(reference, 'pending'),
    notify_url: notifyUrl(),
  });

  let data;
  try {
    ({ data } = await outboundPost('onegate', `${config.baseUrl}/api/v2/payment-key`, body, {
      headers: {
        ...buildAuthHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }));
  } catch (error) {
    throw toUpstreamError('onegate', error);
  }

  if (!data?.key || !data?.url) {
    const err = new Error(data?.message || 'OneGate did not return a hosted checkout URL');
    err.statusCode = 502;
    err.details = { provider: 'onegate' };
    throw err;
  }

  return data;
};

const lookupGatewayTransaction = async (reference) => {
  const config = getConfig();
  assertConfigured();

  let data;
  try {
    ({ data } = await outboundGet('onegate', `${config.baseUrl}/api/v2/gateway-transaction/`, {
      params: { reference },
      headers: buildAuthHeaders(),
    }));
  } catch (error) {
    throw toUpstreamError('onegate', error);
  }

  if (Array.isArray(data)) return data[0] || null;
  return data || null;
};

const hostedCheckoutReturnUrl = (status, reference) => {
  const url = new URL('/settings', clientBaseUrl());
  url.searchParams.set('section', 'billing');
  url.searchParams.set('payment', status);
  if (reference) url.searchParams.set('reference', reference);
  return url.toString();
};

module.exports = {
  buildAuthHeaders,
  createPaymentKey,
  hostedCheckoutReturnUrl,
  isOneGateConfigured,
  isOneGateEnabled,
  lookupGatewayTransaction,
  cleanBaseUrl,
};
