const logger = require('../../src/utils/logger');
const validateEnv = require('../../src/config/validateEnv');

const BASE_KEYS = [
  'ANTHROPIC_MODEL', 'AI_MODEL_CHAT', 'AI_MODEL_INSIGHTS', 'AI_MODEL_COLUMN_MAPPING', 'AI_MODEL_MENU_REVIEW',
  'RATE_LIMITS_ENABLED',
  'BACKGROUND_JOBS_INLINE',
  'ORIGIN_CHECKS_ENABLED',
  'READINESS_TOKEN',
  'NODE_ENV',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'MONGODB_URI',
  'CLIENT_URL',
  'PAYMENT_PROVIDER',
  'ONEGATE_ORGANISATION_ID',
  'ONEGATE_ORG_ID',
  'ONEGATE_API_SALT',
  'ONEGATE_API_URL',
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_API_URL',
  'PAYSTACK_CURRENCY',
  'API_PUBLIC_URL',
  'BILLING_MOCK_ENABLED',
  'TOKEN_ENCRYPTION_KEY', 'TOKEN_ENCRYPTION_KEY_PREVIOUS', 'DOWNLOAD_SIGNING_SECRET',
  'YOCO_INTEGRATION_ENABLED',
  'YOCO_CLIENT_ID',
  'YOCO_CLIENT_SECRET',
  'YOCO_REDIRECT_URI',
  'YOCO_API_URL',
  'YOCO_IAM_URL',
  'YOCO_WEBHOOK_SECRET',
  'ACCOUNTING_INTEGRATIONS_ENABLED',
  'WORKFORCE_ENABLED',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'ANTHROPIC_API_KEY',
  'WEATHER_API_KEY',
  'WEATHER_API_URL',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
];

const fs = require('fs');
const path = require('path');
const { NUMERIC_ENV, URL_ENV, isPlaceholder } = require('../../src/config/envSpec');

const ENV_EXAMPLE = fs.readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8');
const exampleEntries = ENV_EXAMPLE.split(/\r?\n/)
  .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
  .filter(Boolean)
  .map(([, name, raw]) => [name, raw.trim().replace(/^"(.*)"$/, '$1')]);
const shippedPlaceholders = exampleEntries.filter(([, value]) => isPlaceholder(value));

// TZ is left alone: deleting it mid-run changes the process timezone for everything after.
const KEYS = [...new Set([
  ...BASE_KEYS,
  ...Object.keys(NUMERIC_ENV),
  ...Object.keys(URL_ENV),
  ...exampleEntries.map(([name]) => name),
  'ESKOMSEPUSH_API_KEY',
  'LOG_LEVEL',
])].filter((name) => name !== 'TZ');

const setDevelopmentBaseEnv = () => {
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'dev-secret';
  process.env.JWT_REFRESH_SECRET = 'dev-refresh-secret';
  process.env.MONGODB_URI = 'mongodb://localhost:27199/guava-dev';
  // BE-02-T06 requires CLIENT_URL whenever NODE_ENV is not 'test'.
  process.env.CLIENT_URL = 'http://localhost:5185';
  process.env.DOWNLOAD_SIGNING_SECRET = 'local-download-signing-secret-0123456789';
};

const snapshotEnv = () =>
  KEYS.reduce((snapshot, key) => {
    snapshot[key] = process.env[key];
    return snapshot;
  }, {});

