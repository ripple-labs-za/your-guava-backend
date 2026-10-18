let mockR2Stall = false;
const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => {
    if (mockR2Stall) {
      const { OutboundTimeoutError, outboundPolicy } = jest.requireActual('../../src/utils/http');
      throw new OutboundTimeoutError(outboundPolicy('r2'), 'total');
    }
    return mockR2Files.get(key);
  },
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));
jest.mock('axios');

const path = require('path');
const axios = require('axios');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const { buildYocoApp } = require('../helpers/yocoApp');
const Cafe = require('../../src/models/Cafe.model');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');
const { encryptSecret } = require('../../src/services/secrets.service');

const request = supertest(app);
const yocoRequest = supertest(buildYocoApp());
const yocoFixture = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Stall = false;
  mockR2Files.clear();
  axios.get.mockReset();
  axios.post.mockReset();
  await clearDB();
});

const activeCafeId = async (token) => {
  const me = await request.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  return me.body.activeCafeId;
};

describe('outbound timeouts at the API edge', () => {
  it('answers 504 and releases the parsing lease when storage stalls during confirm', async () => {
    const { token } = await createTestUser();
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', yocoFixture);
    expect(stage.status).toBe(200);

    mockR2Stall = true;
    const confirm = await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

    expect(confirm.status).toBe(504);
    expect(confirm.body.message).toMatch(/did not respond in time/i);
    const upload = await Upload.findById(stage.body.uploadId).lean();
    expect(upload.status).not.toBe('parsing');
    expect(await Transaction.countDocuments({ uploadId: stage.body.uploadId })).toBe(0);
  });

  it.each([
    [{ startDate: 'garbage' }, /valid dates/],
    [{ startDate: 20260101 }, /valid dates/],
    [{ startDate: '2026-03-01', endDate: '2026-02-01' }, /on or before/],
    [{ startDate: '2024-01-01', endDate: '2026-01-01' }, /at most 366 days/],
  ])('refuses a Yoco sync range %j with 400 before calling Yoco', async (body, message) => {
    const { token } = await createTestUser();
    const cafeId = await activeCafeId(token);
    await Cafe.findByIdAndUpdate(cafeId, {
      $set: {
        yocoConnected: true,
        'yocoTokens.accessToken': encryptSecret('access-1'),
        'yocoTokens.refreshToken': encryptSecret('refresh-1'),
        'yocoTokens.expiresAt': new Date(Date.now() + 3600 * 1000),
      },
    });

    const res = await yocoRequest
      .post('/api/yoco/sync')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_SYNC_RANGE' });
    expect(res.body.message).toMatch(message);
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
});
