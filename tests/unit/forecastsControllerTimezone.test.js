const mockForecastFindOne = jest.fn();
const mockForecastFind = jest.fn();
const mockCafeFindById = jest.fn();
const mockCafeFindOne = jest.fn();
const mockTransactionAggregate = jest.fn();
const mockGenerateForecast = jest.fn();
const mockUpdateForecastActuals = jest.fn();
const mockClearApiCache = jest.fn();

jest.mock('../../src/models/Forecast.model', () => ({
  findOne: (...args) => mockForecastFindOne(...args),
  find: (...args) => mockForecastFind(...args),
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
  BACKTEST_BASIS_NOTE: 'note',
  FORECAST_MODEL_VERSION: 'test-model',
  generateForecast: (...args) => mockGenerateForecast(...args),
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
jest.mock('../../src/services/usage.service', () => ({ meterGuavaCredits: jest.fn() }));

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

describe('forecast controller cafe-local dates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-03-08T07:30:00.000Z'));
    mockCafeFindById.mockReturnValue(timezoneQuery());
    mockForecastFindOne.mockResolvedValue(null);
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

    await controller.getAccuracy(req(), response(), jest.fn());

    expect(mockForecastFind.mock.calls[0][0].date).toEqual({
      $gte: new Date('2026-02-06T05:00:00.000Z'),
      $lt: new Date('2026-03-08T05:00:00.000Z'),
    });
  });

  it('uses cafe-local DST boundaries and keys for history', async () => {
    jest.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    mockCafeFindOne.mockReturnValue(timezoneQuery());
    mockTransactionAggregate.mockResolvedValue([]);
    mockForecastFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
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

  it('clears response caches after a synchronous history batch generates a forecast', async () => {
    jest.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    mockCafeFindOne.mockReturnValue(timezoneQuery());
    mockTransactionAggregate.mockResolvedValue([{
      _id: '2026-03-08',
      actualRevenue: 100,
      transactionCount: 1,
    }]);
    mockForecastFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    mockForecastFindOne.mockResolvedValue(null);
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