const restoreEnv = (snapshot) => {
  for (const key of KEYS) {
    if (snapshot[key] == null) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
};

const setProductionBaseEnv = () => {
  process.env.NODE_ENV = 'production';
  // The test env sets these switches (tests/env.js); a production run starts from the production defaults.
  delete process.env.RATE_LIMITS_ENABLED;
  delete process.env.BACKGROUND_JOBS_INLINE;
  delete process.env.ORIGIN_CHECKS_ENABLED;
  delete process.env.BCRYPT_ROUNDS;
  process.env.JWT_SECRET = 'x'.repeat(32);
  process.env.JWT_REFRESH_SECRET = 'y'.repeat(32);
  process.env.MONGODB_URI = 'mongodb://localhost:27017/guava-test';
  process.env.CLIENT_URL = 'https://app.yourguava.example';
  process.env.TOKEN_ENCRYPTION_KEY = 'z'.repeat(32);
  process.env.R2_ACCOUNT_ID = 'test-account';
  process.env.R2_ACCESS_KEY_ID = 'test-access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
  process.env.R2_BUCKET_NAME = 'test-bucket';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.WEATHER_API_KEY = 'test-weather-key';
  process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.RESEND_FROM_EMAIL = 'Your Guava <hello@yourguava.example>';
};

const setProductionBillingEnv = () => {
  process.env.PAYMENT_PROVIDER = 'onegate';
  process.env.ONEGATE_ORGANISATION_ID = '21234';
  process.env.ONEGATE_API_SALT = 'test-salt';
  process.env.ONEGATE_API_URL = 'https://payments.onegate.co.za';
  process.env.API_PUBLIC_URL = 'https://api.yourguava.example';
};

// Paystack is the provider the product actually launches on, so its branch of
// validateEnv is the one that will run in production.
const setProductionPaystackEnv = () => {
  process.env.PAYMENT_PROVIDER = 'paystack';
  process.env.PAYSTACK_SECRET_KEY = 'sk_live_realkeyvalue';
  process.env.API_PUBLIC_URL = 'https://api.yourguava.example';
};

describe('validateEnv', () => {
  it.each(['true', 'TRUE', ' true '])(
    'rejects production startup with workforce enabled as %s (D-003)',
    (flag) => {
      setProductionBaseEnv();
      setProductionBillingEnv();
      process.env.WORKFORCE_ENABLED = flag;
      expect(() => validateEnv()).toThrow(
        /WORKFORCE_ENABLED must remain false in production until the workforce feature is complete/i
      );
    }
  );

  it.each([undefined, 'false', '1', 'yes'])(
    'allows production startup with the workforce flag off as %s',
    (flag) => {
      setProductionBaseEnv();
      setProductionBillingEnv();
      if (flag === undefined) delete process.env.WORKFORCE_ENABLED;
      else process.env.WORKFORCE_ENABLED = flag;
      expect(() => validateEnv()).not.toThrow();
    }
  );

  it.each(['staging', 'preview'])('refuses unknown AI models in hardened %s', (environment) => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.NODE_ENV = environment;
    process.env.AI_MODEL_CHAT = 'mistyped-model';
    expect(() => validateEnv()).toThrow(/AI_MODEL_CHAT.*unknown model mistyped-model/);
  });

  it('reports all four features when only the legacy production model is mistyped', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.ANTHROPIC_MODEL = 'mistyped-model';
    let error;
    try { validateEnv(); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(error.message.match(/unknown model mistyped-model/g)).toHaveLength(4);
  });

  it('warns without throwing about an unknown development model', () => {
    process.env.NODE_ENV = 'development';
    process.env.MONGODB_URI = 'mongodb://localhost:27199/test';
    process.env.JWT_SECRET = 'development-secret';
    process.env.JWT_REFRESH_SECRET = 'development-refresh';
    process.env.CLIENT_URL = 'http://localhost:5185';
    process.env.AI_MODEL_CHAT = 'mistyped-model';
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(() => validateEnv()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('env_warning', { message: expect.stringMatching(/AI_MODEL_CHAT.*unknown model mistyped-model/) });
  });
  it('rejects production startup when an AI feature has no request rules', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.AI_MODEL_CHAT = 'claude-sonnet-4';
    expect(() => validateEnv()).toThrow(/AI_MODEL_CHAT \(or ANTHROPIC_MODEL\) names unknown model claude-sonnet-4/);
  });

  it('rejects a Paystack currency other than ZAR', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'dev-secret';
    process.env.JWT_REFRESH_SECRET = 'dev-refresh-secret';
    process.env.MONGODB_URI = 'mongodb://localhost:27199/guava-test';
    process.env.CLIENT_URL = 'http://localhost:5185';
    process.env.PAYSTACK_CURRENCY = 'NGN';
    expect(() => validateEnv()).toThrow(/PAYSTACK_CURRENCY must be ZAR/);
    process.env.PAYSTACK_CURRENCY = 'zar';
    expect(() => validateEnv()).not.toThrow();
  });
  let env;

  beforeEach(() => {
    env = snapshotEnv();
    validateEnv.resetEnvWarnings();
    for (const key of KEYS) delete process.env[key];
    process.env.DOWNLOAD_SIGNING_SECRET = 'test-download-signing-secret-0123456789';
  });

  afterEach(() => {
    restoreEnv(env);
    jest.restoreAllMocks();
  });

  it('rejects production startup without a real billing provider by default', () => {
    setProductionBaseEnv();

    expect(() => validateEnv()).toThrow(/PAYMENT_PROVIDER.*onegate/i);
  });

  it('allows production startup with OneGate billing configured', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects production startup when durable upload storage is incomplete', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    delete process.env.R2_SECRET_ACCESS_KEY;

    expect(() => validateEnv()).toThrow(/R2_SECRET_ACCESS_KEY is required/i);
  });

  it('requires an independent production token-encryption key', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    delete process.env.TOKEN_ENCRYPTION_KEY;

    expect(() => validateEnv()).toThrow(/TOKEN_ENCRYPTION_KEY is required/i);
  });

  it('rejects insecure public production URLs', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.CLIENT_URL = 'http://app.yourguava.example';

    expect(() => validateEnv()).toThrow(/CLIENT_URL must be a valid HTTPS URL/i);
  });

  it('rejects non-HTTPS or non-OneGate payment API origins in production', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.ONEGATE_API_URL = 'http://payments.onegate.co.za';
    expect(() => validateEnv()).toThrow(/ONEGATE_API_URL.*official OneGate/i);

    process.env.ONEGATE_API_URL = 'https://payments.attacker.example';
    expect(() => validateEnv()).toThrow(/ONEGATE_API_URL.*official OneGate/i);
  });

  it('allows production startup with Paystack billing configured', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects production startup without a Paystack secret key', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    delete process.env.PAYSTACK_SECRET_KEY;

    expect(() => validateEnv()).toThrow(/PAYSTACK_SECRET_KEY is required/i);
  });

  it('rejects a Paystack test key in production', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc123';

    expect(() => validateEnv()).toThrow(/PAYSTACK_SECRET_KEY must be a live key/i);
  });

  it('rejects a Paystack API base URL that is not the official HTTPS origin', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();

    // The live secret key travels on every request built from this base URL.
    process.env.PAYSTACK_API_URL = 'http://api.paystack.co';
    expect(() => validateEnv()).toThrow(/PAYSTACK_API_URL.*official Paystack/i);

    process.env.PAYSTACK_API_URL = 'https://api.attacker.example';
    expect(() => validateEnv()).toThrow(/PAYSTACK_API_URL.*official Paystack/i);

    process.env.PAYSTACK_API_URL = 'https://user:pass@api.paystack.co';
    expect(() => validateEnv()).toThrow(/PAYSTACK_API_URL.*official Paystack/i);

    process.env.PAYSTACK_API_URL = 'https://api.paystack.co/v1?debug=1';
    expect(() => validateEnv()).toThrow(/PAYSTACK_API_URL.*official Paystack/i);

    process.env.PAYSTACK_API_URL = 'https://api.paystack.co';
    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects production startup when a core service is unavailable', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    delete process.env.RESEND_API_KEY;

    expect(() => validateEnv()).toThrow(/RESEND_API_KEY is required/i);
  });

  it('rejects production mock billing even when explicitly enabled', () => {
    setProductionBaseEnv();
    process.env.BILLING_MOCK_ENABLED = 'true';

    expect(() => validateEnv()).toThrow(/BILLING_MOCK_ENABLED cannot be true/i);
  });

  it('does not warn about Yoco webhook secrets while the legacy Yoco integration is disabled', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('requires full legacy Yoco config when Yoco is explicitly enabled outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'dev-secret';
    process.env.JWT_REFRESH_SECRET = 'dev-refresh-secret';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/guava-dev';
    process.env.YOCO_INTEGRATION_ENABLED = 'true';

    expect(() => validateEnv()).toThrow(/YOCO_CLIENT_ID.*YOCO_WEBHOOK_SECRET/s);
  });

  it('rejects production startup when the legacy Yoco integration is enabled', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.YOCO_INTEGRATION_ENABLED = 'true';
    process.env.YOCO_CLIENT_ID = 'yoco-client';
    process.env.YOCO_CLIENT_SECRET = 'yoco-secret';
    process.env.YOCO_REDIRECT_URI = 'https://app.yourguava.example/connect';
    process.env.YOCO_API_URL = 'https://api.yoco.example';
    process.env.YOCO_IAM_URL = 'https://iam.yoco.example';
    process.env.YOCO_WEBHOOK_SECRET = 'whsec_test';

    expect(() => validateEnv()).toThrow(/YOCO_INTEGRATION_ENABLED must remain false in production/i);
  });

  it('rejects production startup when accounting integrations are enabled before posting is implemented', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';

    expect(() => validateEnv()).toThrow(/ACCOUNTING_INTEGRATIONS_ENABLED must remain false in production/i);
  });

  it('requires CLIENT_URL outside tests and strong secrets on staging, but leaves mock billing to D-010', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'dev-secret';
    process.env.JWT_REFRESH_SECRET = 'dev-refresh-secret';
    process.env.MONGODB_URI = 'mongodb://localhost:27017/guava-dev';
    expect(() => validateEnv()).toThrow(/CLIENT_URL is required/);
    process.env.CLIENT_URL = 'http://localhost:5185';
    expect(() => validateEnv()).not.toThrow();

    process.env.NODE_ENV = 'staging';
    process.env.CLIENT_URL = 'https://staging.yourguava.example';
    process.env.BILLING_MOCK_ENABLED = 'true';
    expect(() => validateEnv()).toThrow(/JWT_SECRET must be at least 32 characters outside development and test/);
    process.env.JWT_SECRET = 'x'.repeat(32);
    process.env.JWT_REFRESH_SECRET = 'y'.repeat(32);
    process.env.TOKEN_ENCRYPTION_KEY = 'z'.repeat(32);
    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects production startup with rate limits switched off', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.RATE_LIMITS_ENABLED = 'false';
    expect(() => validateEnv()).toThrow(/RATE_LIMITS_ENABLED cannot be false in production/);
  });

  it('rejects production startup with background jobs forced inline', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.BACKGROUND_JOBS_INLINE = 'true';
    expect(() => validateEnv()).toThrow(/BACKGROUND_JOBS_INLINE cannot be true in production/);
  });

  it('rejects a staging startup with origin checks switched off', () => {
    setProductionBaseEnv();
    setProductionBillingEnv();
    process.env.NODE_ENV = 'staging';
    process.env.ORIGIN_CHECKS_ENABLED = 'false';
    expect(() => validateEnv()).toThrow(/ORIGIN_CHECKS_ENABLED cannot be false outside development and test/);
    process.env.NODE_ENV = 'development';
    expect(() => validateEnv()).not.toThrow(/ORIGIN_CHECKS_ENABLED/);
  });
