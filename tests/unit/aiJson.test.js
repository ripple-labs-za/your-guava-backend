const mockAnthropicMessageCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

const { extractJson, validatedMappingProposal } = require('../../src/services/ai/json');
const { _resetMappingCache, proposeColumnMapping } = require('../../src/services/anthropic.service');

describe('extractJson', () => {
  it.each([
    ['a preamble and a trailing sentence', 'Here you go:\n["a","b"]\nThanks!', 'array', ['a', 'b']],
    ['code fences', '```json\n{"a":1}\n```', 'object', { a: 1 }],
    ['a bracketed aside before the array', 'See [note] then ["x"]', 'array', ['x']],
    ['brackets inside strings', '["a ] b", "c"]', 'array', ['a ] b', 'c']],
    ['no JSON at all', 'I cannot help with that.', 'array', undefined],
    ['an unterminated array', '["unterminated', 'array', undefined],
  ])('handles %s', (_label, text, expect_, expected) => {
    expect(extractJson(text, expect_)).toEqual(expected);
  });

  it('stays fast on hostile input', () => {
    const started = process.hrtime.bigint();
    expect(extractJson('['.repeat(100_000), 'array')).toBeUndefined();
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(250);
  });
});

describe('validatedMappingProposal', () => {
  it('accepts a mapping object and defaults the items mode', () => {
    expect(validatedMappingProposal({ mapping: { date: 'When' } })).toEqual({ mapping: { date: 'When' }, itemsMode: 'packed' });
  });

  it.each([
    [['not', 'an', 'object']],
    [{ mapping: 'date=When' }],
    [{ mapping: { date: 3 } }],
    [{ mapping: {}, itemsMode: 'sideways' }],
  ])('refuses %j', (value) => {
    expect(validatedMappingProposal(value)).toBeNull();
  });
});

describe('AI column mapping output', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockAnthropicMessageCreate.mockReset();
    _resetMappingCache();
  });
  afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

  it('maps columns from a reply that leads with a non-text block and wraps the JSON in prose', async () => {
    mockAnthropicMessageCreate.mockResolvedValue({
      id: 'msg_map',
      model: 'test-model',
      usage: { input_tokens: 200, output_tokens: 40 },
      stop_reason: 'end_turn',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'noop', input: {} },
        { type: 'text', text: 'Sure, here is the mapping:\n{"mapping":{"date":"When","items":"What","total":"Paid"},"itemsMode":"packed"}\nDone.' },
      ],
    });

    const result = await proposeColumnMapping(
      ['When', 'What', 'Paid'],
      [{ When: '2026-01-01', What: '1 x Flat White', Paid: '45.00' }],
      {}
    );

    expect(result.mappingAssistedByAi).toBe(true);
    expect(result.mapping).toEqual({ date: 'When', items: 'What', total: 'Paid' });
  });
});
