const express = require('express');
const request = require('supertest');
const app = require('../../src/app');

it('exposes Retry-After to a cross-origin browser on a 429 response', async () => {
  const original = process.env.CLIENT_URL;
  process.env.CLIENT_URL = 'http://localhost:5185';
  try {
    const cors = app.router.stack.find((layer) => layer.handle.name === 'corsMiddleware').handle;
    const probe = express();
    probe.use(cors);
    probe.get('/limited', (_req, res) => res.set('Retry-After', '17').status(429).json({ code: 'CHAT_RATE_LIMITED' }));
    const response = await request(probe).get('/limited').set('Origin', 'http://localhost:5185');
    expect(response.status).toBe(429);
    expect(response.headers['access-control-expose-headers']).toContain('Retry-After');
  } finally {
    if (original === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = original;
  }
});
