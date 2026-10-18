// Model output: validated insight strings and the provider diagnostics attached to a response.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.
const { modelFor, usageCostUsd } = require('../../config/ai');
const OPERATION_FEATURE = {
  ask_guava_chat: 'chat', insight_refresh: 'insights',
  import_column_mapping: 'columnMapping', menu_item_ai_review: 'menuReview',
};

// Every text block, in order. A response that leads with a thinking or tool block, or splits
// its answer across two text blocks, still yields the whole answer (analytics-ai-10).
const joinTextBlocks = (message) => (message?.content || [])
  .map((part) => (part?.type === 'text' ? part.text : ''))
  .join('')
  .trim();

// Compatibility export; callers now read all text blocks through the provider boundary.
const firstBlockText = joinTextBlocks;

const stripJsonFences = (text) => text.replace(/```json|```/g, '').trim();

const providerDiagnostics = (response, startedAt, operation) => {
  const feature = Object.hasOwn(OPERATION_FEATURE, operation) ? OPERATION_FEATURE[operation] : 'chat';
  const diagnostics = {
    operation,
    model: response?.model || modelFor(feature),
    providerRequestId: response?.id,
    inputTokens: Number(response?.usage?.input_tokens) || 0,
    outputTokens: Number(response?.usage?.output_tokens) || 0,
    // Without these two, a regression that drops the cache hit rate to zero —
    // the whole business context re-billed at full input price on every turn —
    // is invisible in the ledger.
    cacheCreationInputTokens: Number(response?.usage?.cache_creation_input_tokens) || 0,
    cacheReadInputTokens: Number(response?.usage?.cache_read_input_tokens) || 0,
    stopReason: response?.stop_reason,
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
  return { ...diagnostics, estimatedCostUsd: usageCostUsd(diagnostics) };
};

/**
 * Reduces a parsed provider response to the insight strings we will store.
 *
 * The equality check this replaced (`insights.length !== value.length`) fired
 * on exactly the cases the `slice` exists to handle: eleven perfectly usable
 * insights, or nine good ones plus a stray object, were both rejected whole and
 * shown to the owner as an AI failure. Drop what we cannot store and keep what
 * we can; only a response with nothing usable, or one carrying a string longer
 * than the schema allows, is a real failure.
 */
const validatedInsightStrings = (value) => {
  if (!Array.isArray(value)) return null;
  const insights = value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (insights.length < 1) return null;
  if (insights.some((entry) => entry.length > 4000)) return null;
  return insights.slice(0, 10);
};

const MAX_JSON_SCAN_CHARS = 100_000;
const MAX_JSON_CANDIDATES = 20;
const OPENERS = { array: '[', object: '{' };

/** Index of the bracket that closes the one at `start`, or -1; string-aware, linear in the text scanned. */
const closingIndex = (text, start) => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/**
 * The first JSON array (or object) in a model reply that parses and passes an optional validator. Prose, code fences and
 * bracketed asides are skipped. Bounded: at most 20 candidates over the first 100,000 characters.
 */
const extractJson = (text, expect = 'array', validate) => {
  const opener = OPENERS[expect];
  const source = String(text || '').slice(0, MAX_JSON_SCAN_CHARS);
  let from = 0;
  for (let attempt = 0; attempt < MAX_JSON_CANDIDATES; attempt += 1) {
    const start = source.indexOf(opener, from);
    if (start === -1) return undefined;
    const end = closingIndex(source, start);
    if (end !== -1) {
      try {
        const candidate = JSON.parse(source.slice(start, end + 1));
        if (!validate || validate(candidate)) return candidate;
      } catch {
        // not this candidate
      }
    }
    from = start + 1;
  }
  return undefined;
};

const MAPPING_ITEMS_MODES = new Set(['packed', 'line-per-row']);

/** A column-mapping reply: { mapping: { field: header|null }, itemsMode? }, or null. */
const validatedMappingProposal = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { mapping, itemsMode } = value;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;
  if (itemsMode !== undefined && !MAPPING_ITEMS_MODES.has(itemsMode)) return null;
  if (Object.values(mapping).some((header) => header !== null && typeof header !== 'string')) return null;
  return { mapping, itemsMode: itemsMode || 'packed' };
};


module.exports = {
  extractJson, validatedMappingProposal,
  joinTextBlocks, firstBlockText, stripJsonFences, providerDiagnostics, validatedInsightStrings,
};
