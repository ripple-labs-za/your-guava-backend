const crypto = require('crypto');
const logger = require('../../src/utils/logger');
const { encryptSecret, decryptSecret, decryptSecretWithStatus, readAndUpgradeSecret } = require('../../src/services/secrets.service');
const KEY = 'a'.repeat(64);
let saved;
beforeEach(() => {
  saved = { current: process.env.TOKEN_ENCRYPTION_KEY, previous: process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS };
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
});
afterEach(() => {
  for (const [name, value] of [['TOKEN_ENCRYPTION_KEY', saved.current], ['TOKEN_ENCRYPTION_KEY_PREVIOUS', saved.previous]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  jest.restoreAllMocks();
});

it.each(['enc:v3:...', 'ENC:V2:...', ' enc:v2:...', 'enc:v2', 'enc:'])(
  'refuses the envelope look-alike %j instead of forwarding or double wrapping it', async (stored) => {
    const model = { updateOne: jest.fn() };
    expect(() => decryptSecretWithStatus(stored)).toThrow(expect.objectContaining({ code: 'SECRET_MALFORMED' }));
    await expect(readAndUpgradeSecret({ model, filter: { _id: 'cafe' }, path: 'token', stored }))
      .rejects.toMatchObject({ code: 'SECRET_MALFORMED' });
    expect(model.updateOne).not.toHaveBeenCalled();
  }
);

it('authenticates the v2 key id as AES-GCM additional data', () => {
  const [, version, kid, iv, tag, ciphertext] = encryptSecret('provider-token').split(':');
  const open = (aad) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString();
  };
  expect(version).toBe('v2');
  expect(open(`v2:${kid}`)).toBe('provider-token');
  expect(() => open()).toThrow();
  expect(() => open('v2:00000000')).toThrow();
  expect(decryptSecret(encryptSecret('provider-token'))).toBe('provider-token');
});

it('rejects non-canonical base64url tag pad bits even when they decode to the authentic tag', () => {
  const parts = encryptSecret('provider-token').split(':');
  const original = Buffer.from(parts[4], 'base64url');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(parts[4].at(-1));
  parts[4] = parts[4].slice(0, -1) + alphabet[last + 1];
  expect(Buffer.from(parts[4], 'base64url')).toEqual(original);
  expect(() => decryptSecret(parts.join(':'))).toThrow(expect.objectContaining({ code: 'SECRET_MALFORMED' }));
});

it('returns a readable legacy token when its optional upgrade write fails and logs only a code', async () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const model = { updateOne: jest.fn().mockRejectedValue(Object.assign(
    new Error('mongodb://user:password@host provider-token-secret'), { code: 'DB_OFFLINE' }
  )) };
  await expect(readAndUpgradeSecret({ model, filter: { _id: 'private-cafe' }, path: 'token', stored: 'provider-token-secret' }))
    .resolves.toBe('provider-token-secret');
  expect(model.updateOne).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('secret_upgrade_failed', { code: 'DB_OFFLINE' });
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/provider-token|password|private-cafe|mongodb/);
});
