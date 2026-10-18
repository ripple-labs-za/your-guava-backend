const DEFAULT_FORECAST_SETTINGS = {
  history: {
    maxWeeks: 8,
    recentWeights: [0.35, 0.25, 0.20],
    twoWeekWeights: [0.6, 0.4],
  },
  weather: {
    enabled: true,
    hotTemp: 27,
    coldTemp: 18,
    hotColdDrinkPct: 30,
    hotCoffeePct: -10,
    coldCoffeePct: 15,
    coldColdDrinkPct: -20,
    rainPct: -10,
    minimumMultiplier: 0.1,
  },
  loadShedding: {
    enabled: true,
    stage1To2Pct: -8,
    stage3To4Pct: -22,
    stage5PlusPct: -40,
  },
  holiday: {
    enabled: true,
    publicPct: 15,
    schoolPct: 8,
    combinedPct: 20,
  },
  payday: {
    enabled: true,
    pct: 20,
  },
  events: {
    enabled: true,
    lowPct: 10,
    mediumPct: 20,
    highPct: 35,
  },
  stock: {
    safetyMarginPct: 10,
    maxBiasPct: 50,
  },
  learning: {
    enabled: true,
  },
};

const PLAN_ORDER = {
  free: 0,
  starter: 1,
  growth: 2,
  pro: 3,
};

const FACTOR_CATALOG = [
  {
    key: 'weather',
    label: 'Weather',
    section: 'weather',
    requiredPlan: 'starter',
    summary: 'Temperature and rain adjust coffee and cold drink demand.',
  },
  {
    key: 'holiday',
    label: 'Public & school holidays',
    section: 'holiday',
    requiredPlan: 'starter',
    summary: 'Calendar holidays adjust day-level demand.',
  },
  {
    key: 'payday',
    label: 'Payday',
    section: 'payday',
    requiredPlan: 'growth',
    summary: 'Month-end payday windows lift demand.',
  },
  {
    key: 'events',
    label: 'Local events',
    section: 'events',
    requiredPlan: 'growth',
    summary: 'Configured local events apply low, medium, high, or custom demand weights.',
  },
  {
    key: 'loadShedding',
    label: 'Load shedding',
    section: 'loadShedding',
    requiredPlan: 'growth',
    summary: 'Power disruption stages reduce expected demand.',
  },
  {
    key: 'stock',
    label: 'Stock buffer',
    section: 'stock',
    requiredPlan: 'growth',
    summary: 'Suggested stock includes a configurable safety margin and historical stock bias.',
  },
  {
    key: 'history',
    label: 'History weights',
    section: 'history',
    requiredPlan: 'pro',
    summary: 'Tune how strongly recent trading weeks influence the baseline forecast.',
  },
  {
    key: 'learning',
    label: 'Learning correction',
    section: 'learning',
    requiredPlan: 'pro',
    summary: 'Past forecast errors correct future item, factor, and overall demand.',
  },
];

const normalisePlanId = (plan) => (PLAN_ORDER[plan] != null ? plan : 'starter');

const planAllows = (plan, requiredPlan) =>
  PLAN_ORDER[normalisePlanId(plan)] >= PLAN_ORDER[normalisePlanId(requiredPlan)];

const getFactorEntitlements = (plan = 'starter') => {
  const normalisedPlan = normalisePlanId(plan);
  const factors = FACTOR_CATALOG.map((factor) => ({
    ...factor,
    unlocked: planAllows(normalisedPlan, factor.requiredPlan),
  }));

  return {
    plan: normalisedPlan,
    factors,
    unlockedKeys: factors.filter((factor) => factor.unlocked).map((factor) => factor.key),
    lockedKeys: factors.filter((factor) => !factor.unlocked).map((factor) => factor.key),
  };
};

