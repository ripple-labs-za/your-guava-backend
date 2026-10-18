const { outboundGet, outboundPost, isOutboundTimeout } = require('../utils/http');

/**
 * Paystack hosted checkout.
 *
 * Deliberately mirrors the shape of onegate.service.js so the two are
 * interchangeable behind paymentProvider.service.js: createPaymentKey,
 * lookupGatewayTransaction, hostedCheckoutReturnUrl, isConfigured, isEnabled.
 *
 * One meaningful difference from OneGate: settlement does not depend on an
 * inbound callback. Paystack redirects the customer back with the reference,
 * and the server confirms the payment with an outbound verify call. A webhook
 * is still supported for the case where the customer closes the tab before the
 * redirect, but it is a robustness measure rather than a requirement -- which
 * is why this provider works on a laptop with no public URL.
 */

const PAYSTACK_API_URL = 'https://api.paystack.co';
const OFFICIAL_PAYSTACK_HOST = 'api.paystack.co';
const CHECKOUT_ORIGIN = 'https://checkout.paystack.com';

const secretKey = () => (process.env.PAYSTACK_SECRET_KEY || '').trim();

const isConfigured = () => Boolean(secretKey());

const isEnabled = () => process.env.PAYMENT_PROVIDER === 'paystack';

/** True when the configured key is a live key, so callers can refuse real money. */
const isLiveKey = () => secretKey().startsWith('sk_live_');

const assertConfigured = () => {
  if (isConfigured()) return;
  const err = new Error(
    'Paystack is not configured. Set PAYSTACK_SECRET_KEY (use a sk_test_ key outside production).'
  );
  err.statusCode = 503;
  throw err;
};

/**
 * The API origin every authenticated request is built on.
 *
 * validateEnv refuses a non-official PAYSTACK_API_URL at boot; this is the
 * second line for a value that is changed afterwards. The secret key rides on
 * every one of these calls, so an override is only honoured where it cannot
 * hand a live key to another host: never with embedded credentials, and never
 * off the official origin in production. Mirrors onegate.service cleanBaseUrl.
 */
const baseUrl = () => {
  const configured = (process.env.PAYSTACK_API_URL || '').trim();
  if (!configured) return PAYSTACK_API_URL;

  let url;
  try {
    url = new URL(configured);
  } catch (_error) {
    throw new Error('PAYSTACK_API_URL must be a valid URL');
  }
  if (url.username || url.password) {
    throw new Error('PAYSTACK_API_URL must not contain credentials');
  }
  if (process.env.NODE_ENV === 'production') {
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== OFFICIAL_PAYSTACK_HOST) {
      throw new Error('PAYSTACK_API_URL must be the official Paystack API host in production');
    }
  }
  return configured.replace(/\/$/, '');
};

const clientBaseUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

const authHeaders = () => ({
  Authorization: `Bearer ${secretKey()}`,
  'Content-Type': 'application/json',
});

/** Paystack works in the currency subunit, so rand amounts become integer cents. */
const toSubunit = (amount) => Math.round(Number(amount || 0) * 100);
const fromSubunit = (amount) => Number(amount || 0) / 100;

const currency = () => (process.env.PAYSTACK_CURRENCY || 'ZAR').trim().toUpperCase();

/**
 * Where Paystack sends the customer after payment. This points at the API
 * rather than the portal so the server can verify the reference before the
 * customer sees any outcome -- the browser is never the source of truth.
 */
