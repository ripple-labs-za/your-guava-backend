const { parseTrustProxyHops } = require('./proxy');
const { isHardenedEnvironment } = require('./posture');
const { originChecksEnabled } = require('./flags');
const PLACEHOLDER_VALUES = new Set([
  'your_jwt_secret_here',
  'your_jwt_refresh_secret_here',
  'your_anthropic_api_key_here',
  'your_weatherapi_key_here',
]);

const enabled = (name) => String(process.env[name] || '').toLowerCase() === 'true';

const REQUIRED_YOCO_ENV = [
  'YOCO_CLIENT_ID',
  'YOCO_CLIENT_SECRET',
  'YOCO_REDIRECT_URI',
  'YOCO_API_URL',
  'YOCO_IAM_URL',
  'YOCO_WEBHOOK_SECRET',
];

const REQUIRED_R2_ENV = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
];

const REQUIRED_PRODUCTION_SERVICES = [
  'ANTHROPIC_API_KEY',
  'WEATHER_API_KEY',
  'WEATHER_API_URL',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
];

const isHttpsUrl = (value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch (_) {
    return false;
  }
};

const isOfficialOrigin = (value, fallback, hostname) => {
  try {
    const url = new URL(value || fallback);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === hostname &&
      (!url.port || url.port === '443') &&
      !url.username &&
      !url.password &&
      ['', '/'].includes(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch (_) {
    return false;
  }
};

const isOfficialOneGateUrl = (value) =>
  isOfficialOrigin(value, 'https://payments.onegate.co.za', 'payments.onegate.co.za');

// The live Paystack secret key is sent as a bearer token on every request built
// from this base URL, so an override that redirects it hands the key -- which
// can charge cards and read the whole merchant account -- to whoever owns the
// host. It gets the same treatment as the OneGate origin.
const isOfficialPaystackUrl = (value) =>
  isOfficialOrigin(value, 'https://api.paystack.co', 'api.paystack.co');

/**
 * Validates required environment variables at startup.
 * Throws on fatal misconfiguration so the server refuses to boot
 * rather than running insecurely.
 */
const validateEnv = () => {
  const errors = [];
  const isProduction = process.env.NODE_ENV === 'production';
  const yocoEnabled = enabled('YOCO_INTEGRATION_ENABLED');
  const accountingEnabled = enabled('ACCOUNTING_INTEGRATIONS_ENABLED');

  for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'MONGODB_URI']) {
    if (!process.env[name]) {
      errors.push(`${name} is required`);
    } else if (PLACEHOLDER_VALUES.has(process.env[name])) {
      errors.push(`${name} is still set to its placeholder value`);
    }
  }

  if (yocoEnabled) {
    for (const name of REQUIRED_YOCO_ENV) {
      if (!process.env[name]) {
        errors.push(`${name} is required when YOCO_INTEGRATION_ENABLED=true`);
      }
    }
  }

  // TRUST_PROXY_HOPS: a whole number from 0 to 5 (src/config/proxy.js); a bad value stops boot instead of trusting a guess.
  const proxy = parseTrustProxyHops();
  if (proxy.error) errors.push(proxy.error);

  if (!process.env.CLIENT_URL) {
    errors.push('CLIENT_URL is required: it is the CORS origin and the only origin trusted for cookie-setting requests');
  }
  if (isHardenedEnvironment() && !originChecksEnabled()) {
    errors.push('ORIGIN_CHECKS_ENABLED cannot be false outside development and test');
  }
  const readinessToken = process.env.READINESS_TOKEN;
  if (readinessToken && readinessToken.length < 32) {
    errors.push('READINESS_TOKEN must be at least 32 characters when it is set');
  }
  if (isHardenedEnvironment() && !isProduction) {
    // Staging and preview hold sessions and tokens too; mock billing stays their choice (D-010), weak secrets do not.
    for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'TOKEN_ENCRYPTION_KEY']) {
      if ((process.env[name] || '').length < 32) errors.push(`${name} must be at least 32 characters outside development and test`);
    }
    if (process.env.CLIENT_URL && !isHttpsUrl(process.env.CLIENT_URL)) {
      errors.push('CLIENT_URL must be a valid HTTPS URL outside development and test');
    }
  }

  if (process.env.BCRYPT_ROUNDS && isHardenedEnvironment() && Number.parseInt(process.env.BCRYPT_ROUNDS, 10) < 10) {
    errors.push('BCRYPT_ROUNDS cannot be below 10 outside development and test');
  }

  const paystackCurrency = (process.env.PAYSTACK_CURRENCY || '').trim().toUpperCase();
  if (paystackCurrency && paystackCurrency !== 'ZAR') {
    errors.push('PAYSTACK_CURRENCY must be ZAR (payment sessions are priced in ZAR)');
  }

  if (isProduction) {
    if ((process.env.JWT_SECRET || '').length < 32) {
      errors.push('JWT_SECRET must be at least 32 characters in production');
    }
    if ((process.env.JWT_REFRESH_SECRET || '').length < 32) {
      errors.push('JWT_REFRESH_SECRET must be at least 32 characters in production');
    }
    if (!process.env.CLIENT_URL) {
      errors.push('CLIENT_URL is required in production (CORS origin)');
    } else if (!isHttpsUrl(process.env.CLIENT_URL)) {
      errors.push('CLIENT_URL must be a valid HTTPS URL in production');
    }
    if (!process.env.TOKEN_ENCRYPTION_KEY) {
      errors.push('TOKEN_ENCRYPTION_KEY is required in production and must be independent from JWT_SECRET');
    } else if (process.env.TOKEN_ENCRYPTION_KEY === process.env.JWT_SECRET) {
      errors.push('TOKEN_ENCRYPTION_KEY must be independent from JWT_SECRET in production');
    } else if (process.env.TOKEN_ENCRYPTION_KEY.length < 32) {
      errors.push('TOKEN_ENCRYPTION_KEY must be at least 32 characters in production');
    }
    if (enabled('BILLING_MOCK_ENABLED')) {
      errors.push('BILLING_MOCK_ENABLED cannot be true in production');
    }
    if (String(process.env.RATE_LIMITS_ENABLED || '').trim().toLowerCase() === 'false') {
      errors.push('RATE_LIMITS_ENABLED cannot be false in production');
    }
    if (enabled('BACKGROUND_JOBS_INLINE')) {
      errors.push('BACKGROUND_JOBS_INLINE cannot be true in production');
    }
    const paymentProviderName = (process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
    if (!['paystack', 'onegate'].includes(paymentProviderName)) {
      errors.push('PAYMENT_PROVIDER must be set to "paystack" (or "onegate") in production');
    }

    if (paymentProviderName === 'paystack') {
      const paystackKey = (process.env.PAYSTACK_SECRET_KEY || '').trim();
      if (!paystackKey) {
        errors.push('PAYSTACK_SECRET_KEY is required for production billing');
      } else if (!paystackKey.startsWith('sk_live_')) {
        // A test key in production takes real orders and settles none of them.
        errors.push('PAYSTACK_SECRET_KEY must be a live key (sk_live_...) in production');
      }
      if (!isOfficialPaystackUrl(process.env.PAYSTACK_API_URL)) {
        errors.push('PAYSTACK_API_URL must be the HTTPS origin of the official Paystack API host');
      }
    }

    if (paymentProviderName === 'onegate') {
      if (!process.env.ONEGATE_ORGANISATION_ID && !process.env.ONEGATE_ORG_ID) {
        errors.push('ONEGATE_ORGANISATION_ID or ONEGATE_ORG_ID is required for production billing');
      }
      if (!process.env.ONEGATE_API_SALT) {
        errors.push('ONEGATE_API_SALT is required for production billing');
      }
      if (!isOfficialOneGateUrl(process.env.ONEGATE_API_URL)) {
        errors.push('ONEGATE_API_URL must be the HTTPS origin of the official OneGate payment host');
      }
    }

    // Both providers redirect the customer back through API_PUBLIC_URL, so it
    // has to be publicly resolvable in production. Locally it can stay on
    // localhost, because the browser doing the redirect is the same machine --
    // which is why Paystack needs no tunnel for development.
    if (!process.env.API_PUBLIC_URL) {
      errors.push('API_PUBLIC_URL is required in production for payment return and webhook callbacks');
    } else if (!isHttpsUrl(process.env.API_PUBLIC_URL)) {
      errors.push('API_PUBLIC_URL must be a valid HTTPS URL in production');
    }
    for (const name of REQUIRED_R2_ENV) {
      if (!process.env[name]) errors.push(`${name} is required for production upload storage`);
    }
    for (const name of REQUIRED_PRODUCTION_SERVICES) {
      if (!process.env[name] || PLACEHOLDER_VALUES.has(process.env[name])) {
        errors.push(`${name} is required and cannot be a placeholder in production`);
      }
    }
    if (process.env.WEATHER_API_URL && !isHttpsUrl(process.env.WEATHER_API_URL)) {
      errors.push('WEATHER_API_URL must be a valid HTTPS URL in production');
    }
    if (yocoEnabled) {
      errors.push('YOCO_INTEGRATION_ENABLED must remain false in production for MVP');
    }
    if (accountingEnabled) {
      errors.push(
        'ACCOUNTING_INTEGRATIONS_ENABLED must remain false in production until provider posting is implemented'
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n - ${errors.join('\n - ')}`);
  }
};

module.exports = validateEnv;
