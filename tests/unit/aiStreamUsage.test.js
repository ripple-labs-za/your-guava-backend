const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
jest.mock('../../src/services/ai/chat', () => ({
  buildBusinessChatRequest: jest.fn().mockResolvedValue({ request: {}, contextStats: { transactionCount: 1 } }),
}));
const { streamBusinessChatResponse } = require('../../src/services/ai/stream');
const { USAGE_DIAGNOSTICS_FIELD } = require('../../src/services/usage/meter');

afterEach(() => { delete process.env.ANTHROPIC_API_KEY; mockCreate.mockReset(); });

it('keeps the largest cumulative input and cache counts when a proxy reports smaller string counters later', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockCreate.mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { id: 'cache-usage', usage: {
        input_tokens: 50, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300,
      } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fine.' } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {
        input_tokens: '10', cache_read_input_tokens: '900', cache_creation_input_tokens: '100', output_tokens: '40',
      } };
      yield { type: 'message_stop' };
    },
  });
  const result = await streamBusinessChatResponse({ cafeId: 'cafe', messages: [], onDelta: jest.fn() });
  expect(result[USAGE_DIAGNOSTICS_FIELD]).toMatchObject({
    inputTokens: 50, outputTokens: 40, cacheReadInputTokens: 1200, cacheCreationInputTokens: 300,
  });
});
