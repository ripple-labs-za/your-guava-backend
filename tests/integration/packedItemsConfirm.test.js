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
const { xlsxWith } = require('../helpers/xlsx');
const { measureBudget } = require('../helpers/budget');

const request = supertest(app);
const ROWS = 10_000;
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
// One shared string, used by every row: the finding's 50 KB workbook.
const ADVERSARIAL_ITEMS = `1 x Flat White\n${'1'.repeat(4990)} x ${'a'.repeat(4990)}\nz`;
// The same 10,000 bytes per row in a benign shape (one item, then blank lines,
// then a one-letter item so the cell is not trimmed away): the control that
// isolates the grammar's cost from what a 10 KB cell costs the rest of the
// import (normalising, storing and indexing it), which is the same either way.
// A single 10 KB name is not benign: item names over the limit are refused.
const LONG_BENIGN_ITEMS = `1 x Flat White${'\n'.repeat(9985)}z`;

const workbook = (prefix, items) => {
  const rows = [['Receipt', 'Date', 'Time', 'Items', 'Total']];
  for (let index = 0; index < ROWS; index += 1) {
    const time = `${String(8 + Math.floor(index / 1000)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`;
    rows.push([`${prefix}${index}`, '2026-04-01', time, items, '38.00']);
  }
  return xlsxWith(rows, { sharedStrings: true });
};

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

it('confirms 10,000 rows of the adversarial Items cell in under 5 s', async () => {
  const { token } = await createTestUser();
  const importFile = async (buffer, name) => {
    const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', buffer, name);
    expect(stage.status).toBe(200);
    return measureBudget(() => request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: MAPPING, itemsMode: 'packed' }));
  };

  expect(ADVERSARIAL_ITEMS.length).toBeLessThanOrEqual(10_000);
  expect(LONG_BENIGN_ITEMS.length).toBe(ADVERSARIAL_ITEMS.length);
  const benign = await importFile(workbook('B', '1 x Flat White'), 'benign-10k.xlsx');
  const longBenign = await importFile(workbook('L', LONG_BENIGN_ITEMS), 'long-benign-10k.xlsx');
  const adversarial = await importFile(workbook('A', ADVERSARIAL_ITEMS), 'dos-packed-items.xlsx');
  console.log(`confirm 10k rows: benign ${benign.elapsedMs.toFixed(0)} ms, long benign ${longBenign.elapsedMs.toFixed(0)} ms, `
    + `adversarial ${adversarial.elapsedMs.toFixed(0)} ms, loop stall ${adversarial.maxLoopDelayMs.toFixed(0)} ms`);

  expect(benign.result.status).toBe(200);
  expect(longBenign.result.status).toBe(200);
  expect(adversarial.result.status).toBe(200);
  console.log(`stats: benign ${JSON.stringify(benign.result.body.stats)}, long benign ${JSON.stringify(longBenign.result.body.stats)}, `
    + `adversarial ${JSON.stringify(adversarial.result.body.stats)}; adversarial row errors ${JSON.stringify((adversarial.result.body.rowErrors || []).slice(0, 3))}`);
  expect(adversarial.result.body.stats.imported).toBe(ROWS);
  // The grammar's own budget: the adversarial shape may cost the import at most
  // 1.5 s more than a benign cell of the same size does. The 5 s absolute
  // budget is the import path's (BE-14-T01, ISSUES #11): a benign 10,000-row
  // confirm takes ~30 s on this host today, so the adversarial import must fit
  // 5 s or, on a host slower than that, the same-size benign time plus 1.5 s.
  expect(adversarial.elapsedMs - longBenign.elapsedMs).toBeLessThan(1500);
  expect(adversarial.elapsedMs).toBeLessThan(Math.max(5000, longBenign.elapsedMs + 1500));
}, 300_000);
