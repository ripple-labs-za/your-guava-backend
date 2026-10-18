jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async () => {},
  downloadFile: async () => Buffer.from(''),
  getSignedDownloadUrl: async () => 'https://test.r2.local',
  deleteFile: async () => {},
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const { encryptSecret, decryptSecret } = require('../../src/services/secrets.service');

const request = supertest(app);
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
let savedKeys;

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  savedKeys = {
    current: process.env.TOKEN_ENCRYPTION_KEY,
    previous: process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS,
    flag: process.env.ACCOUNTING_INTEGRATIONS_ENABLED,
  };
});
afterEach(async () => {
  for (const [name, value] of [
    ['TOKEN_ENCRYPTION_KEY', savedKeys.current],
    ['TOKEN_ENCRYPTION_KEY_PREVIOUS', savedKeys.previous],
    ['ACCOUNTING_INTEGRATIONS_ENABLED', savedKeys.flag],
  ]) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  await clearDB();
});

const storedYocoAccess = async (cafeId) =>
  (await Cafe.findById(cafeId).select('+yocoTokens.accessToken').lean()).yocoTokens.accessToken;

const newCafe = (yocoTokens) => Cafe.create({
  name: 'Secrets Cafe',
  orgId: new mongoose.Types.ObjectId(),
  yocoConnected: true,
  yocoTokens: { expiresAt: new Date(Date.now() + 3600 * 1000), ...yocoTokens },
});

describe('stored secrets are re-sealed on first read', () => {
  it('re-encrypts a plaintext legacy token under the current key', async () => {
    const cafe = await newCafe({ accessToken: 'legacy-plain-access' });
    const doc = await Cafe.findById(cafe._id).select('+yocoTokens.accessToken');

    await expect(Cafe.readSecret(doc, 'yocoTokens.accessToken')).resolves.toBe('legacy-plain-access');

    const stored = await storedYocoAccess(cafe._id);
    expect(stored).toMatch(/^enc:v2:[0-9a-f]{8}:/);
    expect(decryptSecret(stored)).toBe('legacy-plain-access');
  });

  it('re-seals a token sealed with the previous key after rotation', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
    const cafe = await newCafe({ accessToken: encryptSecret('rotating-access') });
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = KEY_A;
    const doc = await Cafe.findById(cafe._id).select('+yocoTokens.accessToken');

    await expect(Cafe.readSecret(doc, 'yocoTokens.accessToken')).resolves.toBe('rotating-access');

    delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
    expect(decryptSecret(await storedYocoAccess(cafe._id))).toBe('rotating-access');
  });

  it('never overwrites a token another request replaced between the read and the upgrade', async () => {
    const cafe = await newCafe({ accessToken: 'legacy-plain-access' });
    const doc = await Cafe.findById(cafe._id).select('+yocoTokens.accessToken');
    await Cafe.updateOne({ _id: cafe._id }, { $set: { 'yocoTokens.accessToken': encryptSecret('newer-access') } });

    await Cafe.readSecret(doc, 'yocoTokens.accessToken');

    expect(decryptSecret(await storedYocoAccess(cafe._id))).toBe('newer-access');
  });

  it('refuses a path that is not a stored secret', async () => {
    const cafe = await newCafe({ accessToken: 'x' });
    expect(() => Cafe.readSecret(cafe, 'name')).toThrow(/Not a stored secret path/);
  });

  it('upgrades a plaintext accounting token when sync reads it', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    const { token } = await createTestUser();
    const me = await request.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    const cafeId = me.body.activeCafeId;
    await Cafe.findByIdAndUpdate(cafeId, { $set: {
      'accountingIntegrations.xero.connected': true,
      'accountingIntegrations.xero.accessToken': 'plain-access-token',
      'accountingIntegrations.xero.refreshToken': 'plain-refresh-token',
      'accountingIntegrations.xero.expiresAt': new Date(Date.now() + 3600 * 1000),
    } });

    const res = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(501);
    const stored = (await Cafe.findById(cafeId).select('+accountingIntegrations.xero.accessToken').lean())
      .accountingIntegrations.xero.accessToken;
    expect(stored).toMatch(/^enc:v2:/);
  });

  it('two simultaneous legacy reads make exactly one compare-and-set upgrade', async () => {
    const cafe = await newCafe({ accessToken: 'legacy-simultaneous' });
    const doc = await Cafe.findById(cafe._id).select('+yocoTokens.accessToken');
    const originalUpdate = Cafe.updateOne;
    const update = jest.spyOn(Cafe, 'updateOne').mockImplementation(function (...args) {
      return originalUpdate.apply(this, args).exec();
    });
    try {
      expect(await Promise.all([
        Cafe.readSecret(doc, 'yocoTokens.accessToken'),
        Cafe.readSecret(doc, 'yocoTokens.accessToken'),
      ])).toEqual(['legacy-simultaneous', 'legacy-simultaneous']);
      const results = await Promise.all(update.mock.results.map(({ value }) => value));
      expect(results.reduce((n, result) => n + result.modifiedCount, 0)).toBe(1);
      expect(decryptSecret(await storedYocoAccess(cafe._id))).toBe('legacy-simultaneous');
    } finally { update.mockRestore(); }
  });

});
