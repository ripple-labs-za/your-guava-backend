jest.mock('axios');

const crypto = require('crypto');
const axios = require('axios');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const { buildYocoApp } = require('../helpers/yocoApp');
const Cafe = require('../../src/models/Cafe.model');
const { createOAuthState } = require('../../src/services/yoco.service');

const request = supertest(app);
const yocoRequest = supertest(buildYocoApp());
const WEBHOOK_SECRET = `whsec_${Buffer.from('test-webhook-secret-key').toString('base64')}`;
const YOCO_ENV = {
  YOCO_API_URL: 'https://api.yoco.invalid',
  YOCO_IAM_URL: 'https://iam.yoco.invalid',
  YOCO_CLIENT_ID: 'yoco-id',
  YOCO_CLIENT_SECRET: 'yoco-secret',
  YOCO_REDIRECT_URI: 'http://localhost:5185/connect',
  YOCO_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

let savedEnv;
let consoleSpies;

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, YOCO_ENV);
  delete process.env.API_PUBLIC_URL;
  axios.get.mockReset();
  axios.post.mockReset();
  consoleSpies = ['warn', 'log', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(async () => {
  process.env = savedEnv;
  consoleSpies.forEach((spy) => spy.mockRestore());
  jest.restoreAllMocks();
  await clearDB();
});

const ownerWithCafe = async () => {
  const { token } = await createTestUser();
  const me = await request.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  return { token, cafeId: me.body.activeCafeId };
};
const Transaction = require('../../src/models/Transaction.model');

// Reviewer probe, scaled 1:10: a 12 s budget for the real 120 s, 40 ms pages, 80 pages x 50 orders.
// The same range is retried, as the 504 message tells the owner to do.
it('makes substantial progress when the same range meets the sync deadline again', async () => {
  const { token, cafeId } = await ownerWithCafe();
  const { encryptSecret } = require('../../src/services/secrets.service');
  await Cafe.findByIdAndUpdate(cafeId, { $set: { yocoConnected: true,
    'yocoTokens.accessToken': encryptSecret('sync-access'), 'yocoTokens.expiresAt': new Date(Date.now() + 3_600_000) } });
  process.env.YOCO_SYNC_TOTAL_MS = '12000';
  const PAGES = 80;
  // Model a healthy but nontrivial write cost, so redoing the committed prefix
  // deterministically spends the retry budget instead of depending on host load.
  const upsert = Transaction.findOneAndUpdate;
  jest.spyOn(Transaction, 'findOneAndUpdate').mockImplementation(async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return upsert.apply(Transaction, args);
  });
  const pageOf = (n) => Array.from({ length: 50 }, (_, i) => ({
    id: `o-${n}-${i}`, created_at: new Date(Date.UTC(2026, 3, 1) + (n * 50 + i) * 60000).toISOString(),
    line_items: [{ item_type: 'product', name: `Item ${i % 13}`, quantity: 1, unit_price: { amount: 3800 } }],
    amounts: { gross_amount: { amount: 3800 } }, payments: [{ payment_method: 'card' }],
  }));
  let previousCount = 0;
  let firstCount = 0;
  const deadlines = [];
  for (let run = 1; run <= 3; run += 1) {
    axios.get.mockReset();
    axios.get.mockImplementation(async (url, config) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const n = config?.params?.cursor ? Number(config.params.cursor.slice(2)) : 1;
      return { data: { data: pageOf(n), next_cursor: n < PAGES ? `c-${n + 1}` : null } };
    });
    const started = Date.now();
    const res = await yocoRequest.post('/api/yoco/sync').set('Authorization', `Bearer ${token}`).send({});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const count = await Transaction.countDocuments({ cafeId });
    console.info(`retry run=${run} status=${res.status} ms=${Date.now() - started} committed=${count} added=${count - previousCount}`);
    expect([200, 504]).toContain(res.status);
    expect(count).toBeGreaterThan(previousCount);
    if (run === 1) firstCount = count;
    // A retry must reach new pages, rather than spending its budget upserting the prefix again.
    if (run > 1) expect(count - previousCount).toBeGreaterThan(firstCount / 2);
    if (res.status === 504) {
      deadlines.push(res.body);
    }
    previousCount = count;
    if (count === PAGES * 50) break;
  }
  expect(deadlines.length).toBeGreaterThan(0);
  for (const progress of deadlines) {
    expect(progress.message).toMatch(/at least/i);
    expect(progress.countsAreLowerBound).toBe(true);
    expect(progress.truncated).toBe('deadline');
  }
}, 120000);
