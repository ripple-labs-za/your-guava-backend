jest.mock('axios');

const axios = require('axios');
const { getWeatherForecast, clearWeatherCache } = require('../../src/services/weather.service');
const { normalizeForecastSettings, buildItemFactors } = require('../../src/services/forecastFactors.service');

const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const provide = (day) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  axios.get.mockResolvedValueOnce({ data: { forecast: { forecastday: [{ date: dayKey(tomorrow), day }] } } });
  return tomorrow;
};
const baseSignals = { loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false };
const weatherFactor = (category, weather) =>
  buildItemFactors({ category, signals: baseSignals, weather, events: [], settings: normalizeForecastSettings() })
    .find((factor) => factor.key === 'weather');

describe('weather rules', () => {
  const original = { key: process.env.WEATHER_API_KEY, url: process.env.WEATHER_API_URL };
  beforeEach(() => {
    jest.clearAllMocks();
    clearWeatherCache();
    process.env.WEATHER_API_KEY = 'test-weather-key';
    process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
  });
  afterAll(() => {
    process.env.WEATHER_API_KEY = original.key ?? '';
    process.env.WEATHER_API_URL = original.url ?? '';
  });

  it('keeps the daytime high and treats trace rain as a dry day', async () => {
    const day = provide({
      avgtemp_c: 20, maxtemp_c: 29, avghumidity: 50, totalprecip_mm: 0.2, daily_chance_of_rain: 40,
      condition: { text: 'Patchy rain nearby' },
    });
    await expect(getWeatherForecast(-26.2, 28.0, day)).resolves.toEqual(expect.objectContaining({ maxTemp: 29, isRain: false }));
  });

  it('treats a millimetre or more as rain', async () => {
    const day = provide({ avgtemp_c: 15, maxtemp_c: 18, avghumidity: 80, totalprecip_mm: 1.4, condition: { text: 'Overcast' } });
    await expect(getWeatherForecast(-26.2, 28.0, day)).resolves.toEqual(expect.objectContaining({ isRain: true }));
  });

  it('uses the chance of rain only when no amount is given', async () => {
    const day = provide({ avgtemp_c: 15, maxtemp_c: 18, avghumidity: 80, daily_chance_of_rain: 75, condition: { text: 'Cloudy' } });
    await expect(getWeatherForecast(-26.2, 28.0, day)).resolves.toEqual(expect.objectContaining({ isRain: true }));
  });

  it('calls a day hot on its daytime high, not its 24-hour mean', () => {
    const weather = { available: true, temp: 20, maxTemp: 29, condition: 'Sunny', isRain: false };
    expect(weatherFactor('cold_drink', weather)).toEqual(expect.objectContaining({ active: true, adjustmentPct: 30 }));
  });

  it('does not call a day cold because its night was cold', () => {
    const weather = { available: true, temp: 14, maxTemp: 21, condition: 'Clear', isRain: false };
    expect(weatherFactor('coffee', weather)).toEqual(expect.objectContaining({ active: false, adjustmentPct: 0 }));
  });

  it('never rains on a word alone', () => {
    const weather = { available: true, temp: 20, maxTemp: 22, condition: 'Patchy rain nearby', isRain: false };
    expect(weatherFactor('food', weather)).toEqual(expect.objectContaining({ active: false, adjustmentPct: 0 }));
  });
});


describe('literal rain thresholds', () => {
  const previousKey = process.env.WEATHER_API_KEY;
  const previousUrl = process.env.WEATHER_API_URL;
  beforeEach(() => {
    jest.clearAllMocks();
    clearWeatherCache();
    process.env.WEATHER_API_KEY = 'test-weather-key';
    process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.WEATHER_API_KEY;
    else process.env.WEATHER_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = previousUrl;
  });
  it('pins one millimetre and seventy percent', () => {
    const { RAIN_MIN_MM, RAIN_MIN_CHANCE_PCT } = require('../../src/services/weather.service');
    expect(RAIN_MIN_MM).toBe(1);
    expect(RAIN_MIN_CHANCE_PCT).toBe(70);
  });
  it.each([[0.99, false], [1, true]])('rain at %s mm is %s even with a 100 percent chance', async (amount, expected) => {
    const date = provide({ avgtemp_c: 20, maxtemp_c: 22, avghumidity: 50, totalprecip_mm: amount, daily_chance_of_rain: 100, condition: { text: 'Rain' } });
    await expect(getWeatherForecast(-26.2, 28, date)).resolves.toEqual(expect.objectContaining({ isRain: expected }));
  });
  it.each([[69, false], [70, true]])('rain without an amount at %s percent is %s', async (chance, expected) => {
    const date = provide({ avgtemp_c: 20, maxtemp_c: 22, avghumidity: 50, daily_chance_of_rain: chance, condition: { text: 'Cloudy' } });
    await expect(getWeatherForecast(-26.2, 28, date)).resolves.toEqual(expect.objectContaining({ isRain: expected }));
  });
});
