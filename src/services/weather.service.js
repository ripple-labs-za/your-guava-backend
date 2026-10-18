const axios = require('axios');

// In-memory cache: { key -> { data, fetchedAt } }
const weatherCache = new Map();
const pendingWeatherRequests = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const RAIN_MIN_MM = 1;
const RAIN_MIN_CHANCE_PCT = 70;

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

const cacheKeyFor = (lat, lng, dateStr) => `${lat},${lng},${dateStr}`;

const readCache = (cacheKey) => {
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
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

const rememberDay = (lat, lng, dayData) => {
  const result = normaliseDay(dayData);
  if (!result || !dayData.date) return null;

  weatherCache.set(cacheKeyFor(lat, lng, dayData.date), { data: result, fetchedAt: Date.now() });
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

const getWeatherForecast = async (lat, lng, date) => {
  const apiKey = process.env.WEATHER_API_KEY;
  const baseUrl = process.env.WEATHER_API_URL;

  if (!apiKey || !baseUrl) {
    // Log-only, once per process: a missing key is a configuration fact, not a per-request event.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn('[weather] WEATHER_API_KEY or WEATHER_API_URL not set');
    }
    return unavailableWeatherSignal('Weather service is not configured');
  }

  const targetDate = new Date(date);
  if (Number.isNaN(targetDate.getTime())) {
    return unavailableWeatherSignal('Weather date is invalid');
  }
  const dateStr = toDateKey(targetDate);
  const cacheKey = cacheKeyFor(lat, lng, dateStr);

  const cached = readCache(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const useHistory = isPastDate(targetDate);
    const pendingKey = useHistory ? `history:${cacheKey}` : `forecast:${lat},${lng}`;
    const response = await runDedupe(pendingKey, () =>
      axios.get(`${baseUrl}/${useHistory ? 'history.json' : 'forecast.json'}`, {
        params: useHistory
          ? {
              key: apiKey,
              q: `${lat},${lng}`,
              dt: dateStr,
            }
          : {
              key: apiKey,
              q: `${lat},${lng}`,
              days: 7,
            },
        timeout: 8000,
      })
    );

    const forecastDays = response.data?.forecast?.forecastday || [];
    for (const forecastDay of forecastDays) {
      rememberDay(lat, lng, forecastDay);
    }

    const result = readCache(cacheKey);
    if (!result) {
      return unavailableWeatherSignal('Weather provider returned no data for this date');
    }
    return result;
  } catch (error) {
    console.error('[weather] API error:', error.message);
    return unavailableWeatherSignal('Weather data is temporarily unavailable');
  }
};

const clearWeatherCache = () => {
  weatherCache.clear();
  pendingWeatherRequests.clear();
};

module.exports = { getWeatherForecast, unavailableWeatherSignal, clearWeatherCache, RAIN_MIN_MM, RAIN_MIN_CHANCE_PCT };
