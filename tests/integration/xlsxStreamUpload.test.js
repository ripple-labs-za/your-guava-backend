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
const { xlsxWith, buildZip } = require('../helpers/xlsx');
const { measureBudget } = require('../helpers/budget');

const request = supertest(app);
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

// A 20 MB sheet entry (the archive guard's per-entry limit) of tiny cells: the
// shape a well-formed file could use to make the reader's DOM ~1.5 GB.
const heavyWorkbook = () => {
  const rows = [Array.from({ length: 25 }, (_, index) => `C${index}`)];
  for (let r = 0; r < 9_999; r += 1) rows.push(Array.from({ length: 25 }, () => 'x'));
  return xlsxWith(rows, { deflate: true });
};
const stylesBomb = () => buildZip([
  { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
  { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
  { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
  { name: 'xl/worksheets/sheet1.xml', data: `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Receipt</t></is></c></row></sheetData></worksheet>` },
  // About 16 MB of distinct elements: inside the archive guard's 20 MB entry
  // and 200:1 ratio limits, so only the part limit stands between it and a DOM
  // of a million elements built before one cell is read.
  { name: 'xl/styles.xml', data: `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}"><cellXfs count="1"><xf numFmtId="0"/></cellXfs>${Array.from({ length: 1_000_000 }, (_, i) => `<x i="${i * 7}"/>`).join('')}</styleSheet>` },
], { deflate: true });

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

describe('POST /api/transactions/upload reads a workbook as a stream', () => {
  let token;
  beforeEach(async () => { ({ token } = await createTestUser()); });

  const stage = (buffer, name) => request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', buffer, name);

  it('[budget] stages a 10,000 x 25 workbook (17 MB of sheet XML) with the API heap flat', async () => {
    await stage(xlsxWith([['Receipt', 'Total'], ['R1', '1.00']], { deflate: true }), 'warm.xlsx'); // warm the reader
    const outcome = await measureBudget(() => stage(heavyWorkbook(), 'heavy-10k-x-25.xlsx'));
    console.log(`upload 10,000 x 25: ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB, loop ${outcome.maxLoopDelayMs.toFixed(0)} ms`);
    expect(outcome.result.status).toBe(200);
    expect(outcome.result.body.headers).toHaveLength(25);
    expect(outcome.heapGrowthMb).toBeLessThan(150);
    expect((await request.get('/api/health')).status).toBe(200);
  });

  it('[budget] refuses a workbook whose styles part is 19 MB with a 400 before building it', async () => {
    const outcome = await measureBudget(() => stage(stylesBomb(), 'styles-bomb.xlsx'));
    console.log(`upload styles bomb: ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB`);
    expect(outcome.result.status).toBe(400);
    expect(outcome.result.body.message).toMatch(/styles part is \d+ MB/);
    expect(outcome.heapGrowthMb).toBeLessThan(150);
    expect(await Upload.countDocuments()).toBe(0);
    expect((await request.get('/api/health')).status).toBe(200);
  });
});
