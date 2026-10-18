const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { withDeadline, s3ClientTimeoutConfig } = require('../utils/http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let client = null;

const DEFAULT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const HARD_MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const R2_ENV_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
];

const storageError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const maxObjectBytes = () => {
  const configured = Number.parseInt(process.env.UPLOAD_MAX_BYTES, 10);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_OBJECT_BYTES;
  return Math.max(1024, Math.min(configured, HARD_MAX_OBJECT_BYTES));
};

const getConfigurationStatus = () => {
  const missing = R2_ENV_KEYS.filter((key) => !process.env[key]);
  const configured = missing.length === 0;
  const partiallyConfigured = missing.length > 0 && missing.length < R2_ENV_KEYS.length;
  const production = process.env.NODE_ENV === 'production';
  return {
    ok: configured || (!production && !partiallyConfigured),
    configured,
    mode: configured ? 'r2' : partiallyConfigured ? 'misconfigured' : 'local',
    missing,
  };
};

const localRoot = () => path.join(process.cwd(), 'uploads', 'r2');

const useLocalStorage = () => {
  const status = getConfigurationStatus();
  if (!status.ok) {
    const context = process.env.NODE_ENV === 'production'
      ? 'R2 storage is required in production'
      : 'R2 storage configuration is incomplete';
    throw new Error(`${context}; missing ${status.missing.join(', ')}`);
  }
  return !status.configured;
};

const assertBufferSize = (buffer) => {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Storage payload must be a Buffer');
  if (buffer.length > maxObjectBytes()) {
    const error = new Error(`File exceeds ${maxObjectBytes()} bytes`);
    error.statusCode = 400;
    throw error;
  }
};

const localPathForKey = (key) => {
  const root = path.resolve(localRoot());
  const target = path.resolve(root, String(key || ''));
  if (!target.startsWith(root + path.sep)) {
    throw storageError('Invalid storage key', 400, 'INVALID_STORAGE_KEY');
  }
  return target;
};

const signLocalUrl = (key, expires) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set to sign local download URLs');
  }
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`${key}.${expires}`)
    .digest('hex');
};

const getClient = () => {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) {
    throw new Error('R2_ACCOUNT_ID is not set');
  }
  client = new S3Client({
    ...s3ClientTimeoutConfig('r2'),
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
};

const bucket = () => process.env.R2_BUCKET_NAME;
const R2_HOST = 'r2.cloudflarestorage.com';
const sendToR2 = (command, method) =>
  withDeadline('r2', (signal) => getClient().send(command, { abortSignal: signal }), {
    context: { method, host: R2_HOST },
  });

/**
 * Uploads a buffer to R2 under the given key.
 * @param {Buffer} buffer
 * @param {string} key
 * @param {string} contentType
 * @returns {Promise<void>}
 */
const uploadFile = async (buffer, key, contentType = 'application/octet-stream') => {
  assertBufferSize(buffer);
  if (useLocalStorage()) {
    const target = localPathForKey(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, buffer);
    return;
  }

  await sendToR2(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
    'PutObject'
  );
};

/**
 * Downloads a file from R2 as a Buffer.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
const downloadFile = async (key) => {
  if (useLocalStorage()) {
    const filePath = localPathForKey(key);
    const stat = await fs.promises.stat(filePath);
    if (stat.size > maxObjectBytes()) {
      const error = new Error('Stored upload exceeds the configured size limit');
      error.statusCode = 413;
      throw error;
    }
    return fs.promises.readFile(filePath);
  }

  return withDeadline('r2', async (signal) => {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal: signal }
    );
    const destroyBody = () => {
      if (typeof res.Body?.destroy === 'function') res.Body.destroy();
    };
    if (signal.aborted) destroyBody();
    signal.addEventListener('abort', destroyBody, { once: true });
    try {
      if (Number.isFinite(Number(res.ContentLength)) && Number(res.ContentLength) > maxObjectBytes()) {
        destroyBody();
        throw storageError('Stored upload exceeds the configured size limit', 413, 'OBJECT_TOO_LARGE');
      }
      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of res.Body) {
        const buffered = Buffer.from(chunk);
        totalBytes += buffered.length;
        if (totalBytes > maxObjectBytes()) {
          destroyBody();
          throw storageError('Stored upload exceeds the configured size limit', 413, 'OBJECT_TOO_LARGE');
        }
        chunks.push(buffered);
      }
      return Buffer.concat(chunks);
    } finally {
      signal.removeEventListener('abort', destroyBody);
    }
  }, { context: { method: 'GetObject', host: R2_HOST } });
};

/**
 * Returns a signed URL for downloading the object.
 * @param {string} key
 * @param {number} ttlSeconds default 900 (15 min)
 * @returns {Promise<string>}
 */
/**
 * An attachment, so a stored file never renders inline on the storage domain (uploads-catalogue-19). The quoted name
 * keeps word characters, dots, dashes and spaces, shortened before its extension so a long name keeps ".csv"; the
 * RFC 5987 filename* carries the real name, so "Продажи сентябрь.csv" is not saved as underscores (review).
 */
const attachmentDisposition = (fileName) => {
  const name = String(fileName || 'upload');
  const lastDot = path.extname(name);
  const ext = lastDot.length <= 10 ? lastDot : ''; // "sales.from-the-september-till" has no extension to keep
  const ascii = (value) => value.replace(/[^\w.\- ]/g, '_');
  const safeName = `${ascii(name.slice(0, name.length - ext.length)).slice(0, 140)}${ascii(ext)}` || 'upload';
  const encoded = encodeURIComponent(`${name.slice(0, name.length - ext.length).slice(0, 190)}${ext}`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`;
};

const getSignedDownloadUrl = async (key, ttlSeconds = 900, { fileName } = {}) => {
  if (useLocalStorage()) {
    const boundedTtl = Math.max(1, Math.min(Number.parseInt(ttlSeconds, 10) || 900, 3600));
    localPathForKey(key);
    const expires = Date.now() + boundedTtl * 1000;
    const sig = signLocalUrl(key, expires);
    const baseUrl = process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`;
    return `${baseUrl}/api/uploads/local-download?key=${encodeURIComponent(key)}&expires=${expires}&sig=${sig}`;
  }

  const cmd = new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentDisposition: attachmentDisposition(fileName || path.basename(key)) });
  return getSignedUrl(getClient(), cmd, { expiresIn: ttlSeconds });
};

