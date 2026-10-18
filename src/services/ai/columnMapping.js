// AI column mapping for imports: the in-process LRU, the sensitive-header check and the model proposal.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.
const crypto = require('crypto');
const { withUsageDiagnostics, meterGuavaCredits } = require('../usage.service');
const { createAnthropicClient, withAnthropicErrors, responseText } = require('../anthropicClient.service');
const { isValidEmail } = require('../../utils/email');
const { COLUMN_MAPPING_SYSTEM_PROMPT, columnMappingUserPrompt } = require('./prompts');
const { requestSettings } = require('../../config/ai');
const { extractJson, validatedMappingProposal, providerDiagnostics } = require('./json');
const { headersLookHeaderless, summarizeMappingSamples } = require('./pii');

const MAPPING_CACHE_TTL_MS = 60 * 60 * 1000;
const MAPPING_CACHE_MAX_ENTRIES = 500;
const mappingCache = new Map();
const CANONICAL_MAPPING_FIELDS = new Set([
  'receiptId',
  'date',
  'time',
  'items',
  'total',
  'tip',
  'discount',
  'paymentMethod',
  'status',
  'quantity',
]);

const headerLooksLikeSensitiveValue = (header) => {
  const value = String(header || '').trim();
  return (
    isValidEmail(value) ||
    /(?:\+?\d[\s().-]*){10,}/.test(value) ||
    /\b(?:\d[ -]*?){13,19}\b/.test(value)
  );
};

const mappingCacheGet = (key) => {
  const entry = mappingCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    mappingCache.delete(key);
    return null;
  }
  mappingCache.delete(key);
  mappingCache.set(key, entry);
  return entry.value;
};

const mappingCacheSet = (key, value) => {
  mappingCache.set(key, {
    value,
    expiresAt: Date.now() + MAPPING_CACHE_TTL_MS,
  });
  while (mappingCache.size > MAPPING_CACHE_MAX_ENTRIES) {
    mappingCache.delete(mappingCache.keys().next().value);
  }
};

/**
 * Asks Claude Haiku to propose a column mapping for an unknown CSV format.
 *
 * @param {string[]} headers
 * @param {object[]} sampleRows up to 5 rows for context
 * @returns {Promise<{mapping: object, itemsMode: 'packed'|'line-per-row'}>}
 */
const proposeColumnMappingWithClaude = async (headers, sampleSummary, { requestId } = {}) => {
  const client = createAnthropicClient();

  const startedAt = Date.now();
  const message = await withAnthropicErrors(() => client.messages.create({
    ...requestSettings('columnMapping'),
    system: COLUMN_MAPPING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: columnMappingUserPrompt(headers, sampleSummary) }],
  }), 'proposeColumnMapping', { requestId });
  const parsed = validatedMappingProposal(extractJson(responseText(message), 'object', validatedMappingProposal));
  if (!parsed) {
    const error = new Error('AI column mapper returned invalid JSON');
    error.statusCode = 502;
    error.code = 'AI_INVALID_RESPONSE';
    error.providerDiagnostics = providerDiagnostics(message, startedAt, 'import_column_mapping');
    throw error;
  }
  const cleaned = {};
  for (const [k, v] of Object.entries(parsed.mapping || {})) {
    if (CANONICAL_MAPPING_FIELDS.has(k) && v && headers.includes(v)) cleaned[k] = v;
  }
  const itemsMode =
    parsed.itemsMode === 'line-per-row' && cleaned.receiptId
      ? 'line-per-row'
      : 'packed';
  const required = itemsMode === 'line-per-row'
    ? ['receiptId', 'date', 'items', 'total']
    : ['date', 'items', 'total'];
  if (!required.every((field) => cleaned[field])) {
    const error = new Error('AI column mapper could not produce a complete mapping');
    error.statusCode = 502;
    error.code = 'AI_MAPPING_INCOMPLETE';
    throw error;
  }
  return withUsageDiagnostics({
    mapping: cleaned,
    itemsMode,
  }, providerDiagnostics(message, startedAt, 'import_column_mapping'));
};

