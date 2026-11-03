const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { outboundGet } = require('../utils/http');
const { DATE_ONLY_RE, safeTimezone, zonedDateKey } = require('../utils/timezone');
const WeatherDay = require('../models/WeatherDay.model');

// In-memory cache: { key -> { data, fetchedAt } }
const weatherCache = new Map();
const pendingWeatherRequests = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const WEATHER_CACHE_MAX_ENTRIES = 2000;
const WEATHER_FAILURE_TTL_MS = 2 * 60 * 1000;
const failedWeatherRequests = new Map();
const RAIN_MIN_MM = 1;
const RAIN_MIN_CHANCE_PCT = 70;
const WEATHER_NOT_ON_PLAN = 'Weather not available on the weather plan';

const unavailableWeatherSignal = (unavailableReason = 'Weather data is unavailable') => ({
  available: false,
  condition: 'Unavailable',
  unavailableReason,
});

const finiteMetric = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const isPastDate = (date) => startOfDay(date).getTime() < startOfDay(new Date()).getTime();

// `query` is what WeatherAPI is asked for: "lat,lng", or a place name for a cafe without coordinates (F-2).
const cacheKeyFor = (query, dateStr) => `${query},${dateStr}`;

const readCache = (cacheKey) => {
  const cached = weatherCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt >= CACHE_TTL_MS) {
    weatherCache.delete(cacheKey);
    return null;
  }
  weatherCache.delete(cacheKey);
  weatherCache.set(cacheKey, cached);
  return cached.data;
};

const normaliseDay = (dayData) => {
  if (!dayData?.day) return null;

  const day = dayData.day;
  const temp = finiteMetric(day.avgtemp_c);
  const humidity = finiteMetric(day.avghumidity);
  const conditionText = typeof day.condition?.text === 'string'
    ? day.condition.text.trim()
    : '';
  if (
    temp === null ||
    temp < -90 ||
    temp > 70 ||
    humidity === null ||
    humidity < 0 ||
    humidity > 100 ||
    !conditionText ||
    conditionText.length > 200
  ) return null;

  const rawPrecipMm = finiteMetric(day.totalprecip_mm);
  const precipMm = rawPrecipMm !== null && rawPrecipMm >= 0 ? rawPrecipMm : null;
  const rawChanceOfRain = finiteMetric(day.daily_chance_of_rain);
  const chanceOfRain = rawChanceOfRain !== null && rawChanceOfRain >= 0 && rawChanceOfRain <= 100
    ? rawChanceOfRain
    : null;
  const rawMaxTemp = finiteMetric(day.maxtemp_c);
  const maxTemp = rawMaxTemp !== null && rawMaxTemp >= -90 && rawMaxTemp <= 70 ? rawMaxTemp : null;
  const isRain = precipMm !== null
    ? precipMm >= RAIN_MIN_MM
    : chanceOfRain !== null && chanceOfRain >= RAIN_MIN_CHANCE_PCT;

  return {
    available: true,
    temp,
    ...(maxTemp !== null ? { maxTemp } : {}),
    condition: conditionText,
    humidity,
    isRain,
    ...(precipMm !== null ? { precipMm } : {}),
    ...(chanceOfRain !== null ? { chanceOfRain } : {}),
  };
};

const rememberDay = (query, dayData) => {
  const result = normaliseDay(dayData);
  if (!result || !dayData.date) return null;

  const key = cacheKeyFor(query, dayData.date);
  weatherCache.delete(key);
  weatherCache.set(key, { data: result, fetchedAt: Date.now() });
  while (weatherCache.size > WEATHER_CACHE_MAX_ENTRIES) weatherCache.delete(weatherCache.keys().next().value);
  return result;
};

const runDedupe = async (pendingKey, fn) => {
  if (pendingWeatherRequests.has(pendingKey)) {
    return pendingWeatherRequests.get(pendingKey);
  }

  const promise = fn().finally(() => pendingWeatherRequests.delete(pendingKey));
  pendingWeatherRequests.set(pendingKey, promise);
  return promise;
};

