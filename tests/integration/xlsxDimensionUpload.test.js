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

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Upload = require('../../src/models/Upload.model');
const { xlsxWith } = require('../helpers/xlsx');
const { measureBudget } = require('../helpers/budget');

const request = supertest(app);
const HEADER = ['Receipt', 'Date', 'Items', 'Total'];

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

describe('POST /api/transactions/upload refuses impossible spreadsheet sizes', () => {
  let token;
  beforeEach(async () => { ({ token } = await createTestUser()); });

  it.each([
    ['dos-dimension.xlsx', { dimension: 'A1:XFD1048576', deflate: true }],
    ['dos-last-cell.xlsx', { extraRowsXml: '<row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>x</t></is></c></row>', deflate: true }],
    ['dos-spaced-last-cell.xlsx', { extraRowsXml: '<row r="1048576"><c r="XFD 1048576" t="inlineStr"><is><t>x</t></is></c></row>', deflate: true }],
  ])('%s is a 400 and the API stays up', async (name, options) => {
    const outcome = await measureBudget(() => request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', xlsxWith([HEADER], options), name));
    expect(outcome.result.status).toBe(400);
    expect(outcome.result.body.code).toBe('XLSX_DIMENSION_LIMIT');
    expect(outcome.result.body.message).toMatch(/limit|rows|size/i);
    expect(outcome.elapsedMs).toBeLessThan(1000);
    expect(await Upload.countDocuments()).toBe(0);
    expect((await request.get('/api/health')).status).toBe(200);
  });

  it('still stages an ordinary workbook', async () => {
    const response = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', xlsxWith([HEADER, ['R1', '2026-04-01', '1 x Latte', '38.00']], { deflate: true }), 'ordinary.xlsx');
    expect(response.status).toBe(200);
    expect(response.body.headers).toEqual(HEADER);
  });
});
