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
const Cafe = require('../../src/models/Cafe.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const { _resetInsightsCache } = require('../../src/services/anthropic.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  await _resetInsightsCache();
  delete process.env.ANTHROPIC_API_KEY;
  await clearDB();
});

const INVALID_BODIES = [
  ['a conversation that ends on an assistant turn', {
    messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
  }],
  ['a question that is not a string', { question: 42 }],
  ['messages that are not an array', { messages: 'hello' }],
  ['an empty conversation', { messages: [] }],
];

describe.each([
  '/api/forecasts/insights/chat',
  '/api/forecasts/insights/chat/stream',
])('%s refuses bad requests before any paid work', (route) => {
  it.each(INVALID_BODIES)('answers %s with a JSON 400 and reserves nothing', async (_label, body) => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();

    const response = await request
      .post(route)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'invalid-chat-input')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.details?.code).toBe('AI_CHAT_INVALID_INPUT');
    expect(await UsageLedger.countDocuments({})).toBe(0);
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
  });

  it('answers a location the caller can no longer reach with a JSON 403 and reserves nothing', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await Cafe.deleteOne({ _id: owner.user.activeCafeId });

    const response = await request
      .post(route)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'lost-cafe-chat')
      .send({ messages: [{ role: 'user', content: 'How is this location doing?' }] });

    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.details?.code).toBe('CAFE_ACCESS_REVOKED');
    expect(await UsageLedger.countDocuments({})).toBe(0);
  });
});
