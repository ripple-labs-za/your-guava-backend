const mockEventCreate = jest.fn();
const mockForecastDeleteMany = jest.fn();
const mockCafeFindById = jest.fn();
const mockClearApiCache = jest.fn();
const mockInvalidate = jest.fn().mockResolvedValue({ deletedCount: 2, inputsVersion: 1 });
jest.mock('../../src/services/forecast.service', () => ({
  invalidatePlanningForecasts: (...args) => mockInvalidate(...args),
}));

jest.mock('../../src/models/Event.model', () => ({
  create: (...args) => mockEventCreate(...args),
}));
jest.mock('../../src/models/Forecast.model', () => ({
  deleteMany: (...args) => mockForecastDeleteMany(...args),
}));
jest.mock('../../src/models/Transaction.model', () => ({
  aggregate: jest.fn(),
}));
jest.mock('../../src/models/Cafe.model', () => ({
  findById: (...args) => mockCafeFindById(...args),
}));
jest.mock('../../src/services/forecastFactors.service', () => ({
  getForecastSettings: jest.fn(),
  eventImpactPct: jest.fn(),
}));
jest.mock('../../src/middleware/cache.middleware', () => ({
  clearApiCache: (...args) => mockClearApiCache(...args),
}));

const { create } = require('../../src/controllers/events.controller');

const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('event forecast invalidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCafeFindById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ timezone: 'Africa/Johannesburg' }),
      }),
    });
    mockForecastDeleteMany.mockResolvedValue({ deletedCount: 2 });
    mockEventCreate.mockResolvedValue({
      _id: 'event-1',
      name: 'Market day',
      date: new Date('2030-01-10T00:00:00.000Z'),
    });
  });

  it('clears API responses after deleting affected planning forecasts', async () => {
    const res = response();
    const next = jest.fn();

    await create({
      user: { cafeId: '507f1f77bcf86cd799439011' },
      body: { name: 'Market day', date: '2030-01-10' },
    }, res, next);

    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(mockInvalidate).toHaveBeenCalledWith('507f1f77bcf86cd799439011', {
      from: new Date('2030-01-09T22:00:00.000Z'), timezone: 'Africa/Johannesburg',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(next).not.toHaveBeenCalled();
  });
});