describe('placeholders', () => {
  it('recognises the placeholders .env.example still ships', () => {
    expect(shippedPlaceholders.map(([name]) => name)).toEqual(
      expect.arrayContaining(['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ANTHROPIC_API_KEY', 'WEATHER_API_KEY'])
    );
  });

  it.each(shippedPlaceholders)('refuses to boot production with %s left at its .env.example value', (name, value) => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env[name] = value;
    expect(() => validateEnv()).toThrow(new RegExp(`${name}[^\\n]*placeholder`, 'i'));
  });

  it('refuses the sender address older .env.example files shipped', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.RESEND_FROM_EMAIL = 'Your Guava <hello@yourdomain.com>';
    expect(() => validateEnv()).toThrow(/RESEND_FROM_EMAIL[^\n]*placeholder/i);
  });

  it('refuses the EskomSePush placeholder older .env.example files shipped', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.ESKOMSEPUSH_API_KEY = 'your_eskomsepush_api_key_here';
    expect(() => validateEnv()).toThrow(/ESKOMSEPUSH_API_KEY[^\n]*placeholder/i);
  });

  it('only warns about an optional placeholder outside production, once', () => {
    setDevelopmentBaseEnv();
    validateEnv.resetEnvWarnings();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env.ESKOMSEPUSH_API_KEY = 'your_eskomsepush_api_key_here';
    expect(() => validateEnv()).not.toThrow();
    validateEnv();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('env_warning', { message: expect.stringMatching(/ESKOMSEPUSH_API_KEY/) });
  });

  it('accepts .env.example as a development env once required local secrets are supplied', () => {
    for (const [name, value] of exampleEntries) {
      if (name !== 'TZ') process.env[name] = value;
    }
    setDevelopmentBaseEnv();
    expect(() => validateEnv()).not.toThrow();
  });
});

