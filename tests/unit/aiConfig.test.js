const fs = require('fs');
const path = require('path');

const KEYS = ['ANTHROPIC_MODEL', 'AI_MODEL_CHAT', 'AI_MODEL_INSIGHTS', 'AI_MODEL_COLUMN_MAPPING', 'AI_MODEL_MENU_REVIEW'];
const HAIKU = 'claude-haiku-4-5-20251001';

describe('AI model configuration', () => {
  let saved;
  let config;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    KEYS.forEach((key) => delete process.env[key]);
    config = require('../../src/config/ai');
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('keeps every feature on Claude Haiku 4.5 with the settings used today', () => {
    expect(config.DEFAULT_MODEL).toBe(HAIKU);
    expect(config.requestSettings('chat')).toEqual({ model: HAIKU, max_tokens: 1400, temperature: 0.3 });
    expect(config.requestSettings('insights')).toEqual({ model: HAIKU, max_tokens: 1024, temperature: 0.2 });
    expect(config.requestSettings('columnMapping')).toEqual({ model: HAIKU, max_tokens: 512, temperature: 0 });
    expect(config.requestSettings('menuReview')).toEqual({ model: HAIKU, max_tokens: 500, temperature: 0 });
  });

  it('moves one feature to Claude Sonnet 5 without the sampling parameter it rejects', () => {
    process.env.AI_MODEL_CHAT = 'claude-sonnet-5';
    expect(config.requestSettings('chat')).toEqual({ model: 'claude-sonnet-5', max_tokens: 1400, thinking: { type: 'disabled' } });
    expect(config.requestSettings('insights').model).toBe(HAIKU);
  });

  it('gives Claude Opus 5.5 room for its always-on thinking at the lowest effort', () => {
    process.env.AI_MODEL_INSIGHTS = 'claude-opus-5-5';
    expect(config.requestSettings('insights')).toEqual({
      model: 'claude-opus-5-5', max_tokens: 4096, output_config: { effort: 'low' },
    });
  });

  it('still honours the legacy ANTHROPIC_MODEL for every feature without its own override', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
    process.env.AI_MODEL_MENU_REVIEW = HAIKU;
    expect(config.modelFor('chat')).toBe('claude-sonnet-5');
    expect(config.modelFor('menuReview')).toBe(HAIKU);
  });

  it('names an unknown model instead of sending it to the provider', () => {
    process.env.AI_MODEL_MENU_REVIEW = 'claude-sonnet-4';
    expect(() => config.requestSettings('menuReview')).toThrow(/AI_MODEL_MENU_REVIEW names claude-sonnet-4/);
    expect(config.aiModelProblems()).toEqual(['AI_MODEL_MENU_REVIEW (or ANTHROPIC_MODEL) names unknown model claude-sonnet-4']);
  });

  it('prices a provider call from its usage', () => {
    expect(config.usageCostUsd({
      model: HAIKU, inputTokens: 10_000, outputTokens: 1_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 0,
    })).toBe(0.017);
    expect(config.usageCostUsd({ model: 'test-model', inputTokens: 1 })).toBeNull();
  });

  it('keeps model ids out of every other source file', () => {
    const SRC = path.join(__dirname, '../../src');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
    const holders = walk(SRC)
      .filter((file) => /['"`]claude-[a-z0-9-]+['"`]/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(holders).toEqual(['config/ai.js']);
  });

  it('rejects inherited feature and model property names', () => {
    expect(() => config.requestSettings('constructor')).toThrow(/Unknown AI feature/);
    process.env.AI_MODEL_CHAT = 'constructor';
    expect(() => config.requestSettings('chat')).toThrow(/no request rules/);
    expect(config.aiModelProblems()).toContain('AI_MODEL_CHAT (or ANTHROPIC_MODEL) names unknown model constructor');
    expect(config.usageCostUsd({ model: 'constructor', inputTokens: 1 })).toBeNull();
  });

  it('prices diagnostics with the operation feature fallback, including cache tokens', () => {
    process.env.AI_MODEL_INSIGHTS = 'claude-sonnet-5';
    const { providerDiagnostics } = require('../../src/services/ai/json');
    const diagnostics = providerDiagnostics({ usage: {
      input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300,
    } }, Date.now(), 'insight_refresh');
    expect(diagnostics).toMatchObject({ model: 'claude-sonnet-5', estimatedCostUsd: 0.00356 });
  });
});
