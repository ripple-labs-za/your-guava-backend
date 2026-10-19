const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(ROOT, file));

// Every name production startup demands, read from validateEnv's own messages, not from a copy of them.
const productionRequiredNames = () => {
  const validateEnv = require('../../src/config/validateEnv');
  const names = new Set();
  const collect = (env) => {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    try {
      validateEnv();
    } catch (error) {
      for (const line of error.message.split('\n')) {
        const match = line.match(/^\s*-\s*([A-Z][A-Z0-9_]+)/);
        if (match) names.add(match[1]);
      }
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  };
  collect({ NODE_ENV: 'production' });
  collect({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'paystack' });
  return [...names].sort();
};

// The readiness check names, read from health.controller.js: keys of the checks object literal and checks.<name> assignments.
const readinessCheckNames = () => {
  const source = read('src/controllers/health.controller.js');
  const names = new Set();
  const literal = source.match(/const checks = \{([\s\S]*?)\n\s{2}\};/);
  if (literal) for (const m of literal[1].matchAll(/^\s{4}(\w+):/gm)) names.add(m[1]);
  for (const m of source.matchAll(/checks\.(\w+)\s*=/g)) names.add(m[1]);
  return [...names].sort();
};

describe('docs/launch-checklist.md matches the code', () => {
  const checklist = read('docs/launch-checklist.md');

  it('says which commit it was verified against', () => {
    expect(checklist).toMatch(/^Verified against: `[0-9a-f]{7,40}`/m);
  });

  it('names every variable production startup requires', () => {
    const names = productionRequiredNames();
    expect(names.length).toBeGreaterThanOrEqual(12);
    expect(names.filter((name) => !checklist.includes(`\`${name}`))).toEqual([]);
  });

  it('tells operators to use Paystack with a live key, and keeps OneGate as the dormant alternative only', () => {
    expect(checklist).toContain('`PAYMENT_PROVIDER=paystack`');
    expect(checklist).toMatch(/`PAYSTACK_SECRET_KEY`[^\n]*sk_live_/);
    const beforeDormant = checklist.split('## Dormant alternative: OneGate')[0];
    expect(beforeDormant).not.toContain('PAYMENT_PROVIDER=onegate');
  });

  it('lists every explicit gate production enforces, including the workforce gate', () => {
    for (const gate of [
      'YOCO_INTEGRATION_ENABLED=false', 'ACCOUNTING_INTEGRATIONS_ENABLED=false', 'BILLING_MOCK_ENABLED=false', 'WORKFORCE_ENABLED=false',
    ]) expect(checklist).toContain(`\`${gate}\``);
    // BE-12-T01's test switches that validateEnv refuses; originChecksEnabled exists only if BE-02-T06 landed.
    const flags = require('../../src/config/flags');
    const switches = [
      ['rateLimitsEnabled', 'RATE_LIMITS_ENABLED'],
      ['backgroundJobsInline', 'BACKGROUND_JOBS_INLINE'],
      ['originChecksEnabled', 'ORIGIN_CHECKS_ENABLED'],
    ].filter(([fn]) => typeof flags[fn] === 'function').map(([, name]) => name);
    expect(switches.length).toBeGreaterThanOrEqual(2);
    expect(switches.filter((name) => !checklist.includes(`\`${name}\``))).toEqual([]);
  });

  it('describes every readiness check the probe reports', () => {
    const names = readinessCheckNames();
    expect(names.length).toBeGreaterThanOrEqual(5);
    const readiness = checklist.split('## Readiness')[1] || '';
    expect(names.filter((name) => !readiness.includes(`\`${name}\``))).toEqual([]);
  });

  it('explains the migration runner, its ledger and its commands', () => {
    expect(exists('src/migrations/runner.js')).toBe(true);
    expect(checklist).toContain('node src/migrations/runner.js');
    expect(checklist).toContain('node src/migrations/runner.js --apply');
    expect(checklist).toMatch(/`migrations` collection/);
  });

  it('states the supported upload formats and the .xls guidance (D-002)', () => {
    expect(checklist).toMatch(/`\.csv`/);
    expect(checklist).toMatch(/`\.xlsx`/);
    expect(checklist).toContain('CSV UTF-8 (Comma delimited)');
  });

  it('keeps the single-instance section BE-10-T01 wrote', () => {
    expect(checklist).toContain('## Single instance (D-005)');
  });

  it('names every one-line command the CI workflow runs, and no gate as still pending (BE-12-T04)', () => {
    // A `run: |` block is a shell script (the image job's replica set and container), described by job instead.
    const commands = [...read('.github/workflows/ci.yml').replace(/\r\n/g, '\n').matchAll(/^\s*run: (?!\|)(.+)$/gm)].map((m) => m[1].split(' || ')[0].trim());
    expect(commands.length).toBeGreaterThanOrEqual(6);
    expect(commands.filter((command) => !checklist.includes(`\`${command}\``))).toEqual([]);
    expect(checklist).toMatch(/CI job `image`/);
    expect(checklist).not.toMatch(/pending BE-12-T04/);
  });
});

describe('docs/integrations.md matches the code', () => {
  const doc = read('docs/integrations.md');

  it('says which commit it was verified against', () => {
    expect(doc).toMatch(/^Verified against: `[0-9a-f]{7,40}`/m);
  });

  it('lists exactly the integration routes the router defines', () => {
    const router = require('../../src/routes/integrations.routes');
    const routes = router.stack.filter((layer) => layer.route).flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => `| ${method.toUpperCase()} | \`/api/integrations${layer.route.path === '/' ? '' : layer.route.path}\``));
    expect(routes.filter((row) => !doc.includes(row))).toEqual([]);
  });

  it('describes sync as a 501 while every provider posting is a stub', async () => {
    const results = await Promise.all(['xero', 'quickbooks', 'sage']
      .map((name) => require(`../../src/services/integrations/${name}.service`).pushSalesSummary({})));
    expect(results.map((result) => result.statusCode)).toEqual([501, 501, 501]);
    const syncRow = doc.split('\n').find((line) => line.includes('`/api/integrations/:provider/sync`'));
    expect(syncRow).toMatch(/501/);
    expect(doc).not.toMatch(/Pushes last-7-days/);
  });

  it('claims automatic token refresh only if the controller refreshes tokens', () => {
    const codeRefreshes = /await refreshIntegrationAccessToken\(/.test(read('src/controllers/integrations.controller.js'))
      && /service\.refreshAccessToken\(/.test(read('src/services/integrations/tokens.js'));
    const docClaims = /refresh(ed|es)? (is handled )?automatically/i.test(doc);
    expect({ codeRefreshes, docClaims }).toEqual({ codeRefreshes, docClaims: codeRefreshes });
  });
});

describe('README.md', () => {
  const readme = exists('README.md') ? read('README.md') : '';

  it('exists, says which commit it was verified against, and names the stack it needs', () => {
    expect(readme).toMatch(/^Verified against: `[0-9a-f]{7,40}`/m);
    for (const text of ['/api/ready', 'node src/seed.js', 'node scripts/gen-demo-sales.js', 'docker compose up -d mongo', 'node scripts/dev-mongo.js']) {
      expect(readme).toContain(text);
    }
  });

  it('only runs scripts that exist', () => {
    const referenced = [...readme.matchAll(/node ((?:src|scripts)\/[\w./-]+\.m?js)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    expect([...new Set(referenced)].filter((file) => !exists(file))).toEqual([]);
  });

  it('describes the CI gates as they run, not as pending (BE-12-T04)', () => {
    for (const command of [
      'node node_modules/jest/bin/jest.js --runInBand --coverage',
      'node scripts/static-checks.mjs --coverage-summary coverage/coverage-summary.json',
      'npm audit --omit=dev --audit-level=high',
      'git diff --check HEAD^ HEAD',
    ]) expect(readme).toContain(`\`${command}\``);
    expect(readme).toMatch(/`image` job/);
    expect(readme).not.toMatch(/pending BE-12-T04|CI runs `npm test/);
  });

  it('uses the same local ports as .env.example, and a CLIENT_URL the portal actually serves', () => {
    const example = read('.env.example');
    const value = (name) => (example.match(new RegExp(`^${name}=(.*)$`, 'm')) || [])[1];
    expect(value('CLIENT_URL')).toBe('http://localhost:5175');
    expect(readme).toContain(`PORT=${value('PORT')}`);
    expect(readme).toContain(`CLIENT_URL=${value('CLIENT_URL')}`);
  });
});