describe('numeric settings', () => {
  it('uses the production numeric rules for a normalised NODE_ENV', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.NODE_ENV = ' Production';
    process.env.UPLOAD_MAX_BYTES = '10MB';
    expect(() => validateEnv()).toThrow(/UPLOAD_MAX_BYTES must be a whole number with no units/);
  });

  it('requires production storage for a normalised NODE_ENV', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.NODE_ENV = 'Production';
    delete process.env.R2_ACCOUNT_ID;
    expect(() => validateEnv()).toThrow(/R2_ACCOUNT_ID is required for production upload storage/);
  });

  it('keeps staging on the non-production storage and numeric rules', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.NODE_ENV = ' staging ';
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
      delete process.env[name];
    }
    process.env.DOWNLOAD_SIGNING_SECRET = 'local-download-signing-secret-0123456789';
    process.env.UPLOAD_MAX_BYTES = '10MB';
    expect(() => validateEnv()).not.toThrow();
  });

  it.each(Object.entries(NUMERIC_ENV))('refuses %s outside its range in production', (name, { min, max }) => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
      process.env[name] = String(max + 1);
      expect(() => validateEnv()).toThrow(new RegExp(`${name} must be between ${min} and ${max}`));
      process.env[name] = String(min - 1);
      expect(() => validateEnv()).toThrow(new RegExp(name));
      process.env[name] = String(name === 'BCRYPT_ROUNDS' ? 10 : min);
      expect(() => validateEnv()).not.toThrow();
      process.env[name] = String(max);
      expect(() => validateEnv()).not.toThrow();
  });

  it('refuses a unit typo that parseInt would silently read as 10 bytes', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.UPLOAD_MAX_BYTES = '10MB';
    expect(() => validateEnv()).toThrow(/UPLOAD_MAX_BYTES must be a whole number with no units/);
  });

  it('only warns outside production, because the use site clamps the value', () => {
    setDevelopmentBaseEnv();
    validateEnv.resetEnvWarnings();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env.UPLOAD_MAX_ROWS = '999999';
    expect(() => validateEnv()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('env_warning', {
      message: expect.stringMatching(/UPLOAD_MAX_ROWS must be between 1 and 25000/),
    });
  });
});

  describe('URL settings', () => {
    it.each(Object.keys(URL_ENV))('refuses a non-http URL or embedded credentials in %s', (name) => {
      setDevelopmentBaseEnv();
      process.env[name] = 'ftp://example.invalid/callback';
      expect(() => validateEnv()).toThrow(new RegExp(`${name} must be an http\\(s\\) URL`));
      process.env[name] = 'https://user:private-secret@example.invalid/callback';
      let failure;
      try { validateEnv(); } catch (error) { failure = error; }
      expect(failure).toBeDefined();
      expect(failure.message).toContain(`${name} must not contain credentials`);
      expect(failure.message).not.toContain('private-secret');
    });
  it('refuses a CLIENT_URL with a trailing slash in every environment, because CORS echoes it literally', () => {
    setDevelopmentBaseEnv();
    process.env.CLIENT_URL = 'http://localhost:5185/';
    expect(() => validateEnv()).toThrow(/CLIENT_URL must be a bare origin/);
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.CLIENT_URL = 'https://app.yourguava.example/';
    expect(() => validateEnv()).toThrow(/CLIENT_URL must be a bare origin/);
    process.env.CLIENT_URL = 'https://app.yourguava.example';
    expect(() => validateEnv()).not.toThrow();
  });

  it('refuses an API_PUBLIC_URL ending in a slash, which doubles the slash in every callback URL', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.API_PUBLIC_URL = 'https://api.yourguava.example/';
    expect(() => validateEnv()).toThrow(/API_PUBLIC_URL must not end with a slash/);
  });

  it('keeps the Anthropic key on the official host in production', () => {
    setProductionBaseEnv();
    setProductionPaystackEnv();
    process.env.ANTHROPIC_BASE_URL = 'https://llm-proxy.attacker.example';
    expect(() => validateEnv()).toThrow(/ANTHROPIC_BASE_URL must be unset or https:\/\/api\.anthropic\.com in production/);
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    expect(() => validateEnv()).not.toThrow();
  });

  it('allows the local AI stub outside production', () => {
    setDevelopmentBaseEnv();
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:5199';
    expect(() => validateEnv()).not.toThrow();
  });

  it('refuses a redirect URI that is not an http(s) URL, and one that carries credentials', () => {
    setDevelopmentBaseEnv();
    process.env.XERO_REDIRECT_URI = 'localhost:5173/integrations/xero/callback';
    expect(() => validateEnv()).toThrow(/XERO_REDIRECT_URI must be an http\(s\) URL/);
    process.env.XERO_REDIRECT_URI = 'https://user:secret@app.yourguava.example/integrations/xero/callback';
    expect(() => validateEnv()).toThrow(/XERO_REDIRECT_URI must not contain credentials/);
  });
});

});