/**
 * Fetches the weather forecast/history for a given lat/lng and date.
 * Uses WeatherAPI.com /history.json for past dates and /forecast.json otherwise.
 * Returns an explicit unavailable signal when configuration or provider data
 * is unavailable. It never invents weather observations.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Date|string} date
 * @returns {Promise<object>}
 */
let warnedUnconfigured = false;

/**
 * The same lookup for a place query ("lat,lng" or a place name). `date` is a Date (its server-local calendar day, as
 * processLocalCalendarDate builds it) or a "YYYY-MM-DD" key. With `timezone`, past or future is decided by the cafe's
 * own local date (F-6), not the server's.
 */
const getWeatherForQuery = async (query, date, { timezone } = {}) => {
  const apiKey = process.env.WEATHER_API_KEY;
  const baseUrl = process.env.WEATHER_API_URL;

  if (!apiKey || !baseUrl) {
    // Log-only, once per process: a missing key is a configuration fact, not a per-request event.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.warn('weather_unconfigured', {});
    }
    return unavailableWeatherSignal('Weather service is not configured');
  }

  const isKey = typeof date === 'string' && DATE_ONLY_RE.test(date);
  const targetDate = isKey ? null : new Date(date);
  if (!isKey && Number.isNaN(targetDate.getTime())) {
    return unavailableWeatherSignal('Weather date is invalid');
  }
  const dateStr = isKey ? date : toDateKey(targetDate);
  const cacheKey = cacheKeyFor(query, dateStr);

  const cached = readCache(cacheKey);
  if (cached) {
    return cached;
  }

  const useHistory = timezone
    ? dateStr < zonedDateKey(new Date(), safeTimezone(timezone))
    : isPastDate(isKey ? new Date(`${dateStr}T12:00:00`) : targetDate);
  const pendingKey = useHistory ? `history:${cacheKey}` : `forecast:${query}`;
  const retryAt = failedWeatherRequests.get(pendingKey);
  if (retryAt && retryAt > Date.now()) {
    return { ...unavailableWeatherSignal('Weather data is temporarily unavailable'), transient: true };
  }
  failedWeatherRequests.delete(pendingKey);
  try {
    const response = await runDedupe(pendingKey, () =>
      outboundGet('weather', `${baseUrl}/${useHistory ? 'history.json' : 'forecast.json'}`, {
        params: useHistory
          ? {
              key: apiKey,
              q: query,
              dt: dateStr,
            }
          : {
              key: apiKey,
              q: query,
              days: 7,
            },
      })
    );

    const forecastDays = response.data?.forecast?.forecastday || [];
    // The requested day present but rejected by normaliseDay is a different
    // failure from the day being absent, and says so (BE-12-T03).
    let requestedDayRejected = false;
    let lastReturnedDay = null;
    for (const forecastDay of forecastDays) {
      const kept = rememberDay(query, forecastDay);
      if (!kept && forecastDay?.date === dateStr) requestedDayRejected = true;
      if (typeof forecastDay?.date === 'string' && (!lastReturnedDay || forecastDay.date > lastReturnedDay)) lastReturnedDay = forecastDay.date;
    }

    const result = readCache(cacheKey);
    if (!result) {
      // F-3: the account's plan decides how many days the provider returns; a later day is not a provider fault.
      if (!useHistory && !requestedDayRejected && lastReturnedDay && dateStr > lastReturnedDay) {
        return unavailableWeatherSignal('Weather not available yet');
      }
      return unavailableWeatherSignal(requestedDayRejected
        ? 'Weather provider returned implausible values for this date'
        : 'Weather provider returned no data for this date');
    }
    return result;
  } catch (error) {
    // W-2: a history date the account's plan does not cover is refused with 403 / error 2009 ("does not have access to
    // the resource"). That is a fact about the plan, not a passing fault: say so, and callers never ask again.
    const providerStatus = error?.response?.status;
    const providerCode = error?.response?.data?.error?.code;
    if (useHistory && (providerStatus === 403 || providerCode === 2009)) {
      logger.warn('weather_history_not_on_plan', { status: providerStatus, code: providerCode });
      return { ...unavailableWeatherSignal(WEATHER_NOT_ON_PLAN), planRefused: true };
    }
    failedWeatherRequests.delete(pendingKey);
    failedWeatherRequests.set(pendingKey, Date.now() + WEATHER_FAILURE_TTL_MS);
    while (failedWeatherRequests.size > 500) failedWeatherRequests.delete(failedWeatherRequests.keys().next().value);
    logger.error('weather_api_failed', logger.errorFields(error));
    return { ...unavailableWeatherSignal('Weather data is temporarily unavailable'), transient: true };
  }
};