const factorUnlocked = (plan, key) => {
  const factor = FACTOR_CATALOG.find((entry) => entry.key === key || entry.section === key);
  return factor ? planAllows(plan, factor.requiredPlan) : true;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const isPlainObject = (value) =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const validateForecastSettingsInput = (input) => {
  if (!isPlainObject(input)) return 'settings must be an object';
  for (const section of Object.keys(DEFAULT_FORECAST_SETTINGS)) {
    if (input[section] !== undefined && !isPlainObject(input[section])) return `settings.${section} must be an object`;
  }
  return null;
};

const mergeDeep = (base, override) => {
  const merged = clone(base);
  if (!isPlainObject(override)) return merged;

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeDeep(merged[key], value);
    } else if (value !== undefined && !(isPlainObject(merged[key]) && !isPlainObject(value))) {
      merged[key] = value;
    }
  }
  return merged;
};

const finiteNumber = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
};

const booleanValue = (value, fallback) =>
  typeof value === 'boolean' ? value : fallback;

const normalizeWeightArray = (value, fallback, expectedLength) => {
  if (!Array.isArray(value) || value.length !== expectedLength) return [...fallback];
  const weights = value.map((v, index) => finiteNumber(v, fallback[index], 0, 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return [...fallback];
  return weights.map((weight) => Number((weight / total).toFixed(4)));
};

const normalizeRecentWeights = (value, fallback) => {
  if (!Array.isArray(value) || value.length !== fallback.length) return [...fallback];
  const weights = value.map((v, index) => finiteNumber(v, fallback[index], 0, 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return [...fallback];
  if (total <= 1) return weights;
  return weights.map((weight) => Number((weight / total).toFixed(4)));
};

const normalizeForecastSettings = (input = {}, base = DEFAULT_FORECAST_SETTINGS) => {
  const merged = mergeDeep(base, input);

  return {
    history: {
      maxWeeks: Math.round(finiteNumber(merged.history.maxWeeks, 8, 1, 16)),
      recentWeights: normalizeRecentWeights(
        merged.history.recentWeights,
        DEFAULT_FORECAST_SETTINGS.history.recentWeights
      ),
      twoWeekWeights: normalizeWeightArray(
        merged.history.twoWeekWeights,
        DEFAULT_FORECAST_SETTINGS.history.twoWeekWeights,
        2
      ),
    },
    weather: {
      enabled: booleanValue(merged.weather.enabled, true),
      hotTemp: finiteNumber(merged.weather.hotTemp, 27, -10, 45),
      coldTemp: finiteNumber(merged.weather.coldTemp, 18, -10, 45),
      hotColdDrinkPct: finiteNumber(merged.weather.hotColdDrinkPct, 30, -90, 200),
      hotCoffeePct: finiteNumber(merged.weather.hotCoffeePct, -10, -90, 200),
      coldCoffeePct: finiteNumber(merged.weather.coldCoffeePct, 15, -90, 200),
      coldColdDrinkPct: finiteNumber(merged.weather.coldColdDrinkPct, -20, -90, 200),
      rainPct: finiteNumber(merged.weather.rainPct, -10, -90, 200),
      minimumMultiplier: finiteNumber(merged.weather.minimumMultiplier, 0.1, 0.01, 1),
    },
    loadShedding: {
      enabled: booleanValue(merged.loadShedding.enabled, true),
      stage1To2Pct: finiteNumber(merged.loadShedding.stage1To2Pct, -8, -90, 200),
      stage3To4Pct: finiteNumber(merged.loadShedding.stage3To4Pct, -22, -90, 200),
      stage5PlusPct: finiteNumber(merged.loadShedding.stage5PlusPct, -40, -90, 200),
    },
    holiday: {
      enabled: booleanValue(merged.holiday.enabled, true),
      publicPct: finiteNumber(merged.holiday.publicPct, 15, -90, 200),
      schoolPct: finiteNumber(merged.holiday.schoolPct, 8, -90, 200),
      combinedPct: finiteNumber(merged.holiday.combinedPct, 20, -90, 200),
    },
    payday: {
      enabled: booleanValue(merged.payday.enabled, true),
      pct: finiteNumber(merged.payday.pct, 20, -90, 200),
    },
    events: {
      enabled: booleanValue(merged.events.enabled, true),
      lowPct: finiteNumber(merged.events.lowPct, 10, -90, 200),
      mediumPct: finiteNumber(merged.events.mediumPct, 20, -90, 200),
      highPct: finiteNumber(merged.events.highPct, 35, -90, 200),
    },
    stock: {
      safetyMarginPct: finiteNumber(merged.stock.safetyMarginPct, 10, 0, 100),
      maxBiasPct: finiteNumber(merged.stock.maxBiasPct, 50, 0, 100),
    },
    learning: {
      enabled: booleanValue(merged.learning.enabled, true),
    },
  };
};

const applyPlanEntitlements = (settings, plan = 'starter') => {
  const effective = clone(settings);

  for (const factorConfig of FACTOR_CATALOG) {
    if (factorUnlocked(plan, factorConfig.key)) continue;

    if (factorConfig.section === 'history') {
      effective.history = clone(DEFAULT_FORECAST_SETTINGS.history);
    } else if (factorConfig.section === 'stock') {
      effective.stock = { safetyMarginPct: 0, maxBiasPct: 0 };
    } else if (effective[factorConfig.section]?.enabled != null) {
      effective[factorConfig.section].enabled = false;
    }
  }

  return effective;
};

const getSavedForecastSettings = (cafe) =>
  normalizeForecastSettings(cafe?.forecastSettings || {});

const getForecastSettings = (cafe, plan = 'starter') =>
  applyPlanEntitlements(getSavedForecastSettings(cafe), plan);

const sameSettings = (left, right) => {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameSettings(value, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameSettings(left[key], right[key]));
  }
  return left === right;
};

const planLabel = (plan) => {
  const id = normalisePlanId(plan);
  return id.charAt(0).toUpperCase() + id.slice(1);
};

/**
 * Applies a settings update against the org's plan.
 *
 * Locked factors used to be accepted, stored, echoed back by the API, and then
 * clamped to their defaults the moment a forecast ran -- so a Starter customer
 * could set a 12-week lookback, see it saved, and watch it do nothing. A change
 * to a locked factor is now refused, naming the factor that needs the upgrade.
 *
 * Two things that look like changes are not. A locked value sent back exactly
 * as stored is a no-op. And the Factors page loads the effective (clamped)
 * view and sends the whole thing back, so locked sections always arrive at
 * their clamped values -- stock at 0/0, events disabled. That is an echo, not
 * an edit: it must not be refused, and it must not overwrite what is stored,
 * because the stored value is what the customer gets back on upgrade.
 *
 * Returns { settings } to persist, or { lockedChange } naming the first locked
 * factor the payload tried to change.
 */
const applyForecastSettingsUpdate = (cafe, input, plan = 'starter') => {
  const saved = getSavedForecastSettings(cafe);
  const effective = applyPlanEntitlements(saved, plan);
  const next = normalizeForecastSettings(input, saved);
  let settings = next;

  for (const factorConfig of FACTOR_CATALOG) {
    if (factorUnlocked(plan, factorConfig.key)) continue;
    const { section } = factorConfig;
    if (sameSettings(next[section], saved[section])) continue;
    if (sameSettings(next[section], effective[section])) {
      settings = { ...settings, [section]: clone(saved[section]) };
      continue;
    }
    const requiredPlan = normalisePlanId(factorConfig.requiredPlan);
    return {
      settings: null,
      lockedChange: {
        key: factorConfig.key,
        label: factorConfig.label,
        requiredPlan,
        message:
          `${factorConfig.label} settings are available on the ${planLabel(requiredPlan)} plan. ` +
          'Upgrade your plan to change them.',
      },
    };
  }

  return { settings, lockedChange: null };
};

const pctToMultiplier = (pct, minimumMultiplier = 0.1) =>
  Math.max(minimumMultiplier, 1 + (Number(pct) || 0) / 100);

const formatPct = (pct) => {
  const rounded = Number(Number(pct || 0).toFixed(1));
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
};

const factor = ({ key, label, adjustmentPct = 0, active = false, reason, minimumMultiplier = 0.1 }) => ({
  key,
  label,
  active,
  adjustmentPct: active ? Number(Number(adjustmentPct).toFixed(2)) : 0,
  multiplier: Number(pctToMultiplier(active ? adjustmentPct : 0, minimumMultiplier).toFixed(4)),
  effect: active ? formatPct(adjustmentPct) : 'no effect',
  reason: reason || '',
});

const isWeatherAvailable = (weather) =>
  Boolean(
    weather &&
    weather.available !== false &&
    Number.isFinite(weather.temp) &&
    typeof weather.condition === 'string' &&
    weather.condition.trim()
  );

const weatherTemperature = (weather) => (Number.isFinite(weather?.maxTemp) ? weather.maxTemp : weather?.temp);
const isRainy = (weather) => Boolean(isWeatherAvailable(weather) && weather.isRain === true);

const weatherAdjustmentPct = (category, weather, settings) => {
  if (!settings.enabled || !isWeatherAvailable(weather)) return 0;

  let pct = 0;
  if (weatherTemperature(weather) > settings.hotTemp) {
    if (category === 'cold_drink') pct += settings.hotColdDrinkPct;
    if (category === 'coffee') pct += settings.hotCoffeePct;
  } else if (weatherTemperature(weather) < settings.coldTemp) {
    if (category === 'coffee') pct += settings.coldCoffeePct;
    if (category === 'cold_drink') pct += settings.coldColdDrinkPct;
  }

  if (isRainy(weather)) pct += settings.rainPct;

  return pct;
};

const weatherSummaryFactor = (weather, settings) => {
  if (!settings.enabled) {
    return factor({ key: 'weather', label: 'Weather', reason: 'Weather factor disabled' });
  }
  if (!isWeatherAvailable(weather)) {
    return factor({
      key: 'weather',
      label: 'Weather',
      reason: weather?.unavailableReason || 'Weather data unavailable',
    });
  }

  const reasons = [];
  if (weatherTemperature(weather) > settings.hotTemp) {
    reasons.push(
      `hot day: ${formatPct(settings.hotColdDrinkPct)} cold drinks, ${formatPct(settings.hotCoffeePct)} coffee`
    );
  } else if (weatherTemperature(weather) < settings.coldTemp) {
    reasons.push(
      `cold day: ${formatPct(settings.coldCoffeePct)} coffee, ${formatPct(settings.coldColdDrinkPct)} cold drinks`
    );
  }
  if (isRainy(weather)) reasons.push(`rain: ${formatPct(settings.rainPct)}`);

  return {
    key: 'weather',
    label: 'Weather',
    active: reasons.length > 0,
    adjustmentPct: null,
    multiplier: null,
    effect: reasons.length > 0 ? reasons.join('; ') : 'no effect',
    reason: weather.condition || '',
  };
};

const weatherItemFactor = (category, weather, settings) => {
  const adjustmentPct = weatherAdjustmentPct(category, weather, settings);
  return factor({
    key: 'weather',
    label: 'Weather',
    active: adjustmentPct !== 0,
    adjustmentPct,
    minimumMultiplier: settings.minimumMultiplier,
    reason: isWeatherAvailable(weather)
      ? weather.condition
      : weather?.unavailableReason || 'Weather data unavailable',
  });
};

const loadSheddingFactor = (stage, settings, availability = {}) => {
  const stageAvailable = availability.available !== false && Number.isFinite(stage);
  let adjustmentPct = 0;
  if (settings.enabled && stageAvailable && stage > 0) {
    if (stage <= 2) adjustmentPct = settings.stage1To2Pct;
    else if (stage <= 4) adjustmentPct = settings.stage3To4Pct;
    else adjustmentPct = settings.stage5PlusPct;
  }
  return factor({
    key: 'loadShedding',
    label: 'Load shedding',
    active: adjustmentPct !== 0,
    adjustmentPct,
    reason: !settings.enabled
      ? 'Load-shedding factor disabled'
      : !stageAvailable
        ? availability.unavailableReason || 'Load-shedding data unavailable'
        : stage > 0
          ? `stage ${stage}`
          : '',
  });
};

const holidayFactor = (isPublicHoliday, isSchoolHoliday, settings) => {
  let adjustmentPct = 0;
  if (settings.enabled) {
    if (isPublicHoliday && isSchoolHoliday) adjustmentPct = settings.combinedPct;
    else if (isPublicHoliday) adjustmentPct = settings.publicPct;
    else if (isSchoolHoliday) adjustmentPct = settings.schoolPct;
  }
  return factor({
    key: 'holiday',
    label: 'Holiday',
    active: adjustmentPct !== 0,
    adjustmentPct,
    reason: isPublicHoliday && isSchoolHoliday
      ? 'public and school holiday'
      : isPublicHoliday
        ? 'public holiday'
        : isSchoolHoliday
          ? 'school holiday'
          : '',
  });
};

const paydayFactor = (isPayday, settings) =>
  factor({
    key: 'payday',
    label: 'Payday',
    active: Boolean(settings.enabled && isPayday),
    adjustmentPct: settings.pct,
    reason: isPayday ? 'payday window' : '',
  });

const eventImpactPct = (event, settings) => {
  if (Number.isFinite(Number(event?.impactPct))) {
    return finiteNumber(event.impactPct, 0, -90, 200);
  }
  if (event?.impact === 'high') return settings.highPct;
  if (event?.impact === 'medium') return settings.mediumPct;
  if (event?.impact === 'low') return settings.lowPct;
  return 0;
};

const eventsFactor = (events, settings) => {
  // Closure records are operational constraints, not demand-generating events.
  // They are applied by the forecast service's trading-hours multiplier.
  const demandEvents = (events || []).filter((event) => !event.type || event.type === 'event');
  if (!settings.enabled || demandEvents.length === 0) {
    return factor({ key: 'events', label: 'Events' });
  }

  const strongest = demandEvents
    .map((event) => ({ event, adjustmentPct: eventImpactPct(event, settings) }))
    .sort((a, b) => Math.abs(b.adjustmentPct) - Math.abs(a.adjustmentPct))[0];

  return factor({
    key: 'events',
    label: 'Events',
    active: strongest.adjustmentPct !== 0,
    adjustmentPct: strongest.adjustmentPct,
    reason: strongest.event?.name || '',
  });
};

const buildGlobalFactors = ({ signals, weather, events, settings }) => [
  weatherSummaryFactor(weather, settings.weather),
  loadSheddingFactor(signals.loadSheddingStage, settings.loadShedding, {
    available: signals.loadSheddingAvailable,
    unavailableReason: signals.loadSheddingUnavailableReason,
  }),
  holidayFactor(signals.isPublicHoliday, signals.isSchoolHoliday, settings.holiday),
  paydayFactor(signals.isPayday, settings.payday),
  eventsFactor(events, settings.events),
];

const buildItemFactors = ({ category, signals, weather, events, settings }) => [
  weatherItemFactor(category, weather, settings.weather),
  loadSheddingFactor(signals.loadSheddingStage, settings.loadShedding, {
    available: signals.loadSheddingAvailable,
    unavailableReason: signals.loadSheddingUnavailableReason,
  }),
  holidayFactor(signals.isPublicHoliday, signals.isSchoolHoliday, settings.holiday),
  paydayFactor(signals.isPayday, settings.payday),
  eventsFactor(events, settings.events),
];

const multiplyFactors = (factors) =>
  factors.reduce((product, current) => product * (Number(current.multiplier) || 1), 1);

module.exports = {
  validateForecastSettingsInput,
  weatherTemperature,
  DEFAULT_FORECAST_SETTINGS,
  FACTOR_CATALOG,
  getFactorEntitlements,
  factorUnlocked,
  applyPlanEntitlements,
  normalizeForecastSettings,
  getSavedForecastSettings,
  getForecastSettings,
  applyForecastSettingsUpdate,
  buildGlobalFactors,
  buildItemFactors,
  multiplyFactors,
  eventImpactPct,
};
