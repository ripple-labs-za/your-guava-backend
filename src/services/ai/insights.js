const { getCafeTradingHours } = require('../../utils/tradingHours');
// Insights: the cache, the refresh lease and de-duplication, and generation.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.
const crypto = require('crypto');
const Transaction = require('../../models/Transaction.model');
const Forecast = require('../../models/Forecast.model');
const Cafe = require('../../models/Cafe.model');
const Organization = require('../../models/Organization.model');
const GeneratedInsight = require('../../models/GeneratedInsight.model');
const { withUsageDiagnostics, creditSnapshot, meterGuavaCredits } = require('../usage.service');
const { createAnthropicClient, withAnthropicErrors, responseText } = require('../anthropicClient.service');
const { safeTimezone, zonedDayStart, addZonedDays, zonedDateKey } = require('../../utils/timezone');
const {
  modelId, missingInsightsKeyResponse, buildSummaryStats, MAX_FORECAST_ITEMS_IN_PROMPT, insufficientInsightDataResponse,
  INSIGHTS_SYSTEM_PROMPT, insightsUserPrompt,
} = require('./prompts');
const { extractJson, validatedInsightStrings, providerDiagnostics } = require('./json');
const { insightDatasetIsTooThin } = require('./context');
const { throwIfAborted, waitWithAbort } = require('./stream');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REFRESH_DEDUPE_MS = 30 * 1000;
const REFRESH_LEASE_MS = 75 * 1000;
const REFRESH_WAIT_MS = 80 * 1000;
const REFRESH_POLL_MS = 250;

const cachedInsightEntry = (cafeId) =>
  GeneratedInsight.findOne({ cafeId }).lean();

const insightEntryIsInvalidated = (entry) =>
  Boolean(
    entry?.invalidatedAt &&
    (!entry.generatedAt || new Date(entry.invalidatedAt) >= new Date(entry.generatedAt))
  );

const getCachedInsights = async (cafeId) => {
  const cached = await cachedInsightEntry(cafeId);
  if (cached?.generatedAt) {
    const fresh =
      !insightEntryIsInvalidated(cached) &&
      Date.now() - new Date(cached.generatedAt).getTime() < CACHE_TTL_MS;
    return {
      insights: cached.insights || [],
      generatedAt: new Date(cached.generatedAt),
      requiresRefresh: !fresh,
      cacheStatus: fresh ? 'fresh' : 'stale',
    };
  }
  if (!process.env.ANTHROPIC_API_KEY) return missingInsightsKeyResponse();
  return {
    insights: [],
    generatedAt: null,
    requiresRefresh: true,
    cacheStatus: 'empty',
  };
};

const invalidateInsights = async (cafeId) => {
  if (!cafeId) return;
  await GeneratedInsight.updateOne(
    { cafeId },
    { $set: { invalidatedAt: new Date() } }
  );
};

/**
 * Generates Claude-powered sales insights for a cafe.
 *
 * @param {string|ObjectId} cafeId
 * @returns {Promise<{ insights: string[], generatedAt: Date }>}
 */
