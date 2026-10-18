const supertest = require('supertest');

// D-003 / D-014: the explicit flag controls every workforce endpoint.
const WORKFORCE_PATHS = ['/api/staff', '/api/shifts', '/api/shifts/week', '/api/leave', '/api/leave/balances'];

const loadAppWith = ({ nodeEnv, flag }) => {
  const saved = { NODE_ENV: process.env.NODE_ENV, WORKFORCE_ENABLED: process.env.WORKFORCE_ENABLED };
  process.env.NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env.WORKFORCE_ENABLED;
  else process.env.WORKFORCE_ENABLED = flag;
  let app;
  try {
    jest.isolateModules(() => { app = require('../../src/app'); });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return app;
};

const expectRoutes = async (app, status, message) => {
  for (const path of WORKFORCE_PATHS) {
    const res = await supertest(app).get(path);
    expect({ path, status: res.status, message: res.body.message }).toEqual({ path, status, message });
  }
};

describe('workforce gate (D-003)', () => {
  it.each(['test', 'development', 'production'])(
    'answers 404 on every workforce route when the flag is unset (NODE_ENV=%s)',
    async (nodeEnv) => {
      await expectRoutes(loadAppWith({ nodeEnv, flag: undefined }), 404, 'Route not found');
    }
  );

  it.each(['false', '1', 'yes'])(
    'answers 404 when WORKFORCE_ENABLED=%s',
    async (flag) => {
      await expectRoutes(loadAppWith({ nodeEnv: 'test', flag }), 404, 'Route not found');
    }
  );

  it.each(['true', 'TRUE', ' true '])(
    'mounts every workforce route when WORKFORCE_ENABLED=%s (auth answers)',
    async (flag) => {
      await expectRoutes(loadAppWith({ nodeEnv: 'test', flag }), 401, 'No token provided');
    }
  );
});
