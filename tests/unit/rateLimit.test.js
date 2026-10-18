const express = require('express');
const supertest = require('supertest');
const {
  admitThroughLimiter,
  createAiLimiter,
  createChatWriteLimiter,
  getLimiterOptions,
} = require('../../src/middleware/rateLimit.middleware');

const asUser = (req, _res, next) => {
  req.user = { id: 'user-1', orgId: 'org-1' };
  next();
};

describe('AI limiter', () => {
  it('counts in-handler admissions against the same per-user budget as the AI routes, without answering for the handler', async () => {
    const limiter = createAiLimiter({ skip: () => false });
    const admit = admitThroughLimiter(limiter);
    const app = express();
    app.post('/admit', asUser, async (req, res) => {
      try {
        await admit(req, res);
        res.json({ admitted: true });
      } catch (error) {
        res.json({ admitted: false, code: error.code, statusCode: error.statusCode });
      }
    });
    app.post('/route', asUser, limiter, (_req, res) => res.json({ ok: true }));
    const request = supertest(app);
    const { limit } = getLimiterOptions('ai');

    for (let index = 0; index < limit / 2; index += 1) {
      expect((await request.post('/admit')).body.admitted).toBe(true);
    }
    for (let index = limit / 2; index < limit; index += 1) {
      expect((await request.post('/route')).status).toBe(200);
    }

    const softRefusal = await request.post('/admit');
    expect(softRefusal.status).toBe(200);
    expect(softRefusal.headers.ratelimit).toBeUndefined();
    expect(softRefusal.headers['ratelimit-policy']).toBeUndefined();
    expect(softRefusal.body).toEqual({ admitted: false, code: 'AI_RATE_LIMITED', statusCode: 429 });
    const hardRefusal = await request.post('/route');
    expect(hardRefusal.status).toBe(429);
    expect(hardRefusal.body.code).toBe('AI_RATE_LIMITED');
  });
});

describe('saved-chat write limiter', () => {
  it('refuses a hard-response limiter instead of hanging inside a handler', () => {
    expect(() => admitThroughLimiter(createChatWriteLimiter())).toThrow(/soft|AI/i);
  });
  it('refuses the write after the per-minute budget with a named 429 and Retry-After', async () => {
    const limiter = createChatWriteLimiter({ skip: () => false });
    const app = express();
    app.post('/chats', asUser, limiter, (_req, res) => res.status(201).json({ ok: true }));
    const request = supertest(app);
    const { limit } = getLimiterOptions('chatWrite');

    for (let index = 0; index < limit; index += 1) {
      expect((await request.post('/chats')).status).toBe(201);
    }
    const refused = await request.post('/chats');
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('CHAT_RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });
});