const generateInsights = async (cafeId, { signal, requestId } = {}) => {
  throwIfAborted(signal);
  // Guard: no API key
  if (!process.env.ANTHROPIC_API_KEY) {
    return missingInsightsKeyResponse();
  }

  const cafe = await Cafe.findById(cafeId).select('timezone tradingHours').lean();
  if (!cafe) {
    const error = new Error('Cafe not found');
    error.statusCode = 404;
    throw error;
  }
  const timezone = safeTimezone(cafe.timezone);

  const client = createAnthropicClient();

  // Fetch last 14 days of transactions
  const today = zonedDayStart(new Date(), timezone);
  const fourteenDaysAgo = addZonedDays(today, -14, timezone);

  const transactions = await Transaction.find({
    cafeId,
    status: 'approved',
    date: { $gte: fourteenDaysAgo },
  })
    .sort({ date: 1 })
    .lean();

  // Build summary stats
  const summary = buildSummaryStats(transactions, timezone, getCafeTradingHours(cafe));

  // Fetch tomorrow's forecast
  const tomorrow = addZonedDays(today, 1, timezone);
  const dayAfterTomorrow = addZonedDays(tomorrow, 1, timezone);

  // Projected and capped, like buildBusinessContext already does for chat. The
  // bare `.lean()` this replaced put the whole Mongo document in the prompt â€”
  // internal ObjectIds, modelVersion, trainingCutoff, and a per-item factors
  // array â€” so prompt size grew with the cafe's menu with nothing bounding it.
  // A 21-item demo forecast was 41KB; a 300-item menu would overflow the
  // model's context window and fail the page permanently for the cafes with the
  // most data, all at the same flat 10-credit price.
  const tomorrowForecast = await Forecast.findOne({
    cafeId,
    date: { $gte: tomorrow, $lt: dayAfterTomorrow },
  })
    .select('date totalPredictedRevenue signals items.itemName items.predictedQty')
    .lean();

  const forecastSummary = tomorrowForecast
    ? {
        date: zonedDateKey(tomorrowForecast.date, timezone),
        totalPredictedRevenue: tomorrowForecast.totalPredictedRevenue,
        signals: tomorrowForecast.signals,
        topItems: (tomorrowForecast.items || [])
          .slice()
          .sort((a, b) => (b.predictedQty || 0) - (a.predictedQty || 0))
          .slice(0, MAX_FORECAST_ITEMS_IN_PROMPT)
          .map((item) => ({ itemName: item.itemName, predictedQty: item.predictedQty })),
      }
    : null;

  const startedAt = Date.now();
  const message = await withAnthropicErrors(() => client.messages.create(
    {
      model: modelId(),
      max_tokens: 1024,
      temperature: 0.2,
      system: INSIGHTS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: insightsUserPrompt({ summary, forecastSummary }) }],
    },
    { signal }
  ), 'generateInsights', { requestId });

  // Join every text block, the way the chat path already does. Reading only
  // block 0 turned any response that led with a non-text block â€” or split the
  // JSON array across two text blocks â€” into a 502 the owner sees as a provider
  // outage, when the provider had in fact answered.
  const parsed = extractJson(responseText(message), 'array');
  const insights = validatedInsightStrings(parsed);
  if (!insights) {
    const truncated = message?.stop_reason === 'max_tokens';
    const code = truncated ? 'AI_OUTPUT_TRUNCATED' : 'AI_INVALID_RESPONSE';
    throw Object.assign(new Error(truncated
      ? 'The AI service stopped writing before the insights were complete, so none were saved. No credits were charged. Try again.'
      : 'The AI service replied in a form Guava could not read, so no insights were saved. No credits were charged. Try again.'), {
      statusCode: 502, code, details: { code, retryable: true }, exposeMessage: true, exposeDetails: true,
      providerDiagnostics: providerDiagnostics(message, startedAt, 'insight_refresh'),
    });
  }

  const generatedAt = new Date();
  return withUsageDiagnostics(
    { insights, generatedAt },
    providerDiagnostics(message, startedAt, 'insight_refresh')
  );
};

const currentCreditSnapshot = async (orgId) => {
  if (!orgId) return null;
  const org = await Organization.findById(orgId);
  return org ? creditSnapshot(org) : null;
};

// A refresh finished within REFRESH_DEDUPE_MS answers this one for free. One definition; the two
// callers used to differ only in whether generatedAt was re-wrapped in a Date (it is a Date either way).
const recentRefreshReplay = async (entry, orgId) => {
  if (!entry?.generatedAt || insightEntryIsInvalidated(entry)) return null;
  if (Date.now() - new Date(entry.generatedAt).getTime() >= REFRESH_DEDUPE_MS) return null;
  return {
    result: { insights: entry.insights, generatedAt: new Date(entry.generatedAt) },
    guavaCredits: await currentCreditSnapshot(orgId),
    replayed: true,
  };
};

