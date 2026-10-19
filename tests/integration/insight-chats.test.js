const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Insight Chats API', () => {
  it('rate-limits every saved-chat write route', () => {
    const router = require('../../src/routes/insightChats.routes');
    const { chatWriteLimiter } = require('../../src/middleware/rateLimit.middleware');
    const handlersFor = (method, path) => router.stack
      .filter((layer) => layer.route && layer.route.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route.stack.map((entry) => entry.handle));

    expect(handlersFor('post', '/')).toContain(chatWriteLimiter);
    expect(handlersFor('patch', '/:id')).toContain(chatWriteLimiter);
    expect(handlersFor('delete', '/:id')).toContain(chatWriteLimiter);
    expect(handlersFor('get', '/')).not.toContain(chatWriteLimiter);
  });

  it('keeps the saved-chat cap under parallel creates', async () => {
    const InsightChat = require('../../src/models/InsightChat.model');
    const { MAX_CHATS_PER_USER } = require('../../src/controllers/insightChats.controller');
    const seed = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'seed' });
    const { userId, cafeId, orgId } = seed.body.chat;
    await InsightChat.insertMany(
      Array.from({ length: MAX_CHATS_PER_USER - 2 }, (_, index) => ({
        userId, cafeId, orgId, title: `Filler ${index}`, messages: [],
      }))
    );

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) => request
        .post('/api/insight-chats')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: `Race ${index}` }))
    );

    const created = responses.filter((response) => response.status === 201);
    // At the boundary a race may refuse every racer (each one that counts above the cap removes itself), but it
    // must never let the user end above the cap, and every refusal is the named 409.
    expect(created.length).toBeLessThanOrEqual(1);
    expect(responses.every((response) => [201, 409].includes(response.status))).toBe(true);
    expect(responses.filter((response) => response.status === 409)
      .every((response) => response.body.details?.code === 'INSIGHT_CHAT_LIMIT_REACHED')).toBe(true);
    const total = await InsightChat.countDocuments({ userId, cafeId });
    expect(total).toBe(MAX_CHATS_PER_USER - 1 + created.length);
    expect(total).toBeLessThanOrEqual(MAX_CHATS_PER_USER);

    // Below the cap, a single create is never refused: remove the racer that won, if one did, so the user is
    // exactly one under the cap whatever the race decided, then create.
    await InsightChat.deleteMany({ _id: { $in: created.map((response) => response.body.chat._id) } });
    expect(await InsightChat.countDocuments({ userId, cafeId })).toBe(MAX_CHATS_PER_USER - 1);
    const single = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'After the race' });
    expect(single.status).toBe(201);
  });

  it('accepts only server-shaped contextStats', async () => {
    const wrongType = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'bad', contextStats: { transactionCount: 'lots' } });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.details?.code).toBe('INVALID_CONTEXT_STATS');

    const oversized = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'big', contextStats: { contextWindow: 'x'.repeat(5_000) } });
    expect(oversized.status).toBe(400);

    const created = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'ok',
        contextStats: {
          transactionCount: 12, locations: 1, topItems: 4, forecasts: 3, menuItemIssues: 0,
          contextWindow: 'Last 90 days.', injected: { $gt: 1 },
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.chat.contextStats).toEqual({
      transactionCount: 12, locations: 1, topItems: 4, forecasts: 3, menuItemIssues: 0, contextWindow: 'Last 90 days.',
    });

    const badPatch = await request
      .patch(`/api/insight-chats/${created.body.chat._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ contextStats: { forecasts: -1 } });
    expect(badPatch.status).toBe(400);
    expect(badPatch.body.details?.code).toBe('INVALID_CONTEXT_STATS');
  });

  let token;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
  });

  it('creates, lists, renames, archives, and deletes chats', async () => {
    const createRes = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({
        messages: [{ role: 'user', content: 'What is my top item?' }],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.chat.title).toBe('What is my top item?');
    const chatId = createRes.body.chat._id;

    const listRes = await request
      .get('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.chats).toHaveLength(1);
    expect(listRes.body.chats[0].messages).toBeUndefined();
    expect(listRes.body.pagination).toEqual(expect.objectContaining({
      page: 1,
      limit: 20,
      total: 1,
      hasMore: false,
    }));

    const compatibilityList = await request
      .get('/api/insight-chats')
      .query({ includeMessages: 'true', limit: 50 })
      .set('Authorization', `Bearer ${token}`);
    expect(compatibilityList.status).toBe(200);
    expect(compatibilityList.body.chats[0].messages).toHaveLength(1);
    expect(compatibilityList.body.pagination.limit).toBe(10);
    expect(compatibilityList.body.meta).toEqual(expect.objectContaining({
      includeMessages: true,
      messagePreviewLimit: 20,
    }));

    const detailRes = await request
      .get(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.chat.messages).toHaveLength(1);

    const renameRes = await request
      .patch(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Top items analysis' });

    expect(renameRes.status).toBe(200);
    expect(renameRes.body.chat.title).toBe('Top items analysis');

    const archiveRes = await request
      .patch(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ archived: true });

    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.chat.archived).toBe(true);

    const visibleRes = await request
      .get('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`);

    expect(visibleRes.body.chats).toHaveLength(0);

    const archivedRes = await request
      .get('/api/insight-chats')
      .query({ archived: 'true' })
      .set('Authorization', `Bearer ${token}`);

    expect(archivedRes.body.chats).toHaveLength(1);

    const deleteRes = await request
      .delete(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleteRes.status).toBe(200);
  });

  it('rejects a non-array messages payload as a client error, not a server fault', async () => {
    const res = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/messages/i);
  });

  it('stops one account creating unbounded chat documents', async () => {
    const InsightChat = require('../../src/models/InsightChat.model');
    const { MAX_CHATS_PER_USER } = require('../../src/controllers/insightChats.controller');
    const decoded = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'seed' });
    const { userId, cafeId, orgId } = decoded.body.chat;

    await InsightChat.insertMany(
      Array.from({ length: MAX_CHATS_PER_USER }, (_, index) => ({
        userId,
        cafeId,
        orgId,
        title: `Filler ${index}`,
        messages: [],
      }))
    );

    const res = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'One too many' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/limit/i);
  });

  it('scopes chats to the authenticated user and active cafe', async () => {
    await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Private chat' });

    const userB = await createTestUser({ email: 'other@yourguava.com', cafeName: 'Other Cafe' });
    const res = await request
      .get('/api/insight-chats')
      .set('Authorization', `Bearer ${userB.token}`);

    expect(res.status).toBe(200);
    expect(res.body.chats).toHaveLength(0);
  });
});
