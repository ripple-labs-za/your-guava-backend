const logger = require('../../src/utils/logger');
const { outboundPolicy, OUTBOUND_SERVICES } = require('../../src/utils/http');

const keys = ['OUTBOUND_CONNECT_TIMEOUT_MS', ...Object.keys(OUTBOUND_SERVICES).map(
  (service) => `OUTBOUND_${service.toUpperCase()}_TIMEOUT_MS`
)];
let saved;
let warn;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  jest.restoreAllMocks();
});

it.each(['30s', '1e5', '10_000', '-1', '1.5', ' 100', '100 ', ''])('uses defaults and warns for malformed timeout %j', (raw) => {
  process.env.OUTBOUND_CONNECT_TIMEOUT_MS = raw;
  process.env.OUTBOUND_YOCO_TIMEOUT_MS = raw;
  expect(outboundPolicy('yoco')).toMatchObject({ connectTimeoutMs: 5000, totalTimeoutMs: 20000 });
  expect(warn).toHaveBeenCalledWith('outbound_timeout_config_invalid', {
    variable: 'OUTBOUND_CONNECT_TIMEOUT_MS', defaultTimeoutMs: 5000,
  });
  expect(warn).toHaveBeenCalledWith('outbound_timeout_config_invalid', {
    variable: 'OUTBOUND_YOCO_TIMEOUT_MS', defaultTimeoutMs: 20000,
  });
});

it.each(Object.entries(OUTBOUND_SERVICES))('uses strict parsing for %s too', (service, defaults) => {
  process.env[`OUTBOUND_${service.toUpperCase()}_TIMEOUT_MS`] = '30s';
  expect(outboundPolicy(service).totalTimeoutMs).toBe(defaults.totalTimeoutMs);
  expect(warn).toHaveBeenCalled();
});

it('checks unused provider knobs at module startup and warns only once per invalid setting', () => {
  process.env.OUTBOUND_WEATHER_TIMEOUT_MS = '10_000';
  jest.isolateModules(() => {
    const isolatedLogger = require('../../src/utils/logger');
    const startupWarn = jest.spyOn(isolatedLogger, 'warn').mockImplementation(() => {});
    const { outboundPolicy: policy } = require('../../src/utils/http');
    expect(startupWarn).toHaveBeenCalledWith('outbound_timeout_config_invalid', {
      variable: 'OUTBOUND_WEATHER_TIMEOUT_MS', defaultTimeoutMs: 8000,
    });
    policy('weather');
    policy('weather');
    expect(startupWarn).toHaveBeenCalledTimes(1);
  });
});

it('still bounds valid whole decimal overrides and does not warn when absent', () => {
  expect(outboundPolicy('yoco').totalTimeoutMs).toBe(20000);
  process.env.OUTBOUND_CONNECT_TIMEOUT_MS = '00020';
  process.env.OUTBOUND_YOCO_TIMEOUT_MS = '0';
  expect(outboundPolicy('yoco')).toMatchObject({ connectTimeoutMs: 20, totalTimeoutMs: 50 });
  process.env.OUTBOUND_YOCO_TIMEOUT_MS = '99999999999999999999999999999999';
  expect(outboundPolicy('yoco').totalTimeoutMs).toBe(120000);
  expect(warn).not.toHaveBeenCalled();
});
