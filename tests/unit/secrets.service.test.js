process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-12345';

const { encryptSecret, decryptSecret, decryptSecretWithStatus, currentKeyId, isEncrypted } = require('../../src/services/secrets.service');

describe('secrets service', () => {
  it('round-trips a secret', () => {
    const encrypted = encryptSecret('super-secret-oauth-token');
    expect(encrypted).toMatch(/^enc:v2:[0-9a-f]{8}:/);
    expect(encrypted).not.toContain('super-secret-oauth-token');
    expect(decryptSecret(encrypted)).toBe('super-secret-oauth-token');
  });

  it('produces a different ciphertext per call (random IV)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same-value');
    expect(decryptSecret(b)).toBe('same-value');
  });

  it('passes legacy plaintext values through decrypt unchanged', () => {
    expect(decryptSecret('legacy-plaintext-token')).toBe('legacy-plaintext-token');
  });

  it('passes null/empty values through both directions', () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeUndefined();
  });

  it('does not double-encrypt already encrypted values', () => {
    const once = encryptSecret('value');
    const twice = encryptSecret(once);
    expect(twice).toBe(once);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encryptSecret('value');
    const tampered = encrypted.slice(0, -2) + 'zz';
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('identifies encrypted values', () => {
    expect(isEncrypted(encryptSecret('x'))).toBe(true);
    expect(isEncrypted('plain')).toBe(false);
  });
});

const crypto = require('crypto');

// Hex keys are used raw, so these tests never pay for a 64 MB scrypt derivation.
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const kidOf = (hex) => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);
const v1Envelope = (hex, plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(hex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
};

describe('key ids and rotation', () => {
  const KEYS = ['TOKEN_ENCRYPTION_KEY', 'TOKEN_ENCRYPTION_KEY_PREVIOUS'];
  let saved;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('writes a v2 envelope that names the key it was sealed with', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    expect(encryptSecret('tok')).toMatch(new RegExp(`^enc:v2:${kidOf(KEY_A)}:`));
    expect(currentKeyId()).toBe(kidOf(KEY_A));
  });

  it('reads a current-key envelope without asking for re-encryption', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    expect(decryptSecretWithStatus(encryptSecret('tok'))).toEqual({ value: 'tok', needsReencrypt: false, reason: null });
  });

  it('opens an envelope sealed with the previous key after rotation and flags it for re-encryption', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const sealedWithA = encryptSecret('xero-refresh');
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = KEY_A;

    expect(decryptSecretWithStatus(sealedWithA))
      .toEqual({ value: 'xero-refresh', needsReencrypt: true, reason: 'previous-key' });
    expect(encryptSecret('new')).toMatch(new RegExp(`^enc:v2:${kidOf(KEY_B)}:`));
  });

  it('names the missing key instead of failing authentication when the previous key is not configured', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const sealedWithA = encryptSecret('tok');
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    expect(() => decryptSecret(sealedWithA)).toThrow(expect.objectContaining({ code: 'SECRET_KEY_UNAVAILABLE' }));
  });

  it('still reads v1 envelopes written before key ids existed, with either key', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    expect(decryptSecretWithStatus(v1Envelope(KEY_A, 'legacy-v1')))
      .toEqual({ value: 'legacy-v1', needsReencrypt: true, reason: 'v1' });
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = KEY_A;
    expect(decryptSecret(v1Envelope(KEY_A, 'legacy-v1'))).toBe('legacy-v1');
  });

  it('flags a plaintext legacy token for re-encryption', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    expect(decryptSecretWithStatus('plain-token'))
      .toEqual({ value: 'plain-token', needsReencrypt: true, reason: 'plaintext' });
  });

  it('refuses a truncated authentication tag', () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const parts = encryptSecret('tok').split(':'); // enc, v2, kid, iv, tag, ciphertext
    parts[4] = Buffer.from(parts[4], 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decryptSecret(parts.join(':'))).toThrow(expect.objectContaining({ code: 'SECRET_MALFORMED' }));
  });
});


describe('strict envelope parsing', () => {
  const original = process.env.TOKEN_ENCRYPTION_KEY;
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = KEY_A; });
  afterEach(() => {
    if (original == null) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = original;
  });
  it.each(['extra', 'bad-kid', 'short-iv', 'bad-base64', 'noncanonical-base64'])(
    'refuses a %s envelope rather than reading it as plaintext', (variant) => {
      const parts = encryptSecret('token').split(':');
      if (variant === 'extra') parts.push('ignored');
      if (variant === 'bad-kid') parts[2] = 'not-a-kid';
      if (variant === 'short-iv') parts[3] = Buffer.alloc(1).toString('base64url');
      if (variant === 'bad-base64') parts[5] = '!garbage';
      if (variant === 'noncanonical-base64') parts[3] += '=';
      expect(() => decryptSecret(parts.join(':')))
        .toThrow(expect.objectContaining({ code: 'SECRET_MALFORMED' }));
    }
  );
  it('refuses extra v1 envelope segments', () => {
    expect(() => decryptSecret(v1Envelope(KEY_A, 'token') + ':ignored'))
      .toThrow(expect.objectContaining({ code: 'SECRET_MALFORMED' }));
  });
  it('keeps a JWT fallback scrypted even when it looks like a raw hex key', () => {
    const jwt = process.env.JWT_SECRET;
    try {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      process.env.JWT_SECRET = KEY_A;
      const derived = crypto.scryptSync(KEY_A, 'your-guava-token-encryption', 32,
        { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
      const bytes = Buffer.concat([cipher.update('legacy-jwt'), cipher.final()]);
      const stored = `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${bytes.toString('base64url')}`;
      expect(decryptSecret(stored)).toBe('legacy-jwt');
    } finally { process.env.JWT_SECRET = jwt; }
  });
});