const getWeatherForecast = (lat, lng, date, options) => getWeatherForQuery(`${lat},${lng}`, date, options);

const validCoordinates = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

/**
 * What to ask WeatherAPI for this cafe: its coordinates, or (F-2) its city with the country, as a place name
 * WeatherAPI resolves itself. The street address is never sent: a city is enough for the day's weather. Null when the
 * cafe has neither, and Factors asks for the location.
 */
const weatherQueryForCafe = (cafe) => {
  const location = cafe?.location || {};
  if (validCoordinates(location.lat, location.lng)) return `${location.lat},${location.lng}`;
  const text = (value, max) => (typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : '');
  const place = text(location.city, 120);
  if (!place) return null;
  const country = text(location.country, 120);
  return country && !place.toLowerCase().includes(country.toLowerCase()) ? `${place}, ${country}` : place;
};

const snapshotOf = (signal) => {
  const snapshot = { available: true, fetchedAt: new Date() };
  for (const field of ['temp', 'maxTemp', 'humidity', 'precipMm', 'chanceOfRain']) {
    if (Number.isFinite(signal[field])) snapshot[field] = signal[field];
  }
  if (typeof signal.condition === 'string') snapshot.condition = signal.condition.slice(0, 200);
  if (typeof signal.isRain === 'boolean') snapshot.isRain = signal.isRain;
  return snapshot;
};

/**
 * W-1: keep one day's weather for one cafe. `kind` is 'forecast' (taken while the day is ahead) or 'observed'
 * (history once the day has closed). Only real provider readings are stored. Never throws: storing weather must not
 * fail the forecast or the nightly job that called it.
 */
const saveWeatherDay = async ({ cafeId, dateKey, kind, signal, query }) => {
  if (!mongoose.isValidObjectId(cafeId) || typeof dateKey !== 'string' || !DATE_ONLY_RE.test(dateKey)) return false;
  if (!['forecast', 'observed'].includes(kind) || signal?.available !== true) return false;
  const set = { [kind]: snapshotOf(signal), source: 'weatherapi', ...(query ? { query: String(query).slice(0, 200) } : {}) };
  try {
    await WeatherDay.updateOne({ cafeId, dateKey }, { $set: set }, { upsert: true });
    return true;
  } catch (error) {
    if (error?.code === 11000) {
      // Two writers inserted the same day at once; the record exists now, so set the field on it.
      try {
        await WeatherDay.updateOne({ cafeId, dateKey }, { $set: set });
        return true;
      } catch (retryError) {
        logger.warn('weather_day_save_failed', logger.errorFields(retryError));
        return false;
      }
    }
    logger.warn('weather_day_save_failed', logger.errorFields(error));
    return false;
  }
};

// A plan refusal is re-checked after this long, so a cafe whose WeatherAPI plan is upgraded gets those days filled.
const NOT_ON_PLAN_RECHECK_DAYS = 30;

