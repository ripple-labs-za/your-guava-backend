const crypto = require('crypto');
const { planSecretUpgrades } = require('../../src/migrations/reencrypt-secrets');
const Cafe = require('../../src/models/Cafe.model');
const { encryptSecret } = require('../../src/services/secrets.service');

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

describe('reencrypt-secrets migration plan', () => {
  let saved;

  beforeEach(() => {
    saved = { current: process.env.TOKEN_ENCRYPTION_KEY, previous: process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS };
  });

  afterEach(() => {
    if (saved.current == null) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved.current;
    if (saved.previous == null) delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
    else process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = saved.previous;
  });

  it('lists every plaintext, v1 or previous-key secret and nothing already current', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const underA = encryptSecret('a-token');
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = KEY_A;
    const underB = encryptSecret('b-token');
    const iv = Buffer.alloc(12, 2);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY_A, 'hex'), iv);
    const bytes = Buffer.concat([cipher.update('v1-token'), cipher.final()]);
    const v1 = `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${bytes.toString('base64url')}`;
    const cafes = [{
      _id: 'cafe-1',
      yocoTokens: { accessToken: 'plain-access', refreshToken: underB },
      accountingIntegrations: { xero: { accessToken: v1, refreshToken: underA } },
    }];

    const { upgrades, failures } = planSecretUpgrades(cafes, Cafe.secretPaths());

    expect(upgrades.map(({ cafeId, path, reason }) => ({ cafeId, path, reason }))).toEqual([
      { cafeId: 'cafe-1', path: 'yocoTokens.accessToken', reason: 'plaintext' },
      { cafeId: 'cafe-1', path: 'accountingIntegrations.xero.accessToken', reason: 'v1' },
      { cafeId: 'cafe-1', path: 'accountingIntegrations.xero.refreshToken', reason: 'previous-key' },
    ]);
    expect(failures).toEqual([]);
  });

  it('reports a secret no configured key can open, without its value', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const underA = encryptSecret('a-token');
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;

    const { upgrades, failures } = planSecretUpgrades(
      [{ _id: 'cafe-2', yocoTokens: { accessToken: underA } }],
      Cafe.secretPaths()
    );

    expect(upgrades).toEqual([]);
    expect(failures).toEqual([{ cafeId: 'cafe-2', path: 'yocoTokens.accessToken', code: 'SECRET_KEY_UNAVAILABLE' }]);
  });

  it('does not load dotenv or connect to a database when imported', () => {
    // rotate (BE-12-T03) is the CLI's work as a function; importing still runs nothing.
    expect(Object.keys(require('../../src/migrations/reencrypt-secrets')).sort())
      .toEqual(['applySecretUpgrades', 'planSecretUpgrades', 'rotate']);
  });
});