/**
 * Deletes an object from R2. Idempotent.
 * @param {string} key
 * @returns {Promise<void>}
 */
const deleteFile = async (key) => {
  if (useLocalStorage()) {
    await fs.promises.rm(localPathForKey(key), { force: true });
    return;
  }

  await sendToR2(new DeleteObjectCommand({ Bucket: bucket(), Key: key }), 'DeleteObject');
};

const getLocalDownloadPath = (key, expires, sig) => {
  if (!useLocalStorage()) {
    throw new Error('Local storage download is disabled');
  }
  if (!key || !sig || !/^\d{10,16}$/.test(String(expires || ''))) {
    throw storageError('Invalid download link', 403, 'INVALID_DOWNLOAD_LINK');
  }
  const expiresAt = Number(expires);
  if (!Number.isSafeInteger(expiresAt)) {
    throw storageError('Invalid download link', 403, 'INVALID_DOWNLOAD_LINK');
  }
  if (expiresAt <= Date.now()) {
    throw storageError('Download link expired', 410, 'DOWNLOAD_LINK_EXPIRED');
  }
  let filePath;
  try {
    filePath = localPathForKey(key);
  } catch (error) {
    throw storageError('Invalid download link', 403, 'INVALID_DOWNLOAD_LINK');
  }
  const expected = signLocalUrl(key, expires);
  if (!/^[a-f0-9]{64}$/i.test(sig)) {
    throw storageError('Invalid download signature', 403, 'INVALID_DOWNLOAD_SIGNATURE');
  }
  const sigBuffer = Buffer.from(sig, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const valid =
    sigBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  if (!valid) {
    throw storageError('Invalid download signature', 403, 'INVALID_DOWNLOAD_SIGNATURE');
  }
  return filePath;
};

/**
 * Resets the cached client. Used by tests.
 */
const _resetClient = () => {
  client = null;
};

module.exports = {
  uploadFile,
  downloadFile,
  getSignedDownloadUrl,
  deleteFile,
  getLocalDownloadPath,
  useLocalStorage,
  getConfigurationStatus,
  maxObjectBytes,
  _resetClient,
};
