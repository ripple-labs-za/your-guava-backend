const mockAnthropicMessageCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

const supertest = require('supertest');
const {
  setup,
  teardown,
  clearDB,
  createTestUser,
  app,
} = require('../setup');
const { _resetInsightsCache } = require('../../src/services/anthropic.service');

const request = supertest(app);

// Alternating turns at a given length; index 0 is a user turn.
const longChat = (count, chars) => Array.from({ length: count }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `${index} `.padEnd(chars, 'a'),
}));

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  await _resetInsightsCache();
  delete process.env.ANTHROPIC_API_KEY;
  await clearDB();
});

  describe('chat payload limits', () => {
    it.each(['/API/INSIGHT-CHATS', '/api/insight-chats?x=1', '/api/insight-chats/abc/', '/api/forecasts/insights/chat/stream/'])
      ('accepts the larger chat parser on the real route shape %s before rejecting an unauthenticated request', async (url) => {
        const response = await request.post(url).send({ padding: 'x'.repeat(150_000) });
        expect(response.status).toBe(401);
      });

    it.each(['/api/insight-chatsx', '/api/forecasts/insights/chatx', '/api/forecasts/insights/chat/stream/extra'])
      ('keeps the small parser on the similar non-chat path %s', async (url) => {
        const response = await request.post(url).send({ padding: 'x'.repeat(150_000) });
        expect(response.status).toBe(413);
        expect(response.body.details).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', limitBytes: 102400 });
      });
  it('saves an 80-message chat at the schema maximum and continues it', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    mockAnthropicMessageCreate.mockResolvedValue({
      id: 'msg_long', model: 'test-model', usage: { input_tokens: 100, output_tokens: 5 },
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'Still here.' }],
    });
    const created = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Long chat' });
    const chatId = created.body.chat._id;

    const saved = await request
      .patch(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ messages: longChat(80, 20_000) });
    expect(saved.status).toBe(200);
    expect(saved.body.chat.messages).toHaveLength(80);

    const turn = await request
      .post('/api/forecasts/insights/chat')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'long-chat-turn')
      .send({ chatId, messages: [...longChat(79, 20_000), { role: 'user', content: 'And now?' }] });
    expect(turn.status).toBe(200);
    expect(turn.body.answer).toBe('Still here.');
  });

  it('refuses an oversize chat body with a named 413', async () => {
    const owner = await createTestUser();
    const created = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Too big' });

    const response = await request
      .patch(`/api/insight-chats/${created.body.chat._id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ messages: longChat(80, 40_000) });

    expect(response.status).toBe(413);
    expect(response.body.details).toEqual(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE', limitBytes: 2 * 1024 * 1024 }));
  });

  it('keeps the 100 KB limit on every other route, with the same named 413', async () => {
    const owner = await createTestUser();

    const response = await request
      .post('/api/events')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'x'.repeat(150_000), date: new Date().toISOString(), impact: 'high' });

    expect(response.status).toBe(413);
    expect(response.body.details).toEqual(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE', limitBytes: 100 * 1024 }));
  });
});
