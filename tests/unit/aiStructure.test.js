const fs = require('fs');
const path = require('path');

// BE-11-T02: anthropic.service.js became a barrel over services/ai/*.
const SRC = path.resolve(__dirname, '../../src');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const lineCount = (relative) => (read(relative).match(/\n/g) || []).length;
const AI_MODULES = ['prompts', 'json', 'pii', 'context', 'chat', 'stream', 'insights', 'columnMapping'];
const ai = (name) => require(`../../src/services/ai/${name}`);

describe('AI module structure (BE-11-T02)', () => {
  it('keeps anthropic.service.js a barrel: under 60 lines and no function of its own', () => {
    expect(lineCount('services/anthropic.service.js')).toBeLessThan(60);
    expect(read('services/anthropic.service.js')).not.toMatch(/=>|function\s/);
  });

  it('has a module for context, prompts, insights, chat, mapping and streaming', () => {
    const missing = AI_MODULES.filter((name) => !fs.existsSync(path.join(SRC, `services/ai/${name}.js`)));
    expect(missing).toEqual([]);
  });

  it('serves every public function from the module that owns it', () => {
    const barrel = require('../../src/services/anthropic.service');
    expect(barrel.buildBusinessContext).toBe(ai('context').buildBusinessContext);
    expect(barrel.generateInsights).toBe(ai('insights').generateInsights);
    expect(barrel.refreshInsights).toBe(ai('insights').refreshInsights);
    expect(barrel.getCachedInsights).toBe(ai('insights').getCachedInsights);
    expect(barrel.invalidateInsights).toBe(ai('insights').invalidateInsights);
    expect(barrel.generateBusinessChatResponse).toBe(ai('chat').generateBusinessChatResponse);
    expect(barrel.streamBusinessChatResponse).toBe(ai('stream').streamBusinessChatResponse);
    expect(barrel.proposeColumnMapping).toBe(ai('columnMapping').proposeColumnMapping);
    expect(barrel.buildSummaryStats).toBe(ai('prompts').buildSummaryStats);
  });

  it('names the default model in at most one AI module, and only in prompts.js', () => {
    // BE-11-T02 puts the literal in ai/prompts.js; BE-05-T08 later moves it to src/config/ai.js,
    // which leaves none here. Either state passes; a copy anywhere else in the AI code fails.
    const files = ['services/anthropic.service.js', ...AI_MODULES.map((name) => `services/ai/${name}.js`)]
      .filter((file) => fs.existsSync(path.join(SRC, file)));
    const naming = files.filter((file) => read(file).includes('claude-haiku-4-5-20251001'));
    expect(naming.filter((file) => file !== 'services/ai/prompts.js')).toEqual([]);
  });

  it('reads every text block of a response, and tolerates a response with none', () => {
    const { responseText } = require('../../src/services/anthropicClient.service');
    const message = { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '[1,' }, { type: 'text', text: '2]' }] };
    expect(responseText(message)).toBe('[1,2]');
    expect(responseText({})).toBe('');
  });
});
