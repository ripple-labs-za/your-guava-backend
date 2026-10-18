const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const logger = require('../../src/utils/logger');

const request = supertest(app);
const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  mockR2Files.clear();
  await clearDB();
});

describe('upload storage failures', () => {
  it('answers a disk failure with a fixed message and the request id, and logs the cause', async () => {
    const { token } = await createTestUser();
    jest.spyOn(fs, 'createWriteStream').mockImplementationOnce((target) => {
      const stream = new PassThrough();
      const failure = Object.assign(new Error(`ENOSPC: no space left on device, open '${target}'`), {
        code: 'ENOSPC',
        syscall: 'open',
      });
      process.nextTick(() => stream.destroy(failure));
      return stream;
    });
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});

    const res = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csvPath);

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/could not save this file/i);
    expect(JSON.stringify(res.body)).not.toMatch(/ENOSPC|no space left|uploads[\\/]/);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(error).toHaveBeenCalledWith('request_error', expect.objectContaining({
      requestId: res.body.requestId,
      statusCode: 500,
      context: expect.objectContaining({ stage: 'upload_storage', code: 'ENOSPC', syscall: 'open' }),
    }));
  });

  it('still refuses an unsupported file type inline with a 400', async () => {
    const { token } = await createTestUser();
    const res = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4'), 'export.pdf');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/CSV and XLSX/);
  });
});
