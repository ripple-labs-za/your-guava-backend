// BE-03-T13: the confirm time of a 10,000-row upload onto a year of daily-reset receipts. Not matched by the default
// testMatch, so the suite never runs it. Run it explicitly:
//   B90_BENCH_OUT=<file>.json node node_modules/jest/bin/jest.js --testMatch "**/tests/bench/importSpeedup.bench.js" --runInBand
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
const supertest = require('supertest');
const { setup, teardown, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');
const { addZonedDays, zonedDayStart, zonedDateKey, zonedDayOfWeek } = require('../../src/services/parser.service');

const request = supertest(app);
const ZONE = 'Africa/Johannesburg';
const HISTORY_DAYS = 365; const PER_DAY = 300; const UPLOAD_ROWS = 10000; const RUNS = 3;
const OUT = process.env.B90_BENCH_OUT || path.join(process.cwd(), 'bench-import.json');
const MENU = Array.from({ length: 60 }, (_, i) => `Menu Item ${i}`);
jest.setTimeout(30 * 60 * 1000);

beforeAll(setup);
afterAll(teardown);

test('confirm time for a 10,000-row upload onto a year of daily-reset receipts', async () => {
  const { token, user } = await createTestUser();
  const cafeId = user.activeCafeId;
  const today = zonedDayStart(new Date(), ZONE);
  // History: receipts 1..300 every day for a year, as a till that restarts numbering each morning writes them.
  for (let day = 40; day < 40 + HISTORY_DAYS; day += 1) {
    const start = addZonedDays(today, -day, ZONE);
    await Transaction.collection.insertMany(Array.from({ length: PER_DAY }, (_, n) => {
      const date = new Date(start.getTime() + (7 + (n % 12)) * 3600 * 1000 + n * 1000);
      return { cafeId: new (require('mongoose').Types.ObjectId)(cafeId), receiptId: String(n + 1), date, hour: 7 + (n % 12),
        dayOfWeek: zonedDayOfWeek(date, ZONE), status: 'approved', total: 40, items: [{ name: MENU[n % 60], quantity: 1, unitPrice: 40 }] };
    }));
  }
  // The upload: the last 34 days, receipts 1..~294 per day, varied baskets and totals.
  const lines = ['Receipt,Date,Time,Items,Total'];
  for (let i = 0; i < UPLOAD_ROWS; i += 1) {
    const key = zonedDateKey(addZonedDays(today, -(1 + Math.floor(i / 295)), ZONE), ZONE);
    lines.push(`${(i % 295) + 1},${key},${String(7 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},1 x ${MENU[i % 60]};${1 + (i % 3)} x ${MENU[(i * 7) % 60]},${(30 + (i % 97)).toFixed(2)}`);
  }
  const file = Buffer.from(lines.join('\n'));
  const mapping = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
  const runs = [];
  for (let run = 0; run < RUNS; run += 1) {
    const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', file, 'bench.csv');
    const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
    let heapPeak = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); }, 50);
    const started = process.hrtime.bigint();
    const confirm = await request.post(`/api/uploads/${stage.body.uploadId}/confirm`).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `bench-${run}`).send({ columnMapping: mapping, itemsMode: 'packed' });
    const confirmMs = Number(process.hrtime.bigint() - started) / 1e6;
    clearInterval(sampler); lag.disable();
    expect(confirm.status).toBe(200);
    expect(confirm.body.stats.imported).toBe(UPLOAD_ROWS);
    runs.push({ confirmMs: Math.round(confirmMs), loopMaxMs: Math.round(lag.max / 1e6), loopP99Ms: Math.round(lag.percentile(99) / 1e6),
      heapPeakMb: Math.round(heapPeak / 1048576) });
    await Transaction.deleteMany({ uploadId: stage.body.uploadId });
    await Upload.deleteOne({ _id: stage.body.uploadId });
  }
  const sorted = [...runs].sort((a, b) => a.confirmMs - b.confirmMs);
  fs.writeFileSync(OUT, JSON.stringify({ scenario: { HISTORY_DAYS, PER_DAY, UPLOAD_ROWS, RUNS }, runs, confirmMedianMs: sorted[1].confirmMs }, null, 2));
});
