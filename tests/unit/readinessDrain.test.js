const mockHello = jest.fn().mockResolvedValue({ setName: 'unit-rs' });
jest.mock('mongoose', () => ({ connection: {
  readyState: 1, db: { admin: () => ({ command: mockHello }) },
} }));
jest.mock('../../src/config/validateEnv', () => jest.fn());
jest.mock('../../src/services/r2.service', () => ({ getConfigurationStatus: () => ({ ok: true }) }));
jest.mock('../../src/services/email.service', () => ({ deliveryCapability: () => ({ ok: true }) }));
jest.mock('../../src/services/paymentProvider.service', () => ({ paymentCapability: () => ({ ok: true }) }));
jest.mock('../../src/migrations/runner', () => ({
  migrationReadiness: async () => ({ ok: true, pending: [], running: [], failed: [] }),
}));
const lifecycle = require('../../src/utils/lifecycle');
const { readiness, _resetReadinessCache } = require('../../src/controllers/health.controller');

afterEach(() => { lifecycle.resetLifecycleForTests(); _resetReadinessCache(); });

it.each([false, true])('reports draining before cached or detailed readiness (operator=%s)', async (operator) => {
  const keys = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'MONGODB_URI', 'READINESS_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.JWT_SECRET = 'unit-only-jwt';
  process.env.JWT_REFRESH_SECRET = 'unit-only-refresh';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27199/unit';
  process.env.READINESS_TOKEN = 'r'.repeat(40);
  const req = { id: 'drain-request', get: () => operator ? process.env.READINESS_TOKEN : undefined };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  try {
    await readiness(req, res);
    expect(res.status).toHaveBeenLastCalledWith(200);
    lifecycle.markDraining();
    await readiness(req, res);
    expect(res.status).toHaveBeenLastCalledWith(503);
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ success: false, status: 'draining' }));
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
