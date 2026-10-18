const validateEnv = require('../../src/config/validateEnv');
const original = { ...process.env };
beforeEach(() => { process.env = { ...original }; });
afterAll(() => { process.env = original; });
const setLocalDevelopmentEnv = () => {
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'j'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'r'.repeat(40);
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27199/guava-dev';
  process.env.CLIENT_URL = 'http://localhost:5185';
  delete process.env.DOWNLOAD_SIGNING_SECRET;
};

it('requires an independent DOWNLOAD_SIGNING_SECRET when uploads are stored locally', () => {
  setLocalDevelopmentEnv();
  expect(() => validateEnv()).toThrow(/DOWNLOAD_SIGNING_SECRET is required/);
  process.env.DOWNLOAD_SIGNING_SECRET = 'short';
  expect(() => validateEnv()).toThrow(/DOWNLOAD_SIGNING_SECRET must be at least 32 characters/);
  process.env.DOWNLOAD_SIGNING_SECRET = process.env.JWT_SECRET;
  expect(() => validateEnv()).toThrow(/DOWNLOAD_SIGNING_SECRET must be independent/);
  process.env.DOWNLOAD_SIGNING_SECRET = 'd'.repeat(40);
  expect(() => validateEnv()).not.toThrow();
});

it('does not ask for a download signing secret when R2 stores uploads', () => {
  setLocalDevelopmentEnv();
  Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test' });
  expect(() => validateEnv()).not.toThrow();
});

it('rejects a previous token key that equals the current one or is short in production', () => {
  setLocalDevelopmentEnv();
  Object.assign(process.env, { R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test' });
  process.env.NODE_ENV = 'production';
  process.env.TOKEN_ENCRYPTION_KEY = 't'.repeat(40);
  process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = process.env.TOKEN_ENCRYPTION_KEY;
  expect(() => validateEnv()).toThrow(/TOKEN_ENCRYPTION_KEY_PREVIOUS must differ/);
  process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = 'short';
  expect(() => validateEnv()).toThrow(/TOKEN_ENCRYPTION_KEY_PREVIOUS must be at least 32 characters/);
});
