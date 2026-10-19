const mockForecastFindOne = jest.fn();
const mockForecastFind = jest.fn();
const mockCafeFindById = jest.fn();
const mockCafeFindOne = jest.fn();
const mockTransactionAggregate = jest.fn();
const mockGenerateForecast = jest.fn();
const mockUpdateForecastActuals = jest.fn();
const mockClearApiCache = jest.fn();
const mockRangeActuals = jest.fn();
const mockMeter = jest.fn();

jest.mock('../../src/models/Forecast.model', () => ({
  findOne: (...args) => mockForecastFindOne(...args),
  find: (...args) => mockForecastFind(...args),
  countDocuments: jest.fn().mockResolvedValue(0),
  deleteMany: jest.fn(),
}));
jest.mock('../../src/models/Cafe.model', () => ({
  findById: (...args) => mockCafeFindById(...args),
  findOne: (...args) => mockCafeFindOne(...args),
}));
jest.mock('../../src/models/Organization.model', () => ({}));
jest.mock('../../src/models/Transaction.model', () => ({
  aggregate: (...args) => mockTransactionAggregate(...args),
}));
jest.mock('../../src/services/forecast.service', () => ({
  invalidatePlanningForecasts: jest.fn(),
  loadForecastContext: async () => ({ timezone: 'America/New_York', inputsVersion: 0 }),
  loadForecastInputs: async () => ({}),
  updateForecastActualsForRange: (...args) => mockRangeActuals(...args),
  BACKTEST_BASIS_NOTE: 'note',
  FORECAST_MODEL_VERSION: 'test-model',
  generateForecast: (...args) => mockGenerateForecast(...args),
  generateForecastsForDates: async (id, dates, options) => ({
    forecasts: await Promise.all(dates.map((date) => mockGenerateForecast(id, date, options))), failures: [],
  }),
  updateForecastActuals: (...args) => mockUpdateForecastActuals(...args),
}));
jest.mock('../../src/middleware/cache.middleware', () => ({ clearApiCache: (...args) => mockClearApiCache(...args) }));
jest.mock('../../src/services/forecastFactors.service', () => ({
  DEFAULT_FORECAST_SETTINGS: {},
  getFactorEntitlements: jest.fn(),
  getForecastSettings: jest.fn(),
  getSavedForecastSettings: jest.fn(),
  normalizeForecastSettings: jest.fn(),
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateBusinessChatResponse: jest.fn(),
  getCachedInsights: jest.fn(),
  refreshInsights: jest.fn(),
  streamBusinessChatResponse: jest.fn(),
}));
jest.mock('../../src/services/usage.service', () => ({
  historyBackfillCreditsPerDay: () => 1,
  meterGuavaCredits: (...args) => mockMeter(...args),
}));

const controller = require('../../src/controllers/forecasts.controller');

const cafeId = '507f1f77bcf86cd799439011';
const orgId = '507f1f77bcf86cd799439012';
const req = (overrides = {}) => ({
  user: { cafeId, orgId, id: 'user-1', role: 'owner' },
  query: {},
  body: {},
  ...overrides,
});
const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const timezoneQuery = (timezone = 'America/New_York') => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ timezone }) }),
});
const forecastQuery = (value) => {
  const promise = Promise.resolve(value);
  promise.lean = () => promise;
  return promise;
};