const performInsightsRefresh = async ({
  cafeId,
  orgId,
  userId,
  idempotencyKey,
  signal,
  requestId,
}) => {
  throwIfAborted(signal);
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      result: missingInsightsKeyResponse(),
      guavaCredits: null,
      replayed: false,
    };
  }

  const recent = await cachedInsightEntry(cafeId);
  const replay = await recentRefreshReplay(recent, orgId);
  if (replay) return replay;

  if (await insightDatasetIsTooThin(cafeId)) {
    // Deliberately not persisted: a "you have no data" notice is not an
    // analysis, and caching it would report cacheStatus 'fresh' for six hours
    // to a cafe that has just started uploading.
    return {
      result: insufficientInsightDataResponse(),
      guavaCredits: await currentCreditSnapshot(orgId),
      replayed: false,
    };
  }

  // Captured before the provider call. An import that commits during the call
  // stamps invalidatedAt, and unconditionally nulling it below republished
  // pre-upload numbers as fresh for the full cache TTL â€” exactly when an owner
  // is most likely to look, because uploading and then reading insights is the
  // natural sequence.
  const priorInvalidatedAt = recent?.invalidatedAt ?? null;

  const metered = await meterGuavaCredits({
    orgId,
    cafeId,
    userId,
    featureKey: 'insight_refresh',
    idempotencyKey,
    metadata: { source: 'explicit_refresh' },
    signal,
    run: () => generateInsights(cafeId, { signal, requestId }),
  });
  const result = metered.result;
  const written = await GeneratedInsight.findOneAndUpdate(
    { cafeId, invalidatedAt: priorInvalidatedAt },
    {
      $set: {
        orgId,
        insights: result.insights,
        generatedAt: result.generatedAt,
        invalidatedAt: null,
        providerDiagnostics: metered.usage?.providerDiagnostics,
      },
    },
    // No upsert: refreshInsights always creates the row before taking the
    // lease, and upserting on a compare-and-swap miss would collide with the
    // unique cafeId index instead of reporting the miss.
    { new: true, runValidators: true }
  );
  if (!written) {
    // Someone invalidated this cafe while the provider call was in flight. Keep
    // the answer we paid for, but stamp invalidatedAt at the same instant as
    // generatedAt so insightEntryIsInvalidated still reports it stale and the
    // owner is prompted to refresh against the data they just uploaded.
    await GeneratedInsight.findOneAndUpdate(
      { cafeId },
      {
        $set: {
          orgId,
          insights: result.insights,
          generatedAt: result.generatedAt,
          invalidatedAt: result.generatedAt,
          providerDiagnostics: metered.usage?.providerDiagnostics,
        },
      },
      { upsert: true, new: true, runValidators: true }
    );
  }
  return { ...metered, replayed: Boolean(metered.replayed) };
};

const refreshInsights = async (options) => {
  throwIfAborted(options.signal);
  const recent = await cachedInsightEntry(options.cafeId);
  const replay = await recentRefreshReplay(recent, options.orgId);
  if (replay) return { ...replay, coalesced: false };

  const leaseToken = crypto.randomBytes(24).toString('hex');
  const startedAt = new Date();
  try {
    await GeneratedInsight.updateOne(
      { cafeId: options.cafeId },
      {
        $setOnInsert: {
          cafeId: options.cafeId,
          orgId: options.orgId,
          insights: [],
        },
      },
      { upsert: true }
    );
  } catch (error) {
    // Concurrent first refreshes can both observe an empty collection before
    // the unique cafe index admits one insert. The winner created exactly the
    // record we need, so the loser can proceed to the lease claim.
    if (error?.code !== 11000) throw error;
  }

  const lease = await GeneratedInsight.findOneAndUpdate(
    {
      cafeId: options.cafeId,
      $or: [
        { 'refreshLease.expiresAt': { $exists: false } },
        { 'refreshLease.expiresAt': null },
        { 'refreshLease.expiresAt': { $lte: startedAt } },
      ],
    },
    {
      $set: {
        refreshLease: {
          token: leaseToken,
          expiresAt: new Date(startedAt.getTime() + REFRESH_LEASE_MS),
        },
      },
    },
    { new: true }
  ).lean();

  if (!lease || lease.refreshLease?.token !== leaseToken) {
    const deadline = Date.now() + REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await waitWithAbort(REFRESH_POLL_MS, options.signal);
      const current = await cachedInsightEntry(options.cafeId);
      if (
        current?.generatedAt &&
        new Date(current.generatedAt) >= startedAt &&
        !insightEntryIsInvalidated(current)
      ) {
        return {
          result: { insights: current.insights, generatedAt: current.generatedAt },
          guavaCredits: await currentCreditSnapshot(options.orgId),
          replayed: true,
          coalesced: true,
        };
      }
      if (!current?.refreshLease?.expiresAt || new Date(current.refreshLease.expiresAt) <= new Date()) {
        break;
      }
    }
    const error = new Error('An insight refresh is already in progress');
    error.statusCode = 409;
    error.code = 'INSIGHT_REFRESH_IN_PROGRESS';
    throw error;
  }

  try {
    const result = await performInsightsRefresh(options);
    return { ...result, coalesced: false };
  } finally {
    await GeneratedInsight.updateOne(
      { cafeId: options.cafeId, 'refreshLease.token': leaseToken },
      { $unset: { refreshLease: 1 } }
    ).catch(() => null);
  }
};

const _resetInsightsCache = () => GeneratedInsight.deleteMany({});

module.exports = {
  getCachedInsights, invalidateInsights, generateInsights, refreshInsights, _resetInsightsCache,
};
