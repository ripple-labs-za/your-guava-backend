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

const path = require('path');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Upload = require('../../src/models/Upload.model');
const { measureBudget } = require('../helpers/budget');

const request = supertest(app);
const yocoFixture = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
const SMALL_CSV = Buffer.from(['Receipt,Date,Items,Total', 'R1,2026-04-01,1 x Latte,38.00'].join(String.fromCharCode(10)));
const HEAVY_FIELDS = ['sampleRows', 'headers', 'rowErrors', 'columnMapping', 'r2Key', 'fileFingerprint', 'confirmation'];

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

describe('upload history and multipart limits', () => {
  let token;
  let user;
  beforeEach(async () => { ({ token, user } = await createTestUser()); });

  it('lists uploads without their previews, and keeps the previews on the detail route', async () => {
    const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', yocoFixture);
    expect(stage.status).toBe(200);

    const list = await request.get('/api/uploads').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const [listed] = list.body.uploads;
    HEAVY_FIELDS.forEach((field) => expect(listed).not.toHaveProperty(field));
    expect(listed).toEqual(expect.objectContaining({
      _id: stage.body.uploadId,
      fileName: 'test-transactions.csv',
      posType: 'yoco',
      mappingSource: 'yoco',
      stats: expect.objectContaining({ imported: 0 }),
      createdAt: expect.any(String),
      uploadedBy: expect.objectContaining({ name: 'Test Owner' }),
    }));
    expect(['pending_mapping', 'parsing']).toContain(listed.status);

    const detail = await request.get(`/api/uploads/${stage.body.uploadId}`).set('Authorization', `Bearer ${token}`);
    expect(detail.body.upload.headers).toContain('Receipt');
    expect(detail.body.upload.sampleRows.length).toBeGreaterThan(0);
  });

  it('lists 200 uploads with heavy previews in a response under 256 KB', async () => {
    const heavyRow = Object.fromEntries([0, 1].map((index) => [`Column ${index}`, 'x'.repeat(10_000)]));
    await Upload.insertMany(Array.from({ length: 200 }, (_, index) => ({
      cafeId: user.activeCafeId,
      uploadedBy: user.id || user._id, // the login body's user, as uploads.test.js reads it
      fileName: `heavy-${index}.csv`,
      fileSize: 1,
      r2Key: `uploads/test/heavy-${index}.csv`,
      posType: 'wizard',
      status: 'pending_mapping',
      headers: Object.keys(heavyRow),
      sampleRows: Array.from({ length: 5 }, () => heavyRow),
    })));

    const outcome = await measureBudget(() => request.get('/api/uploads?limit=200').set('Authorization', `Bearer ${token}`));
    const bytes = Buffer.byteLength(outcome.result.text);
    console.log(`list 200 heavy uploads: ${bytes} bytes, ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB`);
    expect(outcome.result.status).toBe(200);
    expect(outcome.result.body.uploads).toHaveLength(200);
    expect(bytes).toBeLessThan(256 * 1024);
    expect(outcome.heapGrowthMb).toBeLessThan(50);
  });

  it('refuses a 50 MB form field with 413 and stores nothing', async () => {
    const response = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('note', 'x'.repeat(50 * 1024 * 1024))
      .attach('file', SMALL_CSV, 'small.csv');
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('UPLOAD_FORM_TOO_LARGE');
    expect(await Upload.countDocuments()).toBe(0);
  }, 60_000);

  it('refuses a thousand small form fields with 413', async () => {
    let pending = request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`);
    for (let index = 0; index < 1000; index += 1) pending = pending.field(`f${index}`, 'x'.repeat(1024));
    const response = await pending.attach('file', SMALL_CSV, 'small.csv');
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('UPLOAD_FORM_TOO_LARGE');
  });

  it('refuses ten fields sent after the file, and a second file part, with 413', async () => {
    let afterFile = request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', SMALL_CSV, 'small.csv');
    for (let index = 0; index < 10; index += 1) afterFile = afterFile.field(`after${index}`, 'x');
    const fieldsAfter = await afterFile;
    expect(fieldsAfter.status).toBe(413);
    const twoFiles = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`)
      .attach('file', SMALL_CSV, 'a.csv').attach('file', SMALL_CSV, 'b.csv');
    expect(twoFiles.status).toBe(413);
    expect(twoFiles.body.code).toBe('UPLOAD_FORM_TOO_LARGE');
  });

  it('still accepts the one file the portal sends', async () => {
    const response = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', SMALL_CSV, 'small.csv');
    expect(response.status).toBe(200);
  });

  // Review of BE-03-T12: multer read the part's file name as latin1, so a browser's UTF-8 name was stored garbled.
  it('keeps a non-Latin file name as the browser sent it', async () => {
    const response = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', SMALL_CSV, 'Продажи сентябрь.csv');
    expect(response.status).toBe(200);
    const stored = await Upload.findById(response.body.uploadId).select('fileName').lean();
    expect(stored.fileName).toBe('Продажи сентябрь.csv');
  });
});