describe('forecast controller cafe-local dates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRangeActuals.mockResolvedValue({ scored: 1, cleared: 0 });
    mockMeter.mockImplementation(async ({ run }) => ({ result: await run(), replayed: false }));
    jest.useFakeTimers().setSystemTime(new Date('2026-03-08T07:30:00.000Z'));
    mockCafeFindById.mockReturnValue(timezoneQuery());
    mockForecastFindOne.mockReturnValue(forecastQuery(null));
    mockGenerateForecast.mockImplementation(async (_id, date) => ({ date }));
  });

  afterEach(() => jest.useRealTimers());

  it('uses DST-safe local midnights for today and tomorrow', async () => {
    const next = jest.fn();
    await controller.getToday(req(), response(), next);
    expect(mockForecastFindOne).toHaveBeenLastCalledWith({
      cafeId,
      date: new Date('2026-03-08T05:00:00.000Z'),
    });

    await controller.getTomorrow(req(), response(), next);
    expect(mockForecastFindOne).toHaveBeenLastCalledWith({
      cafeId,
      date: new Date('2026-03-09T04:00:00.000Z'),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('builds the seven-day range across a DST transition', async () => {
    mockForecastFind.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });
    const res = response();
    await controller.getWeek(req(), res, jest.fn());

    const range = mockForecastFind.mock.calls[0][0].date;
    expect(range).toEqual({
      $gte: new Date('2026-03-08T05:00:00.000Z'),
      $lt: new Date('2026-03-15T04:00:00.000Z'),
    });
    expect(mockGenerateForecast.mock.calls.map((call) => call[1])).toEqual([
      new Date('2026-03-08T05:00:00.000Z'),
      new Date('2026-03-09T04:00:00.000Z'),
      new Date('2026-03-10T04:00:00.000Z'),
      new Date('2026-03-11T04:00:00.000Z'),
      new Date('2026-03-12T04:00:00.000Z'),
      new Date('2026-03-13T04:00:00.000Z'),
      new Date('2026-03-14T04:00:00.000Z'),
    ]);
  });

  it('interprets manual date-only generation in the cafe timezone', async () => {
    await controller.generate(
      req({ body: { date: '2026-03-08' } }),
      response(),
      jest.fn()
    );
    expect(mockGenerateForecast).toHaveBeenCalledWith(
      cafeId,
      new Date('2026-03-08T05:00:00.000Z'),
      { origin: 'manual' }
    );
  });

  it('bounds accuracy to the previous thirty complete cafe-local days', async () => {
    const lean = jest.fn().mockResolvedValue([]);
    const select = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ select });
    mockForecastFind.mockReturnValue({ sort });

    const next = jest.fn();
    await controller.getAccuracy(req(), response(), next);
    expect(next).not.toHaveBeenCalled();

    expect(mockForecastFind.mock.calls[0][0].date).toEqual({
      $gte: new Date('2026-02-06T05:00:00.000Z'),
      $lt: new Date('2026-03-08T05:00:00.000Z'),
    });
  });

  it('uses cafe-local DST boundaries and keys for history', async () => {
    jest.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    mockCafeFindOne.mockReturnValue(timezoneQuery());
    mockTransactionAggregate.mockResolvedValue([]);
    mockForecastFind.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) });
    const res = response();

    await controller.getHistory(req({
      query: { startDate: '2026-03-08', endDate: '2026-03-08', backfill: 'false' },
    }), res, jest.fn());

    expect(mockTransactionAggregate.mock.calls[0][0][0].$match.date).toEqual({
      $gte: new Date('2026-03-08T05:00:00.000Z'),
      $lt: new Date('2026-03-09T04:00:00.000Z'),
    });
    expect(mockForecastFind.mock.calls[0][0].date).toEqual({
      $gte: new Date('2026-03-08T05:00:00.000Z'),
      $lt: new Date('2026-03-09T04:00:00.000Z'),
    });
    expect(res.json.mock.calls[0][0].meta).toEqual(expect.objectContaining({
      startDate: '2026-03-08',
      endDate: '2026-03-08',
    }));
  });

  it.each(['scoring', 're-read'])('preserves an original 402 and clears caches when history %s fails', async (stage) => {
    jest.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    mockCafeFindOne.mockReturnValue(timezoneQuery());
    mockTransactionAggregate.mockResolvedValue([
      { _id: '2026-03-08', actualRevenue: 100, transactionCount: 1 },
      { _id: '2026-03-07', actualRevenue: 100, transactionCount: 1 },
    ]);
    const scoringError = new Error('actuals unavailable');
    const original = Object.assign(new Error('No credits remain'), { statusCode: 402 });
    const lean = jest.fn().mockResolvedValue([]);
    mockForecastFind.mockReturnValue({ select: jest.fn().mockReturnThis(), lean });
    mockMeter.mockResolvedValueOnce({ result: { forecastId: 'paid-day' }, replayed: false }).mockRejectedValueOnce(original);
    if (stage === 'scoring') mockRangeActuals.mockRejectedValueOnce(scoringError);
    else lean.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValueOnce(scoringError);
    const logger = require('../../src/utils/logger');
    const log = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const next = jest.fn();
    try {
      await controller.getHistory(req({ query: {
        startDate: '2026-03-07', endDate: '2026-03-08', backfill: 'sync', backfillLimit: '2',
      } }), response(), next);
      expect(next).toHaveBeenCalledWith(original);
      expect(mockClearApiCache).toHaveBeenCalledWith({ cafeId });
      expect(log).toHaveBeenCalledWith('forecast_history_actuals_failed', expect.objectContaining({ cafeId }));
    } finally { log.mockRestore(); }
  });

  it('clears response caches after a synchronous history batch generates a forecast', async () => {
    jest.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    mockCafeFindOne.mockReturnValue(timezoneQuery());
    mockTransactionAggregate.mockResolvedValue([{
      _id: '2026-03-08',
      actualRevenue: 100,
      transactionCount: 1,
    }]);
    mockForecastFind.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) });
    mockForecastFindOne.mockReturnValue(forecastQuery(null));
    mockGenerateForecast.mockResolvedValue({
      _id: 'forecast-1',
      date: new Date('2026-03-08T05:00:00.000Z'),
      dateKey: '2026-03-08',
      origin: 'backfill',
      modelVersion: 'test-model',
      totalPredictedRevenue: 90,
      items: [],
      factors: [
        { key: 'weather', label: 'Weather', active: false },
        { key: 'loadShedding', label: 'Load shedding', active: false },
        { key: 'holiday', label: 'Holiday', active: false },
        { key: 'payday', label: 'Payday', active: false },
        { key: 'events', label: 'Events', active: false },
      ],
      factorSettings: {},
      factorEntitlements: {},
      calibration: { sampleSize: 0, overallMultiplier: 1 },
      signals: { weather: null, events: [] },
    });
    mockUpdateForecastActuals.mockResolvedValue(null);

    await controller.getHistory(req({
      query: {
        startDate: '2026-03-08',
        endDate: '2026-03-08',
        backfill: 'sync',
        backfillLimit: '1',
      },
    }), response(), jest.fn());

    expect(mockGenerateForecast).toHaveBeenCalledTimes(1);
    expect(mockClearApiCache).toHaveBeenCalledTimes(1);
    expect(mockClearApiCache).toHaveBeenCalledWith({ cafeId: cafeId });
  });
});
