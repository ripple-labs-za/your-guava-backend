const logger = require('../../src/utils/logger');
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async () => {}, downloadFile: async () => Buffer.from(''), getSignedDownloadUrl: async () => 'https://test.r2.local',
  deleteFile: async () => {}, _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Item = require('../../src/models/Item.model');
const { normalizeItemName } = require('../../src/services/menuItems.service');
const { measureBudget } = require('../helpers/budget');

const request = supertest(app);
const long = (seed) => `${'a'.repeat(190)}${String(seed).padStart(10, '0')}`;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

it('answers the reconciliation page for a crafted menu in under 1 s', async () => {
  const { token, user } = await createTestUser();
  const cafeId = user.activeCafeId;
  const matched = Array.from({ length: 100 }, (_, c) => {
    const aliases = Array.from({ length: 50 }, (_, a) => long(c * 1000 + a + 1));
    return {
      cafeId, name: long(c * 1000), normalizedName: normalizeItemName(long(c * 1000)), aliases,
      aliasKeys: aliases.map(normalizeItemName), reviewStatus: 'matched', totalSold: 1000 - c, isActive: true,
    };
  });
  const review = Array.from({ length: 100 }, (_, index) => ({
    cafeId, name: long(900_000 + index), normalizedName: normalizeItemName(long(900_000 + index)),
    reviewStatus: 'needs_review', totalSold: 1, isActive: true,
  }));
  await Item.insertMany([...matched, ...review]);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

  const outcome = await measureBudget(() => request
    .get('/api/items/reconciliation?limit=100')
    .set('Authorization', `Bearer ${token}`));
  console.log(`crafted reconciliation page: ${outcome.elapsedMs.toFixed(0)} ms, loop stall ${outcome.maxLoopDelayMs.toFixed(0)} ms`);

  expect(outcome.result.status).toBe(200);
  expect(outcome.result.body.items).toHaveLength(100);
  expect(outcome.elapsedMs).toBeLessThan(1000);
  expect(outcome.maxLoopDelayMs).toBeLessThan(500);
  const exhausted = warn.mock.calls.filter(([line]) => String(line).includes('menu_match_budget_exhausted'));
  expect(exhausted).toHaveLength(1);
});
