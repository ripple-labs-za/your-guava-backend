const logger = require('../../src/utils/logger');
jest.mock('axios');

const axios = require('axios');
const { getWeatherForecast, clearWeatherCache } = require('../../src/services/weather.service');

const toDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('weather service', () => {
  it('warns once per process, not once per call, when weather is not configured', async () => {
    process.env.WEATHER_API_KEY = '';
    await jest.isolateModulesAsync(async () => {
      const isolatedLogger = require('../../src/utils/logger');
      const warn = jest.spyOn(isolatedLogger, 'warn').mockImplementation(() => {});
      try {
        const { getWeatherForecast: fresh } = require('../../src/services/weather.service');
        await fresh(-33.9, 18.4, new Date());
        await fresh(-33.9, 18.4, new Date());
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('weather_unconfigured', {});
      } finally { warn.mockRestore(); }
    });
  });

  const originalKey = process.env.WEATHER_API_KEY;
  const originalUrl = process.env.WEATHER_API_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    clearWeatherCache();
    process.env.WEATHER_API_KEY = 'test-weather-key';
    process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.WEATHER_API_KEY;
    else process.env.WEATHER_API_KEY = originalKey;

    if (originalUrl === undefined) delete process.env.WEATHER_API_URL;
    else process.env.WEATHER_API_URL = originalUrl;
  });

  it('uses WeatherAPI history endpoint for past dates', async () => {
    const past = new Date();
    past.setDate(past.getDate() - 1);
    const dateStr = toDateKey(past);

    axios.get.mockResolvedValueOnce({
      data: {
        forecast: {
          forecastday: [
            {
              date: dateStr,
              day: {
                avgtemp_c: 15,
                avghumidity: 82,
                totalprecip_mm: 4.2,
                daily_chance_of_rain: 78,
                condition: { text: 'Patchy rain nearby' },
              },
            },
          ],
        },
      },
    });

    const result = await getWeatherForecast(-33.9, 18.4, past);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.weatherapi.com/v1/history.json',
      expect.objectContaining({
        params: expect.objectContaining({ dt: dateStr, q: '-33.9,18.4' }),
      })
    );
    expect(result).toEqual({
      available: true,
      temp: 15,
      condition: 'Patchy rain nearby',
      humidity: 82,
      isRain: true,
      precipMm: 4.2,
      chanceOfRain: 78,
    });
  });

  it('uses WeatherAPI forecast endpoint for current and future dates', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 1);
    const dateStr = toDateKey(future);

    axios.get.mockResolvedValueOnce({
      data: {
        forecast: {
          forecastday: [
            {
              date: dateStr,
              day: {
                avgtemp_c: 23,
                avghumidity: 55,
                totalprecip_mm: 0,
                daily_chance_of_rain: 0,
                condition: { text: 'Sunny' },
              },
            },
          ],
        },
      },
    });

    const result = await getWeatherForecast(-33.9, 18.4, future);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.weatherapi.com/v1/forecast.json',
      expect.objectContaining({
        params: expect.objectContaining({ days: 7, q: '-33.9,18.4' }),
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        temp: 23,
        condition: 'Sunny',
        isRain: false,
      })
    );
  });

  it('caches every day from a forecast response for follow-up future dates', async () => {
    const first = new Date();
    first.setDate(first.getDate() + 1);
    const second = new Date();
    second.setDate(second.getDate() + 2);
    const firstStr = toDateKey(first);
    const secondStr = toDateKey(second);

    axios.get.mockResolvedValueOnce({
      data: {
        forecast: {
          forecastday: [
            {
              date: firstStr,
              day: {
                avgtemp_c: 21,
                avghumidity: 52,
                totalprecip_mm: 0,
                daily_chance_of_rain: 0,
                condition: { text: 'Clear' },
              },
            },
            {
              date: secondStr,
              day: {
                avgtemp_c: 17,
                avghumidity: 72,
                totalprecip_mm: 1.2,
                daily_chance_of_rain: 62,
                condition: { text: 'Light rain' },
              },
            },
          ],
        },
      },
    });

    await getWeatherForecast(-33.9, 18.4, first);
    const secondResult = await getWeatherForecast(-33.9, 18.4, second);

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(
      expect.objectContaining({
        temp: 17,
        condition: 'Light rain',
        isRain: true,
      })
    );
  });

  it('returns an explicit unavailable signal when weather is not configured', async () => {
    process.env.WEATHER_API_KEY = '';
    process.env.WEATHER_API_URL = '';

    const result = await getWeatherForecast(-33.9, 18.4, new Date());

    expect(axios.get).not.toHaveBeenCalled();
    expect(result).toEqual({
      available: false,
      condition: 'Unavailable',
      unavailableReason: 'Weather service is not configured',
    });
    expect(result).not.toHaveProperty('temp');
    expect(result).not.toHaveProperty('humidity');
  });

  it('does not fabricate weather when the provider request fails', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    axios.get.mockRejectedValueOnce(new Error('provider offline'));

    const result = await getWeatherForecast(-33.9, 18.4, new Date());

    expect(result).toEqual({
      available: false,
      condition: 'Unavailable',
      unavailableReason: 'Weather data is temporarily unavailable',
      transient: true,
    });
    expect(result).not.toHaveProperty('temp');
    expect(result).not.toHaveProperty('humidity');
    errorSpy.mockRestore();
  });

  it('rejects impossible core weather metrics instead of applying them', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        forecast: {
          forecastday: [
            {
              date: new Date().toISOString().slice(0, 10),
              day: {
                avgtemp_c: 999,
                avghumidity: 140,
                condition: { text: 'Sunny' },
              },
            },
          ],
        },
      },
    });

    const result = await getWeatherForecast(-33.9, 18.4, new Date());

    expect(result).toEqual({
      available: false,
      condition: 'Unavailable',
      unavailableReason: 'Weather provider returned no data for this date',
    });
  });
});