const callbackUrl = () => {
  const apiBase = (
    process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`
  ).replace(/\/$/, '');
  return `${apiBase}/api/account/payments/paystack/return`;
};

const describeAxiosError = (error, fallback) => {
  const body = error?.response?.data;
  const message = body?.message || body?.error || error?.message || fallback;
  const wrapped = new Error(String(message).slice(0, 500));
  wrapped.statusCode = error?.response?.status === 401 ? 503 : 502;
  wrapped.cause = error;
  return wrapped;
};

/**
 * Opens a hosted checkout. Returns the same {key, url, origin} triple OneGate
 * does, so billingPayments stores it without knowing which provider ran.
 */
const createPaymentKey = async ({ reference, amount, customerReference, email }) => {
  assertConfigured();
  if (!email) {
    const err = new Error('A customer email is required to open Paystack checkout');
    err.statusCode = 400;
    throw err;
  }

  try {
    const { data } = await outboundPost('paystack',
      `${baseUrl()}/transaction/initialize`,
      {
        email,
        amount: toSubunit(amount),
        currency: currency(),
        reference,
        callback_url: callbackUrl(),
        metadata: {
          customer_reference: customerReference,
          merchant_reference: reference,
        },
      },
      { headers: authHeaders() }
    );

    const payload = data?.data;
    if (!data?.status || !payload?.authorization_url) {
      throw new Error(data?.message || 'Paystack did not return a checkout URL');
    }

    return {
      key: payload.access_code,
      url: payload.authorization_url,
      origin: CHECKOUT_ORIGIN,
    };
  } catch (error) {
    if (error.statusCode) throw error;
    throw describeAxiosError(error, 'Could not open Paystack checkout');
  }
};

/**
 * Verifies a reference and normalises the result onto the loose shape
 * billingPayments already reads from OneGate (status / successful / amount /
 * currency / merchant_reference / gateway_reference / reason).
 */
const SETTLED_FAILURES = new Set(['failed', 'reversed']);
const successFlag = (status) => {
  if (status === 'success') return true;
  return SETTLED_FAILURES.has(status) ? false : undefined;
};

const digits = (value, length) => new RegExp(`^\\d{${length}}$`).test(String(value ?? ''));

/** Display metadata only; reusable provider credentials are never copied. */
const cardFromAuthorization = (authorization) => {
  if (!authorization || typeof authorization !== 'object') return undefined;
  const brand = String(authorization.brand || authorization.card_type || '').trim().toLowerCase().slice(0, 32);
  const card = {
    ...(brand ? { brand } : {}),
    ...(digits(authorization.last4, 4) ? { last4: String(authorization.last4) } : {}),
    ...(digits(authorization.exp_month, 2) ? { exp_month: String(authorization.exp_month) } : {}),
    ...(digits(authorization.exp_year, 4) ? { exp_year: String(authorization.exp_year) } : {}),
  };
  return card.brand || card.last4 ? card : undefined;
};

const lookupGatewayTransaction = async (reference) => {
  assertConfigured();
  try {
    const { data } = await outboundGet('paystack',
      `${baseUrl()}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: authHeaders() }
    );

    const txn = data?.data;
    if (!txn) return null;

    const status = String(txn.status || '').toLowerCase();
    const card = cardFromAuthorization(txn.authorization);
    return {
      id: txn.id != null ? String(txn.id) : undefined,
      status: txn.status,
      successful: successFlag(status),
      amount: fromSubunit(txn.amount),
      ...(txn.requested_amount != null ? { requestedAmount: fromSubunit(txn.requested_amount) } : {}),
      currency: txn.currency,
      merchant_reference: txn.reference,
      reference: txn.reference,
      gateway_reference: txn.id ? String(txn.id) : undefined,
      reason: txn.gateway_response,
      ...(card ? { authorization: card } : {}),
    };
  } catch (error) {
    if (isOutboundTimeout(error)) throw error;
    // An unknown reference is a legitimate "nothing settled yet", not a fault.
    if (error?.response?.status === 404) return null;
    throw describeAxiosError(error, 'Could not verify the Paystack transaction');
  }
};

const hostedCheckoutReturnUrl = (status, reference) => {
  const url = new URL('/settings', clientBaseUrl());
  url.searchParams.set('section', 'billing');
  url.searchParams.set('payment', status);
  if (reference) url.searchParams.set('reference', reference);
  return url.toString();
};

module.exports = {
  createPaymentKey,
  lookupGatewayTransaction,
  hostedCheckoutReturnUrl,
  isConfigured,
  isEnabled,
  isLiveKey,
  callbackUrl,
  toSubunit,
  fromSubunit,
};