/** The days that need no lookup: observed weather kept, or a plan refusal recorded within the recheck period. */
const knownObservedWeather = (now = new Date()) => ({
  $or: [
    { 'observed.available': true },
    { 'observedUnavailable.at': { $gte: new Date(now.getTime() - NOT_ON_PLAN_RECHECK_DAYS * 864e5) } },
  ],
});

/** W-2: the provider's plan does not cover this day. Recorded once, re-checked after NOT_ON_PLAN_RECHECK_DAYS; additive. */
const markObservedUnavailable = async ({ cafeId, dateKey, reason, query }) => {
  if (!mongoose.isValidObjectId(cafeId) || typeof dateKey !== 'string' || !DATE_ONLY_RE.test(dateKey)) return false;
  try {
    await WeatherDay.updateOne({ cafeId, dateKey }, {
      $set: { observedUnavailable: { reason: String(reason).slice(0, 200), at: new Date() }, source: 'weatherapi', ...(query ? { query } : {}) },
    }, { upsert: true });
    return true;
  } catch (error) {
    logger.warn('weather_day_save_failed', logger.errorFields(error));
    return false;
  }
};

/**
 * Observed weather for a closed cafe-local day, fetched once and kept. A day the plan refused is never asked for again;
 * a missing key or a passing fault records nothing, so the day is tried on a later night.
 */
const observeWeatherForDay = async (cafe, dateKey) => {
  const timezone = safeTimezone(cafe?.timezone);
  if (typeof dateKey !== 'string' || !DATE_ONLY_RE.test(dateKey) || dateKey >= zonedDateKey(new Date(), timezone)) {
    return { status: 'open' };
  }
  const query = weatherQueryForCafe(cafe);
  if (!query) return { status: 'no_location' };
  const known = await WeatherDay.findOne({ cafeId: cafe._id, dateKey, ...knownObservedWeather() })
    .select('observed.available observedUnavailable').lean();
  if (known) return { status: known.observed?.available ? 'already' : 'not_on_plan' };
  const signal = await getWeatherForQuery(query, dateKey, { timezone });
  if (signal?.planRefused) {
    await markObservedUnavailable({ cafeId: cafe._id, dateKey, reason: signal.unavailableReason, query });
    return { status: 'not_on_plan' };
  }
  if (signal?.available !== true) return { status: 'unavailable', reason: signal?.unavailableReason };
  return { status: (await saveWeatherDay({ cafeId: cafe._id, dateKey, kind: 'observed', signal, query })) ? 'observed' : 'unsaved' };
};

/** dateKey -> observed snapshot, for the days that have one. */
const loadObservedWeatherByDateKey = async (cafeId, dateKeys) => {
  // An id that is not an ObjectId has no stored days; the read must not throw into forecasting.
  if (!mongoose.isValidObjectId(cafeId) || !dateKeys?.length) return new Map();
  const docs = await WeatherDay.find({ cafeId, dateKey: { $in: dateKeys }, 'observed.available': true })
    .select('dateKey observed').lean();
  return new Map(docs.map((doc) => [doc.dateKey, doc.observed]));
};

const clearWeatherCache = () => {
  weatherCache.clear();
  pendingWeatherRequests.clear();
  failedWeatherRequests.clear();
};

module.exports = {
  _test: { cacheSize: () => weatherCache.size, WEATHER_CACHE_MAX_ENTRIES, WEATHER_FAILURE_TTL_MS },
  getWeatherForecast, getWeatherForQuery, weatherQueryForCafe, saveWeatherDay, observeWeatherForDay, markObservedUnavailable,
  knownObservedWeather, NOT_ON_PLAN_RECHECK_DAYS,
  loadObservedWeatherByDateKey, unavailableWeatherSignal, clearWeatherCache, RAIN_MIN_MM, RAIN_MIN_CHANCE_PCT, WEATHER_NOT_ON_PLAN };
