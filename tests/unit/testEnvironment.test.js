const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const listJs = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
const readSrc = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');

// Opening a request to a blocked host must throw before a socket exists. If it does not
// (before this card), close whatever was opened so the red run cannot crash the worker.
const expectBlocked = (open) => {
  let handle;
  try {
    expect(() => { handle = open(); }).toThrow(/NETWORK_IN_TEST/);
  } finally {
    if (handle) {
      handle.on('error', () => {});
      handle.destroy();
    }
  }
};

describe('hermetic test environment', () => {
  it('clears SDK, feature-model and migration settings inherited from the shell', () => {
    const { HERMETIC_ENV_NAMES } = require('../env');
    for (const name of [
      'AI_MODEL_CHAT', 'AI_MODEL_COLUMN_MAPPING', 'AI_MODEL_INSIGHTS', 'AI_MODEL_MENU_REVIEW',
      'ANTHROPIC_BASE_URL', 'MIGRATION_STARTUP_TIMEOUT_MS',
    ]) {
      expect(HERMETIC_ENV_NAMES).toContain(name);
      expect(process.env[name]).toBeUndefined();
    }
  });

  it('pins the process timezone to the production zone (or GUAVA_TEST_TZ)', () => {
    const expected = process.env.GUAVA_TEST_TZ || 'Africa/Johannesburg';
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(expected);
  });

  it('never reads a developer .env when the app is imported', () => {
    expect(readSrc('app.js')).not.toMatch(/require\(\s*['"]dotenv['"]\s*\)/);
  });

  it('gives every external credential an explicit test value', () => {
    expect(process.env.ANTHROPIC_API_KEY).toBe('');
    expect(process.env.ESKOMSEPUSH_API_KEY).toBe('');
    expect(process.env.WEATHER_API_KEY).toBe('');
    expect(process.env.RESEND_API_KEY).toBeUndefined();
    expect(process.env.PAYMENT_PROVIDER).toBeUndefined();
    expect(process.env.API_PUBLIC_URL).toBeUndefined();
    expect(process.env.YOCO_INTEGRATION_ENABLED).toBeUndefined();
    expect(process.env.RATE_LIMITS_ENABLED).toBe('false');
  });

  it('lists every environment variable src reads, so none can leak in from a shell', () => {
    const { HERMETIC_ENV_NAMES } = require('../env');
    const names = new Set();
    for (const file of listJs(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
      for (const match of source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) names.add(match[1]);
    }
    const covered = new Set([...HERMETIC_ENV_NAMES, 'NODE_ENV', 'TZ']);
    expect([...names].filter((name) => !covered.has(name)).sort()).toEqual([]);
  });

  it('has no NODE_ENV === test branch and no test-double branch left in src', () => {
    // The same pattern BE-12-T04's static check `nodeEnvTestBranches` uses.
    const testBranch = /(NODE_ENV|nodeEnv\(\))\s*[!=]==?\s*['"]test['"]|['"]test['"]\s*[!=]==?|isTestEnvironment|JEST_WORKER_ID/;
    const offenders = listJs(SRC)
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return testBranch.test(source) || source.includes('test-double');
      })
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(offenders).toEqual([]);
  });
});

describe('outbound network in tests', () => {
  afterEach(() => globalThis.__guavaNetworkGuard?.clear());

  it('outbound: throws NETWORK_IN_TEST for https.request to a public host', () => {
    expectBlocked(() => https.request('https://guard-probe.invalid/'));
  });

  it('outbound: throws NETWORK_IN_TEST for http.get with an options object', () => {
    expectBlocked(() => http.get({ host: 'guard-probe.invalid', port: 80, path: '/' }));
  });

  it('outbound: rejects global fetch to a public host', async () => {
    await expect(fetch('https://guard-probe.invalid/')).rejects.toThrow(/NETWORK_IN_TEST/);
  });

  it('outbound: still allows loopback, which supertest and local fakes use', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
