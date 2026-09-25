const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Item = require('../../src/models/Item.model');

const request = supertest(app);
beforeAll(async () => { await setup(); await Item.syncIndexes(); });
afterAll(teardown);
afterEach(clearDB);

const seed = (cafeId, count, extra = () => ({})) => Item.insertMany(Array.from({ length: count }, (_, i) => ({
  cafeId, name: `Item ${String(i).padStart(3, '0')}`, normalizedName: `item ${String(i).padStart(3, '0')}`,
  reviewStatus: 'needs_review', totalSold: i % 7, aliasKeys: ['x'], manualFields: [], ...extra(i),
})));
const list = (token, query = '') => request.get(`/api/items${query}`).set('Authorization', `Bearer ${token}`);

describe('GET /api/items pages the menu', () => {
  let token; let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); token = owner.token; cafeId = owner.user.activeCafeId; });

  it('returns one page at a time with the totals to page through', async () => {
    await seed(cafeId, 120);
    const pages = await Promise.all([1, 2, 3].map((page) => list(token, `?active=true&page=${page}&limit=50`)));
    expect(pages.map((res) => res.body.items.length)).toEqual([50, 50, 20]);
    expect(pages[0].body.meta).toMatchObject({ total: 120, page: 1, limit: 50, pages: 3 });
    expect(new Set(pages.flatMap((res) => res.body.items.map((item) => item._id))).size).toBe(120);
  });

  it('defaults to 50 and clamps the limit and page', async () => {
    await seed(cafeId, 260);
    expect((await list(token)).body.items).toHaveLength(50);
    const wide = await list(token, '?limit=1000&page=0');
    expect(wide.body.items).toHaveLength(200);
    expect(wide.body.meta).toMatchObject({ page: 1, limit: 200 });
  });

  it('counts the whole cafe in meta, whatever the page', async () => {
    await seed(cafeId, 300);
    await Item.insertMany([
      ...Array.from({ length: 5 }, (_, i) => ({ cafeId, name: `Ready ${i}`, normalizedName: `ready ${i}`, reviewStatus: 'matched', priceMismatchCount: i < 2 ? 1 : 0 })),
      ...Array.from({ length: 3 }, (_, i) => ({ cafeId, name: `Fee ${i}`, normalizedName: `fee ${i}`, reviewStatus: 'ignored', isActive: false })),
    ]);
    const res = await list(token, '?active=true&limit=10');
    expect(res.body.items).toHaveLength(10);
    expect(res.body.meta).toMatchObject({
      total: 305, needsReview: 300, priceMismatches: 2,
      counts: { needs_review: 300, matched: 5, ignored: 3, merged: 0 },
    });
  });

  it('orders by review status, then sales, then name', async () => {
    await Item.insertMany([
      { cafeId, name: 'B', normalizedName: 'b', reviewStatus: 'matched', totalSold: 5 },
      { cafeId, name: 'A', normalizedName: 'a', reviewStatus: 'matched', totalSold: 5 },
      { cafeId, name: 'C', normalizedName: 'c', reviewStatus: 'needs_review', totalSold: 1 },
      { cafeId, name: 'D', normalizedName: 'd', reviewStatus: 'matched', totalSold: 9 },
    ]);
    expect((await list(token)).body.items.map((item) => item.name)).toEqual(['C', 'D', 'A', 'B']);
  });

  it('leaves out internal fields', async () => {
    await seed(cafeId, 1);
    const [item] = (await list(token)).body.items;
    expect(item).not.toHaveProperty('aliasKeys');
    expect(item).not.toHaveProperty('manualFields');
  });

  it('pages the reconciliation queue without overlap', async () => {
    await seed(cafeId, 120);
    const get = (page) => request.get(`/api/items/reconciliation?page=${page}&limit=50`).set('Authorization', `Bearer ${token}`);
    const [one, two] = await Promise.all([get(1), get(2)]);
    expect(two.body.items).toHaveLength(50);
    expect(two.body.meta).toMatchObject({ needsReview: 120, total: 120, page: 2, pages: 3 });
    const first = new Set(one.body.items.map((item) => item._id));
    expect(two.body.items.some((item) => first.has(item._id))).toBe(false);
  });

  // Review of BE-03-T14: the whole-cafe counts cost a pass over every item; a caller paging through targets opts out.
  it('leaves the whole-cafe counts out when asked, and answers limit=0 alike on both lists', async () => {
    await seed(cafeId, 3);
    const lean = await list(token, '?counts=false&limit=2');
    expect(lean.body.meta).toMatchObject({ total: 3, page: 1, limit: 2, pages: 2 });
    expect(lean.body.meta).not.toHaveProperty('counts');
    expect(lean.body.meta).not.toHaveProperty('needsReview');
    const recon = await request.get('/api/items/reconciliation?limit=0').set('Authorization', `Bearer ${token}`);
    expect(recon.body.meta.limit).toBe((await list(token, '?limit=0')).body.meta.limit);
  });

  // Review of BE-03-T14: the page re-reads the rows an owner edited on other pages, so a stored value that moved while
  // they were elsewhere is still flagged before Save all.
  it('reads just the items named in ids, and refuses a malformed or oversized list', async () => {
    const seeded = await seed(cafeId, 5);
    const wanted = [seeded[1]._id, seeded[3]._id].map(String);
    const res = await list(token, `?ids=${wanted.join(',')}&counts=false`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item) => item._id).sort()).toEqual(wanted.sort());
    expect((await list(token, '?ids=not-an-id')).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, () => String(new mongoose.Types.ObjectId())).join(',');
    expect((await list(token, `?ids=${tooMany}`)).status).toBe(400);
  });

  it('explain: the list page is read from an index with no in-memory sort', async () => {
    await seed(cafeId, 300);
    const out = await Item.find({ cafeId: new mongoose.Types.ObjectId(String(cafeId)), isActive: { $ne: false } })
      .sort({ reviewStatus: -1, totalSold: -1, name: 1 }).limit(50).explain('executionStats');
    const doc = Array.isArray(out) ? out[0] : out;
    const stages = []; const walk = (node) => { if (!node || typeof node !== 'object') return; if (node.stage) stages.push(node);
      ['inputStage', 'queryPlan'].forEach((key) => walk(node[key])); (node.inputStages || []).forEach(walk); };
    walk(doc.queryPlanner.winningPlan);
    expect(stages.some((stage) => stage.stage === 'IXSCAN' && stage.indexName === 'cafeId_1_reviewStatus_-1_totalSold_-1_name_1')).toBe(true);
    expect(stages.some((stage) => stage.stage === 'SORT')).toBe(false);
  });

  it('explain: the match-candidate pool uses the same index', async () => {
    await seed(cafeId, 200, (i) => ({ reviewStatus: i % 2 ? 'matched' : 'needs_review' }));
    const out = await Item.find({ cafeId: new mongoose.Types.ObjectId(String(cafeId)), isActive: { $ne: false }, reviewStatus: 'matched' })
      .sort({ totalSold: -1 }).limit(100).explain('executionStats');
    const doc = Array.isArray(out) ? out[0] : out;
    expect(JSON.stringify(doc.queryPlanner.winningPlan)).toContain('cafeId_1_reviewStatus_-1_totalSold_-1_name_1');
    expect(JSON.stringify(doc.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
  });
});