const mappingUnavailableReason = (err) => {
  if (err.statusCode === 402) return 'insufficient_credits';
  if (err.statusCode === 403) return 'permission_required';
  if (err.code === 'AI_RATE_LIMITED') return 'rate_limited';
  if (err.statusCode === 429) return 'usage_limit_reached';
  return 'provider_unavailable';
};

const proposeColumnMapping = async (headers, sampleRows, usageContext = {}) => {
  if (usageContext.allowPaidAi === false) {
    return {
      mapping: {},
      itemsMode: 'packed',
      mappingAssistedByAi: false,
      aiCreditsCharged: 0,
      aiUnavailableReason: 'permission_required',
    };
  }
  // A malformed/headerless file can place the first customer's values in the
  // "headers" array. Do not transmit those likely identifiers to a provider.
  if (headers.some(headerLooksLikeSensitiveValue) || headersLookHeaderless(headers)) {
    return {
      mapping: {},
      itemsMode: 'packed',
      mappingAssistedByAi: false,
      aiCreditsCharged: 0,
      aiUnavailableReason: 'sensitive_headers',
    };
  }

  const sampleSummary = summarizeMappingSamples(headers, sampleRows);
  const semanticHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ headers, sampleSummary }))
    .digest('hex');
  const cacheKey = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      orgId: String(usageContext.orgId || 'unmetered'),
      cafeId: String(usageContext.cafeId || ''),
      semanticHash,
    }))
    .digest('hex');
  const cached = mappingCacheGet(cacheKey);
  if (cached) {
    return {
      ...cached,
      mappingAssistedByAi: true,
      aiCreditsCharged: 0,
      replayed: true,
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      mapping: {},
      itemsMode: 'packed',
      mappingAssistedByAi: false,
      aiCreditsCharged: 0,
      aiUnavailableReason: 'not_configured',
    };
  }

  let result;
  try {
    if (typeof usageContext.admitPaidCall === 'function') await usageContext.admitPaidCall();
    if (usageContext.orgId) {
      const metered = await meterGuavaCredits({
        orgId: usageContext.orgId,
        cafeId: usageContext.cafeId,
        userId: usageContext.userId,
        featureKey: 'import_column_mapping',
        idempotencyKey:
          `import-map:${usageContext.userId}:${usageContext.cafeId}:${semanticHash}`.slice(0, 160),
        metadata: { headerCount: headers.length, semanticHash },
        run: () => proposeColumnMappingWithClaude(headers, sampleSummary, usageContext),
      });
      result = {
        ...metered.result,
        guavaCredits: metered.guavaCredits,
        mappingAssistedByAi: true,
        aiCreditsCharged: metered.replayed ? 0 : 10,
        replayed: Boolean(metered.replayed),
      };
    } else {
      const raw = await proposeColumnMappingWithClaude(headers, sampleSummary, usageContext);
      const { __usageDiagnostics: _diagnostics, ...cleanResult } = raw;
      result = { ...cleanResult, mappingAssistedByAi: true, aiCreditsCharged: 0 };
    }
  } catch (err) {
    // The wrapped error carries the provider's status and type; the bare
    // err.name was "Error" for every failure, which is what made an invalid
    // API key indistinguishable from an outage in the logs.
    console.error(
      '[anthropic] proposeColumnMapping failed:',
      err.upstreamStatus != null ? `status=${err.upstreamStatus}` : (err.code || err.name || 'unknown'),
      err.upstreamMessage ? `- ${err.upstreamMessage}` : ''
    );
    return {
      mapping: {},
      itemsMode: 'packed',
      mappingAssistedByAi: false,
      aiCreditsCharged: 0,
      aiUnavailableReason: mappingUnavailableReason(err),
    };
  }

  mappingCacheSet(cacheKey, {
    mapping: result.mapping || {},
    itemsMode: result.itemsMode === 'line-per-row' ? 'line-per-row' : 'packed',
  });
  return result;
};

const _resetMappingCache = () => mappingCache.clear();

module.exports = {
  headerLooksLikeSensitiveValue, proposeColumnMapping, _resetMappingCache,
};
