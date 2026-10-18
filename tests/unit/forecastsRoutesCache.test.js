const mockHistoryCache = jest.fn((_req, _res, next) => next());

jest.mock('../../src/middleware/auth.middleware', () => (_req, _res, next) => next());
jest.mock('../../src/middleware/rbac.middleware', () => ({
  ownerOnly: (_req, _res, next) => next(),
  requireCreditSpend: (_req, _res, next) => next(),
}));
jest.mock('../../src/middleware/rateLimit.middleware', () => ({
  aiLimiter: (_req, _res, next) => next(),
}));
jest.mock('../../src/middleware/cache.middleware', () => ({
  ...jest.requireActual('../../src/middleware/cache.middleware'),
  apiCache: jest.fn(({ keyPrefix }) => (
    keyPrefix === 'forecast-history'
      ? (...args) => mockHistoryCache(...args)
      : (_req, _res, next) => next()
  )),
}));
jest.mock('../../src/controllers/forecasts.controller', () => ({
  getToday: jest.fn(),
  getTomorrow: jest.fn(),
  getWeek: jest.fn(),
  generate: jest.fn(),
  getFactors: jest.fn(),
  updateFactors: jest.fn(),
  getAccuracy: jest.fn(),
  getHistory: jest.fn(),
  getInsights: jest.fn(),
  refreshGeneratedInsights: jest.fn(),
  chatInsights: jest.fn(),
  streamChatInsights: jest.fn(),
  getRecent: jest.fn(),
}));

const router = require('../../src/routes/forecasts.routes');

const historyCacheHandler = () => {
  const layer = router.stack.find((entry) => entry.route?.path === '/history');
  return layer.route.stack[0].handle;
};

describe('forecast history route caching', () => {
  beforeEach(() => jest.clearAllMocks());

  it('bypasses the read cache for a synchronous backfill request', () => {
    const next = jest.fn();

    historyCacheHandler()({ query: { backfill: 'sync' } }, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockHistoryCache).not.toHaveBeenCalled();
  });

  it('uses the short read cache for an ordinary history request', () => {
    const next = jest.fn();
    const req = { query: { days: '90' } };
    const res = {};

    historyCacheHandler()(req, res, next);

    expect(mockHistoryCache).toHaveBeenCalledWith(req, res, next);
  });
});
