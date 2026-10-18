jest.mock('axios');

const axios = require('axios');
const weather = require('../../src/services/weather.service');
const { getLoadSheddingStage, clearLoadSheddingCache } = require('../../src/utils/signals');

const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const answerWithRequestedDay = () =>
  axios.get.mockImplementation(async (_url, { params }) => ({
    data: { forecast: { forecastday: [{ date: params.dt, day: { avgtemp_c: 18, maxtemp_c: 22, avghumidity: 60, condition: { text: 'Clear' } } }] } },
  }));

describe('weather cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    weather.clearWeatherCache();
    process.env.WEATHER_API_KEY = 'test-weather-key';
    process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    process.env.WEATHER_API_KEY = '';
    process.env.WEATHER_API_URL = '';
  });

  it('stays within its entry limit and evicts the oldest day', async () => {
    answerWithRequestedDay();
    const days = Array.from({ length: 2500 }, (_, i) => new Date(2015, 0, 1 + i, 12));
    for (const day of days) await weather.getWeatherForecast(-26.2, 28.0, day);

    expect(weather._test.cacheSize()).toBeLessThanOrEqual(2000);
    await weather.getWeatherForecast(-26.2, 28.0, days[days.length - 1]);
    expect(axios.get).toHaveBeenCalledTimes(2500); // the newest day is still cached
    await weather.getWeatherForecast(-26.2, 28.0, days[0]);
    expect(axios.get).toHaveBeenCalledTimes(2501); // the oldest was evicted
  });

  it('deletes an expired entry when it is read', async () => {
    answerWithRequestedDay();
    await weather.getWeatherForecast(-26.2, 28.0, new Date(2015, 0, 1, 12));
    expect(weather._test.cacheSize()).toBe(1);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 61 * 60 * 1000);
    await weather.getWeatherForecast(-26.2, 28.0, new Date(2015, 0, 1, 12));
    expect(axios.get).toHaveBeenCalledTimes(2); // refetched, and the stale entry was replaced rather than kept beside it
    expect(weather._test.cacheSize()).toBe(1);
  });

  it('does not retry a failed provider for two minutes', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockRejectedValue(new Error('timeout of 8000ms exceeded'));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const first = await weather.getWeatherForecast(-26.2, 28.0, tomorrow);
    const second = await weather.getWeatherForecast(-26.2, 28.0, tomorrow);
    expect(first).toEqual(expect.objectContaining({ available: false, transient: true }));
    expect(second).toEqual(first);
    expect(axios.get).toHaveBeenCalledTimes(1);

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 2 * 60 * 1000 + 1);
    await weather.getWeatherForecast(-26.2, 28.0, tomorrow);
    expect(axios.get).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});

describe('load-shedding lookups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearLoadSheddingCache();
    process.env.ESKOMSEPUSH_API_KEY = 'test-eskom-key';
  });
  afterAll(() => { delete process.env.ESKOMSEPUSH_API_KEY; });

  it('shares one in-flight request between concurrent lookups', async () => {
    let answer;
    axios.get.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const lookups = [getLoadSheddingStage('Johannesburg'), getLoadSheddingStage('Pretoria')];
    answer({ data: { status: { eskom: { stage: '2', next_stages: [] }, capetown: { stage: '0', next_stages: [] } } } });

    await expect(Promise.all(lookups)).resolves.toEqual([{ available: true, stage: 2 }, { available: true, stage: 2 }]);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed provider for two minutes', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockRejectedValue(new Error('provider offline'));

    await getLoadSheddingStage('Johannesburg');
    const second = await getLoadSheddingStage('Johannesburg');

    expect(second).toEqual(expect.objectContaining({ available: false, unavailableReason: 'Load-shedding data is temporarily unavailable' }));
    expect(axios.get).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
