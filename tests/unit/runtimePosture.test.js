const { execFileSync } = require('child_process');
const path = require('path');
const posture = require('../../src/config/posture');
const paymentProvider = require('../../src/services/paymentProvider.service');
const r2 = require('../../src/services/r2.service');
const oneGate = require('../../src/services/onegate.service');

describe('normalised production runtime posture', () => {
  const savedEnv = { ...process.env };
  afterEach(() => { process.env = { ...savedEnv }; });

  it.each([
    ['production', true], [' Production', true], ['PRODUCTION ', true],
    ['staging', false], ['development', false], ['test', false], ['', false],
  ])('recognises %p as production=%p without changing staging rules', (value, expected) => {
    process.env.NODE_ENV = value;
    expect(posture.isProductionEnv()).toBe(expected);
  });

  it('does not report payments ready for spaced production without a provider', () => {
    process.env.NODE_ENV = ' Production';
    delete process.env.PAYMENT_PROVIDER;
    expect(paymentProvider.paymentCapability()).toEqual(expect.objectContaining({ ok: false, configured: false }));
  });

  it('refuses local storage fallback for spaced production without R2', async () => {
    process.env.NODE_ENV = ' Production';
    for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
      delete process.env[key];
    }
    expect(r2.getConfigurationStatus().ok).toBe(false);
    await expect(r2.getSignedDownloadUrl('runtime-posture.csv', 60)).rejects.toThrow(/required in production/);
  });

  it('keeps spaced production OneGate credentials on the official HTTPS host', () => {
    process.env.NODE_ENV = ' Production';
    expect(() => oneGate.cleanBaseUrl('https://attacker.invalid')).toThrow(/official OneGate/);
  });

  it('has no direct literal NODE_ENV comparisons outside the posture module', () => {
    let matches;
    try {
      matches = execFileSync('git', [
        'grep', '--no-index', '-nE', 'process\\.env\\.NODE_ENV[[:space:]]*[!=]=+[[:space:]]*[\x27\x22]|[\x27\x22][^\x27\x22]*[\x27\x22][[:space:]]*[!=]=+[[:space:]]*process\\.env\\.NODE_ENV',
        '--', 'src', ':!src/config/posture.js',
      ], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
    } catch (error) {
      if (error.status !== 1) throw error;
      matches = error.stdout;
    }
    expect(matches).toBe('');
  });
});
