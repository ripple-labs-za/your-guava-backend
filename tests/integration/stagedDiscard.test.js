// FB-010: an owner can discard a staged file without deleting another tab's completed import.
const { ERROR_CODES } = require('../../src/utils/errorCodes');
const mockFiles = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (bytes, key) => { mockFiles.set(key, Buffer.from(bytes)); },
  downloadFile: async (key) => mockFiles.get(key),
  getSignedDownloadUrl: async () => 'https://test.r2.local/object',
  deleteFile: async (key) => { mockFiles.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));
const supertest = require('supertest');
const path = require('path');
const { app, setup, teardown, clearDB, createTestUser, createTestManager } = require('../setup');
const Upload = require('../../src/models/Upload.model');
const Transaction = require('../../src/models/Transaction.model');
const request = supertest(app);
const fixture = path.join(__dirname, '../fixtures/test-transactions.csv');
beforeAll(setup); afterAll(teardown);
afterEach(async () => { jest.restoreAllMocks(); mockFiles.clear(); await clearDB(); });
const stage = async (token) => {
  const response = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', fixture);
  expect(response.status).toBe(200); return response.body;
};
const confirm = (token, staged) => request.post(`/api/uploads/${staged.uploadId}/confirm`)
  .set('Authorization', `Bearer ${token}`).send({ columnMapping: staged.columnMapping, itemsMode: staged.itemsMode });
const discard = (token, id, value = 'true') => request.delete(`/api/uploads/${id}`).query({ stagedOnly: value }).set('Authorization', `Bearer ${token}`);
describe('pending-only upload discard', () => {
  it('deletes the staged object and tombstones metadata without importing rows', async () => {
    const owner = await createTestUser(); const staged = await stage(owner.token);
    const before = await Upload.findById(staged.uploadId).lean(); expect(mockFiles.has(before.r2Key)).toBe(true);
    expect((await discard(owner.token, staged.uploadId)).status).toBe(200);
    const after = await Upload.findById(staged.uploadId).lean();
    expect(after.status).toBe('deleted'); expect(after.r2Key).toBe(`deleted/${staged.uploadId}`);
    expect(mockFiles.has(before.r2Key)).toBe(false); expect(await Transaction.countDocuments({ uploadId: staged.uploadId })).toBe(0);
  });
  it('refuses a stale discard after another tab completed the import, preserving rows and object', async () => {
    const owner = await createTestUser(); const staged = await stage(owner.token);
    expect((await confirm(owner.token, staged)).status).toBe(200);
    const before = await Upload.findById(staged.uploadId).lean(); const rows = await Transaction.find({ uploadId: staged.uploadId }).lean();
    expect(rows).toHaveLength(4);
    const response = await discard(owner.token, staged.uploadId);
    expect(response.status).toBe(409); expect(response.body.code).toBe('UPLOAD_NOT_STAGED');
    expect(ERROR_CODES[response.body.code]).toMatchObject({ status: response.status, client: true });
    expect((await Upload.findById(staged.uploadId).lean()).status).toBe('completed');
    expect((await Transaction.find({ uploadId: staged.uploadId }).lean()).map((row) => [String(row._id), row.total]))
      .toEqual(rows.map((row) => [String(row._id), row.total]));
    expect(mockFiles.has(before.r2Key)).toBe(true);
  });
  it('retains manager403 and foreign-owner404 isolation for staged discard', async () => {
    const owner = await createTestUser(); const staged = await stage(owner.token);
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);
    const foreign = await createTestUser({ email: 'foreign-discard@example.test' });
    expect((await discard(manager.token, staged.uploadId)).status).toBe(403);
    expect((await discard(foreign.token, staged.uploadId)).status).toBe(404);
    expect((await Upload.findById(staged.uploadId).lean()).status).toBe('pending_mapping');
  });
  it('rejects a malformed stagedOnly request instead of silently performing an unrestricted delete', async () => {
    const owner = await createTestUser(); const staged = await stage(owner.token);
    expect((await discard(owner.token, staged.uploadId, 'false')).status).toBe(400);
    expect((await Upload.findById(staged.uploadId).lean()).status).toBe('pending_mapping');
  });
  it('preserves the existing status/version CAS when confirmation wins after the delete reads pending state', async () => {
    const owner = await createTestUser(); const staged = await stage(owner.token);
    const realFind = Upload.findOne.bind(Upload);
    jest.spyOn(Upload, 'findOne').mockImplementationOnce(async (filter) => {
      const snapshot = await realFind(filter);
      expect((await confirm(owner.token, staged)).status).toBe(200);
      return snapshot;
    });
    expect((await discard(owner.token, staged.uploadId)).status).toBe(409);
    expect(await Transaction.countDocuments({ uploadId: staged.uploadId })).toBe(4);
    expect((await Upload.findById(staged.uploadId).lean()).status).toBe('completed');
  });
});
