const logger = require('../../src/utils/logger');
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
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app, assertPrototypesClean } = require('../setup');
const Upload = require('../../src/models/Upload.model');
const Item = require('../../src/models/Item.model');
const { isValidEmail } = require('../../src/utils/email');
const { parsePackedItems, parserLimits } = require('../../src/services/parser.service');
const { normalizeItemName } = require('../../src/services/menuItems.service');
const { measureBudget } = require('../helpers/budget');
const payloads = require('../helpers/dosPayloads');

const request = supertest(app);
const results = [];
const record = (name, outcome, extra = {}) => results.push({
  name,
  elapsedMs: Math.round(outcome.elapsedMs),
  heapGrowthMb: Number(outcome.heapGrowthMb.toFixed(1)),
  maxLoopDelayMs: Math.round(outcome.maxLoopDelayMs),
  ...extra,
});
const syncMs = (fn) => {
  const started = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
};
const syncOutcome = (ms) => ({ elapsedMs: ms, heapGrowthMb: 0, maxLoopDelayMs: ms });
const PACKED_MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };

beforeAll(setup);
afterAll(async () => {
  if (process.env.B90_EVIDENCE_DIR) {
    fs.writeFileSync(path.join(process.env.B90_EVIDENCE_DIR, 'dos-budgets.json'), `${JSON.stringify(results, null, 2)}\n`);
  }
  await teardown();
});
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

