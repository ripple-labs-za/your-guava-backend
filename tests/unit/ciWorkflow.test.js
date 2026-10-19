// BE-12-T04: the backend CI workflow and the coverage gate, read as text (no YAML parser: no new dependency), so each
// assertion names a line a reviewer can find.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// LF throughout, so a CRLF checkout (core.autocrlf on Windows) reads the same: `$` and `\n` in the patterns below mean end of line.
const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const lines = workflow.split(/\r?\n/);
const indexOf = (pattern) => lines.findIndex((line) => pattern.test(line));

describe('backend CI workflow', () => {
  it('pins every action to a full commit SHA, with the tag in a comment', () => {
    const uses = lines.filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const line of uses) expect(line).toMatch(/uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+#\s+v\d+/);
  });

  it('runs the tests with coverage, then the static checks, before any audit', () => {
    const tests = indexOf(/run: node node_modules\/jest\/bin\/jest\.js --runInBand --coverage$/);
    const checks = indexOf(/run: node scripts\/static-checks\.mjs --coverage-summary coverage\/coverage-summary\.json$/);
    const audit = indexOf(/run: npm audit --omit=dev --audit-level=high$/);
    expect(tests).toBeGreaterThan(-1);
    expect(checks).toBeGreaterThan(tests);
    expect(audit).toBeGreaterThan(checks);
  });

  it('never gates on bare npm audit, and reports dev-dependency advisories without failing', () => {
    const audits = lines.filter((line) => /npm audit/.test(line));
    expect(audits).toHaveLength(2);
    for (const line of audits) expect(line).toMatch(/--omit=dev --audit-level=high$|\|\| echo "::warning::/);
  });

  it('never lets a gating step pass by skipping or swallowing its failure', () => {
    // The dev-dependency audit reports without failing through `|| echo "::warning::`; nothing else may.
    // Also as a step's first key (`- if: …`).
    expect(lines.filter((line) => /^\s*(-\s+)?(continue-on-error|if):/.test(line))).toEqual([]);
  });

  it('checks whitespace over the pushed commit or the pull request, not an empty working tree', () => {
    // Bare `git diff --check` compares the working tree with the index, which is always clean on a runner. With two commits
    // fetched, HEAD^ is the parent on a push and the base branch's tip on a pull request's merge commit.
    expect(workflow).toMatch(/run: git diff --check HEAD\^ HEAD$/m);
    expect(workflow).not.toMatch(/run: git diff --check$/m);
    const verify = workflow.split(/^\s{2}image:/m)[0];
    expect(verify).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+fetch-depth: 2\n/);
  });

  it('cancels superseded runs on pull requests only, so every main commit gets a verdict', () => {
    expect(workflow).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });

  it('builds the production image and waits for its own HEALTHCHECK', () => {
    expect(workflow).toMatch(/^\s{2}image:\s*$/m);
    expect(workflow).toMatch(/docker build --pull -t your-guava-api:ci \./);
    expect(workflow).toMatch(/\{\{\.State\.Health\.Status\}\}/);
    expect(workflow).toMatch(/docker exec api id -u/);
  });

  it('gives the image what validateEnv requires to boot outside tests', () => {
    // CLIENT_URL (BE-02-T06) and, with uploads stored locally, a 32+ character DOWNLOAD_SIGNING_SECRET of its own; without
    // either the container stops at boot and the HEALTHCHECK never turns healthy.
    for (const name of ['CLIENT_URL', 'MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'TOKEN_ENCRYPTION_KEY', 'DOWNLOAD_SIGNING_SECRET']) {
      expect(workflow).toMatch(new RegExp(`-e ${name}=`));
    }
    expect(workflow).toMatch(/-e DOWNLOAD_SIGNING_SECRET="\$\(openssl rand -hex 32\)"/);
  });
});

describe('jest coverage configuration', () => {
  it('gates totals at 85% lines and 75% branches over every src file, only when --coverage is passed', () => {
    const config = require(path.join(ROOT, 'jest.config.js'));
    expect(config.collectCoverage).toBeUndefined();
    expect(config.collectCoverageFrom).toEqual(['src/**/*.js']);
    expect(config.coverageProvider).toBe('v8');
    expect(config.coverageReporters).toEqual(expect.arrayContaining(['json-summary']));
    expect(config.coverageThreshold).toEqual({ global: { lines: 85, branches: 75 } });
  });
});
