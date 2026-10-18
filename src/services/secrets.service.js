const crypto = require('crypto');
const logger = require('../utils/logger');

const ENC_V1 = 'enc:v1:';
const ENC_V2 = 'enc:v2:';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KID_RE = /^[0-9a-f]{8}$/;
// scrypt cost for a key derived from a passphrase. N=2^16 is well above the interactive-login minimum;
// results are cached per source, so each distinct key is derived once per process.
const SCRYPT_PARAMS = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const SCRYPT_SALT = 'your-guava-token-encryption';

const derived = new Map();

const secretError = (message, code) => Object.assign(new Error(message), { code });

/**
 * 'key' sources (TOKEN_ENCRYPTION_KEY, TOKEN_ENCRYPTION_KEY_PREVIOUS) accept 64 hex chars or base64 of 32
 * bytes as raw key material and scrypt anything else; a 'jwt' source (the development fallback) is
 * always scrypted. Both rules are exactly what getKey did before key ids, so v1 envelopes still open.
 */
const deriveKey = (kind, source) => {
  const cacheKey = `${kind}:${source}`;
  const cached = derived.get(cacheKey);
  if (cached) return cached;
  let key;
  if (kind === 'key' && /^[0-9a-fA-F]{64}$/.test(source)) {
    key = Buffer.from(source, 'hex');
  } else {
    const decoded = kind === 'key' ? Buffer.from(source, 'base64') : null;
    key = decoded && decoded.length === KEY_LENGTH
      ? decoded
      : crypto.scryptSync(source, SCRYPT_SALT, KEY_LENGTH, SCRYPT_PARAMS);
  }
  const entry = Object.freeze({ key, kid: crypto.createHash('sha256').update(key).digest('hex').slice(0, 8) });
  derived.set(cacheKey, entry);
  return entry;
};

const currentKey = () => {
  if (process.env.TOKEN_ENCRYPTION_KEY) return deriveKey('key', process.env.TOKEN_ENCRYPTION_KEY);
  if (process.env.JWT_SECRET) return deriveKey('jwt', process.env.JWT_SECRET);
  throw new Error('TOKEN_ENCRYPTION_KEY or JWT_SECRET must be set to encrypt secrets');
};

/** Current key first; the previous key (decrypt only) second when it is configured and different. */
const keyring = () => {
  const current = currentKey();
  const raw = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (!raw) return [current];
  const previous = deriveKey('key', raw);
  return previous.kid === current.kid ? [current] : [current, previous];
};

const currentKeyId = () => currentKey().kid;

const isEncrypted = (value) =>
  typeof value === 'string' && (value.startsWith(ENC_V2) || value.startsWith(ENC_V1));

/** Seals with the current key: enc:v2:<kid>:<iv>:<tag>:<ciphertext>. Null and '' pass through. */
const encryptSecret = (value) => {
  if (value == null || value === '') return value;
  const plaintext = String(value);
  if (isEncrypted(plaintext)) return plaintext;
  const { key, kid } = currentKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(`v2:${kid}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_V2}${kid}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
};

const open = (key, ivPart, tagPart, dataPart, aad) => {
  const decode = (part) => {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) throw secretError('Malformed encrypted secret', 'SECRET_MALFORMED');
    const bytes = Buffer.from(part, 'base64url');
    if (bytes.toString('base64url') !== part) throw secretError('Malformed encrypted secret', 'SECRET_MALFORMED');
    return bytes;
  };
  const iv = decode(ivPart);
  const tag = decode(tagPart);
  const ciphertext = decode(dataPart);
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw secretError('Malformed encrypted secret', 'SECRET_MALFORMED');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_LENGTH,
  });
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

/**
 * Decrypts and says whether the stored value should be re-sealed: plaintext written before encryption
 * existed, a v1 envelope without a key id, or an envelope sealed with the previous key.
 */
const decryptSecretWithStatus = (value) => {
  if (value == null || value === '') return { value, needsReencrypt: false, reason: null };
  const stored = String(value);
  if (/^enc:/i.test(stored.trim()) && !stored.startsWith(ENC_V2) && !stored.startsWith(ENC_V1)) {
    throw secretError('Malformed encrypted secret', 'SECRET_MALFORMED');
  }

  if (stored.startsWith(ENC_V2)) {
    const parts = stored.slice(ENC_V2.length).split(':');
    if (parts.length !== 4) throw secretError('Malformed encrypted secret', 'SECRET_MALFORMED');
    const [kid, ivPart, tagPart, dataPart] = parts;
    if (!KID_RE.test(kid || '') || !ivPart || !tagPart || !dataPart) {
      throw secretError('Malformed encrypted secret', 'SECRET_MALFORMED');
    }
    const ring = keyring();
    const match = ring.find((entry) => entry.kid === kid);
    if (!match) {
      throw secretError(
        `No configured key has id ${kid}; set TOKEN_ENCRYPTION_KEY_PREVIOUS to the key that sealed it`,
        'SECRET_KEY_UNAVAILABLE'
      );
    }
    const plaintext = open(match.key, ivPart, tagPart, dataPart, `v2:${kid}`);
    const isCurrent = match === ring[0];
    return { value: plaintext, needsReencrypt: !isCurrent, reason: isCurrent ? null : 'previous-key' };
  }

  if (stored.startsWith(ENC_V1)) {
    const parts = stored.slice(ENC_V1.length).split(':');
    if (parts.length !== 3) throw secretError('Malformed encrypted secret', 'SECRET_MALFORMED');
    const [ivPart, tagPart, dataPart] = parts;
    if (!ivPart || !tagPart || !dataPart) throw secretError('Malformed encrypted secret', 'SECRET_MALFORMED');
    for (const entry of keyring()) {
      try {
        return { value: open(entry.key, ivPart, tagPart, dataPart), needsReencrypt: true, reason: 'v1' };
      } catch (error) {
        if (error.code === 'SECRET_MALFORMED') throw error;
      }
    }
    throw secretError('No configured key opens this v1 secret', 'SECRET_KEY_UNAVAILABLE');
  }

  return { value: stored, needsReencrypt: true, reason: 'plaintext' };
};

const decryptSecret = (value) => decryptSecretWithStatus(value).value;

/**
 * Returns the plaintext and, when it needs it, re-seals the stored value under the current key. The
 * write matches on the value that was read, so a token another request replaced in the meantime is
 * never overwritten with an older one.
 */
const readAndUpgradeSecret = async ({ model, filter, path, stored }) => {
  const { value, needsReencrypt } = decryptSecretWithStatus(stored);
  if (needsReencrypt && value) {
    const upgraded = encryptSecret(value);
    try {
      await model.updateOne({ ...filter, [path]: stored }, { $set: { [path]: upgraded } });
    } catch (error) {
      // Re-sealing is best effort: a readable token must survive a transient write failure.
      logger.warn('secret_upgrade_failed', { code: error?.code || 'SECRET_UPGRADE_WRITE_FAILED' });
    }
  }
  return value;
};

module.exports = {
  encryptSecret,
  decryptSecret,
  decryptSecretWithStatus,
  readAndUpgradeSecret,
  isEncrypted,
  currentKeyId,
};