describe('BE-01 DoS regression suite', () => {
  let token;
  let user;
  beforeEach(async () => { ({ token, user } = await createTestUser()); });
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const stage = (buffer, name) => request.post('/api/transactions/upload').set(auth()).attach('file', buffer, name);
  const confirm = (uploadId, columnMapping) => request.post(`/api/uploads/${uploadId}/confirm`).set(auth()).send({ columnMapping, itemsMode: 'packed' });
  const expectUp = async () => expect((await request.get('/api/health')).status).toBe(200);

  describe('BE-01-T01 email', () => {
    const hostile = payloads.hostileEmail(99_000);

    it('isValidEmail refuses a megabyte in under 50 ms', () => {
      const { value, ms } = syncMs(() => isValidEmail(payloads.hostileEmail(1_000_000)));
      record('T01 isValidEmail 1 MB', syncOutcome(ms));
      expect(value).toBe(false);
      expect(ms).toBeLessThan(50);
    });

    it('a logged-out login with a 100 KB email answers 401, median under 50 ms', async () => {
      await request.post('/api/auth/login').send({ email: 'warm@up.co', password: 'password123' });
      const samples = [];
      const outcome = await measureBudget(async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const started = process.hrtime.bigint();
          const response = await request.post('/api/auth/login').send({ email: hostile, password: 'password123' });
          samples.push(Number(process.hrtime.bigint() - started) / 1e6);
          expect(response.status).toBe(401);
        }
      });
      // measureBudget catches what fn throws; a failed status check must still fail the test.
      expect(outcome.error).toBeUndefined();
      const median = [...samples].sort((a, b) => a - b)[2];
      record('T01 login 100 KB x5', outcome, { medianMs: Math.round(median) });
      expect(median).toBeLessThan(50);
      expect(Math.max(...samples)).toBeLessThan(250);
      expect(outcome.heapGrowthMb).toBeLessThan(20);
      expect(outcome.maxLoopDelayMs).toBeLessThan(100);
    });

    it.each([
      ['/api/auth/register', { name: 'Test Owner', password: 'password123', cafeName: 'Test Cafe' }, 400],
      ['/api/auth/resend-verification', {}, 200],
      ['/api/auth/forgot-password', {}, 200],
    ])('%s answers a 100 KB email at once', async (route, body, status) => {
      const outcome = await measureBudget(() => request.post(route).send({ ...body, email: hostile }));
      record(`T01 ${route} 100 KB`, outcome);
      expect(outcome.result.status).toBe(status);
      expect(outcome.elapsedMs).toBeLessThan(250);
      expect(outcome.maxLoopDelayMs).toBeLessThan(100);
    });

    it('the column-mapping privacy check reads a megabyte header in under 50 ms', async () => {
      const { proposeColumnMapping } = jest.requireActual('../../src/services/anthropic.service');
      await proposeColumnMapping(['Date', 'Flat White', '45.00'], [], {});
      const outcome = await measureBudget(() => proposeColumnMapping([payloads.hostileEmail(1_000_000), 'Flat White', '45.00'], [], {}));
      record('T01 proposeColumnMapping 1 MB header', outcome);
      expect(outcome.result).toEqual(expect.objectContaining({ aiUnavailableReason: 'sensitive_headers' }));
      expect(outcome.elapsedMs).toBeLessThan(50);
    });
  });

  describe('BE-01-T02 CSV', () => {
    it.each([
      ['T02 10 MB single line', () => payloads.singleLineCsv(10 * 1024 * 1024 - 64), /longer than/],
      ['T02 email-shaped 200k header', () => payloads.emailHeaderCsv(200_000), /./],
      ['T02 widest line under the cap', () => payloads.singleLineCsv(parserLimits().maxRowBytes - 1), /column limit/],
    ])('%s is a 400 inside the budget', async (name, build, message) => {
      const buffer = build();
      const outcome = await measureBudget(() => stage(buffer, 'dos.csv'));
      record(name, outcome);
      expect(outcome.result.status).toBe(400);
      expect(outcome.result.body.message).toMatch(message);
      expect(outcome.elapsedMs).toBeLessThan(1000);
      expect(outcome.heapGrowthMb).toBeLessThan(50);
      expect(outcome.maxLoopDelayMs).toBeLessThan(250);
      expect(await Upload.countDocuments()).toBe(0);
      await expectUp();
    });
  });

  describe('BE-01-T03 XLSX', () => {
    it.each([
      ['T03 dimension A1:XFD1048576', () => payloads.dimensionBombXlsx()],
      ['T03 cell at XFD1048576', () => payloads.coordinateBombXlsx()],
      ['T03 cell at "XFD 1048576"', () => payloads.coordinateBombXlsx('XFD 1048576')],
      ['T03 1 MB of unterminated <c tags', () => payloads.unterminatedTagsXlsx()],
    ])('%s is a 400 before the sheet is read', async (name, build) => {
      const workbook = build();
      if (!name.includes('unterminated')) expect(workbook.length).toBeLessThan(2048);
      const outcome = await measureBudget(() => stage(workbook, 'dos.xlsx'));
      record(name, outcome, { bytes: workbook.length });
      expect(outcome.result.status).toBe(400);
      // The size refusal (readFirstSheet) or the unreadable-sheet refusal (BE-01-T03), never some other 400.
      expect(outcome.result.body.message).toMatch(/too large to read safely|could not be read/);
      expect(outcome.elapsedMs).toBeLessThan(500);
      expect(outcome.heapGrowthMb).toBeLessThan(20);
      expect(outcome.maxLoopDelayMs).toBeLessThan(250);
      await expectUp();
    });
  });

  // BE-01-T04 was re-scoped (no worker): the sheet is read as a stream that never builds a DOM, and the DOM-built parts are size-limited.
  describe('BE-01-T04 bounded XLSX DOM', () => {
    it('a workbook with 17 MB of sheet XML stages with the API heap flat', async () => {
      await stage(payloads.dimensionBombXlsx(), 'warm.xlsx'); // warm the reader
      const workbook = payloads.heavySheetXlsx();
      const outcome = await measureBudget(() => stage(workbook, 'heavy-10k-x-25.xlsx'));
      record('T04 17 MB sheet XML stage', outcome, { bytes: workbook.length });
      expect(outcome.result.status).toBe(200);
      expect(outcome.result.body.headers).toHaveLength(25);
      expect(outcome.heapGrowthMb).toBeLessThan(150);
      // Today the whole parse runs on the event loop: 10 s of stall on this host for 250,000 cells (ISSUES #11). These are
      // no-regression ceilings set at twice the BE-01-T04 baseline; BE-14-T01 owns bringing them to its 200 ms budget.
      expect(outcome.elapsedMs).toBeLessThan(20_000);
      expect(outcome.maxLoopDelayMs).toBeLessThan(20_000);
      await expectUp();
    }, 60_000);

    it('a workbook whose styles part is 16 MB is a 400 before it is built', async () => {
      const outcome = await measureBudget(() => stage(payloads.stylesBombXlsx(), 'styles-bomb.xlsx'));
      record('T04 16 MB styles part', outcome);
      expect(outcome.result.status).toBe(400);
      expect(outcome.result.body.message).toMatch(/styles part is \d+ MB/);
      expect(outcome.elapsedMs).toBeLessThan(2000);
      expect(outcome.heapGrowthMb).toBeLessThan(150);
      expect(await Upload.countDocuments()).toBe(0);
      await expectUp();
    }, 60_000);
  });

  describe('BE-01-T05 packed items', () => {
    it.each([
      ['T05 digit run then newline', payloads.ADVERSARIAL_ITEMS_CELL],
      ['T05 repeated markers then newline', payloads.REPEATED_MARKERS_CELL],
    ])('%s parses in under 20 ms', (name, cell) => {
      parsePackedItems(cell);
      const { ms } = syncMs(() => parsePackedItems(cell));
      record(name, syncOutcome(ms), { chars: cell.length });
      expect(ms).toBeLessThan(20);
    });

    it('a 2,000-row workbook of the adversarial cell confirms no slower than a benign cell of the same size', async () => {
      // The grammar's budget is the delta against a same-size benign cell (BE-01-T05, ISSUES #11): the import path itself costs
      // ~3 ms a row on this host, so the absolute 2 s budget is asserted only once the control is inside it.
      const control = await stage(payloads.packedItemsXlsx(2000, payloads.BENIGN_10K_CELL, 'B'), 'benign-2k.xlsx');
      expect(control.status).toBe(200);
      const benign = await measureBudget(() => confirm(control.body.uploadId, PACKED_MAPPING));
      expect(benign.result.status).toBe(200);
      const staged = await stage(payloads.packedItemsXlsx(2000), 'dos-packed-items.xlsx');
      expect(staged.status).toBe(200);
      const outcome = await measureBudget(() => confirm(staged.body.uploadId, PACKED_MAPPING));
      record('T05 2,000-row adversarial workbook confirm', outcome, { benignMs: Math.round(benign.elapsedMs) });
      expect(outcome.result.status).toBe(200);
      expect(outcome.result.body.stats.imported).toBe(2000);
      expect(outcome.elapsedMs - benign.elapsedMs).toBeLessThan(500);
      if (benign.elapsedMs < 2000) expect(outcome.elapsedMs).toBeLessThan(2000);
      else console.log(`benign 2,000-row control ${benign.elapsedMs.toFixed(0)} ms is over the 2 s import budget (ISSUES #11)`);
    }, 180_000);
  });

  describe('BE-01-T06 menu matching', () => {
    it('the crafted menu reconciliation page answers inside the budget', async () => {
      await Item.insertMany(payloads.craftedMenu(user.activeCafeId, normalizeItemName));
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const outcome = await measureBudget(() => request.get('/api/items/reconciliation?limit=100').set(auth()));
      warn.mockRestore();
      record('T06 crafted menu reconciliation', outcome);
      expect(outcome.result.status).toBe(200);
      expect(outcome.elapsedMs).toBeLessThan(1000);
      expect(outcome.heapGrowthMb).toBeLessThan(50);
      expect(outcome.maxLoopDelayMs).toBeLessThan(500);
    });
  });

  describe('BE-01-T07 upload surface', () => {
    it('200 heavy uploads list in a small body', async () => {
      const row = Object.fromEntries([0, 1].map((index) => [`Column ${index}`, 'x'.repeat(10_000)]));
      await Upload.insertMany(Array.from({ length: 200 }, (_, index) => ({
        cafeId: user.activeCafeId, uploadedBy: user.id || user._id, fileName: `heavy-${index}.csv`, fileSize: 1,
        r2Key: `uploads/test/heavy-${index}.csv`, posType: 'wizard', status: 'pending_mapping',
        headers: Object.keys(row), sampleRows: Array.from({ length: 5 }, () => row),
      })));
      const outcome = await measureBudget(() => request.get('/api/uploads?limit=200').set(auth()));
      const bytes = Buffer.byteLength(outcome.result.text);
      record('T07 list 200 heavy uploads', outcome, { bytes });
      expect(outcome.result.status).toBe(200);
      expect(bytes).toBeLessThan(256 * 1024);
      expect(outcome.elapsedMs).toBeLessThan(500);
      expect(outcome.heapGrowthMb).toBeLessThan(50);
      expect(outcome.maxLoopDelayMs).toBeLessThan(250);
    });

    it('a 50 MB form field is a 413', async () => {
      const outcome = await measureBudget(() => request.post('/api/transactions/upload').set(auth())
        .field('note', 'x'.repeat(50 * 1024 * 1024))
        .attach('file', Buffer.from('Receipt,Items\nR1,1 x Latte\n'), 'small.csv'));
      record('T07 50 MB form field', outcome);
      expect(outcome.result.status).toBe(413);
      expect(outcome.result.body.code).toBe('UPLOAD_FORM_TOO_LARGE');
      expect(outcome.elapsedMs).toBeLessThan(10_000);
      await expectUp();
    }, 60_000);

    it('a thousand form fields are a 413', async () => {
      const outcome = await measureBudget(() => {
        let pending = request.post('/api/transactions/upload').set(auth());
        for (let index = 0; index < 1000; index += 1) pending = pending.field(`f${index}`, 'x'.repeat(1024));
        return pending.attach('file', Buffer.from('Receipt,Items\nR1,1 x Latte\n'), 'small.csv');
      });
      record('T07 1,000 form fields', outcome);
      expect(outcome.result.status).toBe(413);
      expect(outcome.result.body.code).toBe('UPLOAD_FORM_TOO_LARGE');
      expect(outcome.elapsedMs).toBeLessThan(2000);
    });
  });

  describe('BE-01-T08 reserved names', () => {
    it('items named like prototype keys import and read back without touching a prototype', async () => {
      const staged = await stage(Buffer.from(payloads.RESERVED_NAMES_CSV), 'reserved-names.csv');
      const outcome = await measureBudget(async () => {
        const confirmed = await confirm(staged.body.uploadId, payloads.RESERVED_NAMES_MAPPING);
        expect(confirmed.status).toBe(200);
        const items = await request.get('/api/analytics/items?startDate=2026-04-01&endDate=2026-04-10').set(auth());
        expect(items.status).toBe(200);
        expect(items.body.items.map((item) => item.name)).toEqual(expect.arrayContaining(['__proto__', 'constructor', 'prototype']));
        return items;
      });
      record('T08 reserved names import + analytics', outcome);
      expect(outcome.error).toBeUndefined();
      expect(outcome.elapsedMs).toBeLessThan(2000);
      assertPrototypesClean();
    });
  });

  describe('the budgets bite', () => {
    it('the legacy email pattern blows the 50 ms budget at 20,000 characters', () => {
      const LEGACY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const { ms } = syncMs(() => LEGACY_EMAIL_RE.test(payloads.hostileEmail(20_000)));
      record('control: legacy email pattern 20k', syncOutcome(ms));
      expect(ms).toBeGreaterThan(50);
    });

    it('the legacy packed-item pattern blows the 20 ms budget on the adversarial cell', () => {
      const QTY = String.raw`-?\d+(?:[.,]\d+)?`;
      const MARKER = String.raw`\s+[x×]\s+`;
      const legacy = new RegExp(`(${QTY})${MARKER}([^\\n]+?)(?:[,;\\n](?=\\s*${QTY}${MARKER})|$)`, 'gi');
      const { ms } = syncMs(() => {
        while (legacy.exec(payloads.ADVERSARIAL_ITEMS_CELL) !== null) { /* drain */ }
      });
      record('control: legacy packed regex 10k cell', syncOutcome(ms));
      expect(ms).toBeGreaterThan(20);
    });
  });
});
