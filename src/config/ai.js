/**
 * The one place AI model ids, per-feature generation settings and prices live. Every provider call builds its
 * model, max_tokens and sampling fields from requestSettings(feature), so switching a feature's model is one
 * environment variable, and a model that rejects a parameter never receives it.
 */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MODEL_ALIASES = Object.freeze({ 'claude-haiku-4-5': DEFAULT_MODEL });
const canonicalModel = (model) => Object.hasOwn(MODEL_ALIASES, model) ? MODEL_ALIASES[model] : model;

// Prices: USD per million tokens, Anthropic first-party list prices (September 2026). Cache writes are the 5-minute
// ephemeral rate (1.25x input); cache reads 0.1x input. minCacheableTokens: shorter prompt prefixes never cache.
const MODELS = Object.freeze({
  'claude-haiku-4-5-20251001': Object.freeze({
    label: 'Claude Haiku 4.5', acceptsTemperature: true, thinking: 'none', minCacheableTokens: 4096,
    price: Object.freeze({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }),
  }),
  'claude-sonnet-5': Object.freeze({
    label: 'Claude Sonnet 5', acceptsTemperature: false, thinking: 'disable', minCacheableTokens: 1024,
    price: Object.freeze({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
  }),
  'claude-opus-5-5': Object.freeze({
    label: 'Claude Opus 5.5', acceptsTemperature: false, thinking: 'always', minCacheableTokens: 512,
    price: Object.freeze({ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }),
  }),
});

const FEATURES = Object.freeze({
  chat: Object.freeze({ env: 'AI_MODEL_CHAT', maxTokens: 1400, temperature: 0.3 }),
  insights: Object.freeze({ env: 'AI_MODEL_INSIGHTS', maxTokens: 1024, temperature: 0.2 }),
  columnMapping: Object.freeze({ env: 'AI_MODEL_COLUMN_MAPPING', maxTokens: 512, temperature: 0 }),
  menuReview: Object.freeze({ env: 'AI_MODEL_MENU_REVIEW', maxTokens: 500, temperature: 0 }),
});

// A model that always thinks spends part of max_tokens on thinking; leave room for the answer.
const ALWAYS_THINKING_TOKEN_MULTIPLIER = 4;

const featureSpec = (feature) => {
  const spec = Object.hasOwn(FEATURES, feature) ? FEATURES[feature] : null;
  if (!spec) throw new Error(`Unknown AI feature: ${feature}`);
  return spec;
};

const modelSelection = (feature) => {
  const spec = featureSpec(feature);
  for (const variable of [spec.env, 'ANTHROPIC_MODEL']) {
    const value = String(process.env[variable] || '').trim();
    if (value) return { variable, model: canonicalModel(value) };
  }
  return { variable: spec.env, model: DEFAULT_MODEL };
};
const modelFor = (feature) => modelSelection(feature).model;

const requestSettings = (feature) => {
  const spec = featureSpec(feature);
  const { model, variable } = modelSelection(feature);
  const rules = Object.hasOwn(MODELS, model) ? MODELS[model] : null;
  if (!rules) {
    throw Object.assign(
      new Error(`${variable} names ${model}, which has no request rules or prices in src/config/ai.js. Add it there first.`),
      { code: 'AI_MODEL_UNKNOWN' }
    );
  }
  return {
    model,
    max_tokens: rules.thinking === 'always' ? spec.maxTokens * ALWAYS_THINKING_TOKEN_MULTIPLIER : spec.maxTokens,
    ...(rules.acceptsTemperature ? { temperature: spec.temperature } : {}),
    ...(rules.thinking === 'disable' ? { thinking: { type: 'disabled' } } : {}),
    ...(rules.thinking === 'always' ? { output_config: { effort: 'low' } } : {}),
  };
};

/** Every configured model must be known; hardened deployments refuse to boot otherwise. */
const aiModelProblems = () => Object.keys(FEATURES)
  .map(modelSelection)
  .filter(({ model }) => !Object.hasOwn(MODELS, model))
  .map(({ variable, model }) => `${variable} (or ANTHROPIC_MODEL) names unknown model ${model}`);

const PER_MILLION = 1_000_000;

/** USD cost of one provider call from its diagnostics; null for a model with no price (the stub, a test double). */
const usageCostUsd = ({ model, inputTokens = 0, outputTokens = 0, cacheCreationInputTokens = 0, cacheReadInputTokens = 0 } = {}) => {
  const id = canonicalModel(model);
  const price = Object.hasOwn(MODELS, id) ? MODELS[id].price : null;
  if (!price) return null;
  const cost = (inputTokens * price.input + outputTokens * price.output
    + cacheCreationInputTokens * price.cacheWrite + cacheReadInputTokens * price.cacheRead) / PER_MILLION;
  return Number(cost.toFixed(6));
};

module.exports = { DEFAULT_MODEL, FEATURES, MODELS, aiModelProblems, modelFor, requestSettings, usageCostUsd };
