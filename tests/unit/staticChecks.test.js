// BE-12-T04: scripts/static-checks.mjs against throwaway trees. Each check must fail on its own defect and pass a clean tree.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'static-checks.mjs');
const run = (root, extra = []) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], { encoding: 'utf8' });
const roots = [];
const tree = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
};
afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const PACKAGE = JSON.stringify({ dependencies: { express: '5' }, devDependencies: { jest: '30' } });
const CLEAN = {
  'package.json': PACKAGE,
  'src/app.js': "const express = require('express');\nconst path = require('node:path');\nmodule.exports = express.Router({ sep: path.sep });\n",
  // Look-alikes the guards must leave alone: an asymmetric matcher, a plain ternary and a nested matcher.
  'tests/app.test.js': "it('adds', () => {\n  const a = { b: 1 };\n  const n = a?.b ? 1 : 2;\n"
    + "  expect({ n }).toEqual({ n: expect.any(Number) });\n  expect([a]).toEqual([expect.objectContaining({ b: 1 })]);\n});\n",
  'docs/note.md': 'Café – naïve “quotes” are UTF-8, not control bytes.\n',
};

describe('scripts/static-checks.mjs', () => {
  it('passes a clean tree, including UTF-8 text and look-alike matchers', () => {
    const result = run(tree(CLEAN));
    expect(result.stdout).toMatch(/PASS syntax/);
    expect(result.stdout).toMatch(/PASS controlCharacters/);
    expect(result.stdout).toMatch(/PASS testGuards/);
    expect(result.stdout).toContain('static checks: all passed');
    expect(result.status).toBe(0);
  });

  it.each([
    ['syntax', 'src/broken.js', 'const = ;\n'],
    ['controlCharacters', 'src/control.js', `module.exports = '${String.fromCharCode(8)}';\n`],
    ['controlCharacters', 'docs/escape.md', `colour ${String.fromCharCode(0x1b)}[31m red\n`],
    ['nodeEnvTestBranches', 'src/branch.js', "module.exports = process.env.NODE_ENV === 'test';\n"],
    ['nodeEnvTestBranches', 'src/posture.js', "const nodeEnv = () => process.env.NODE_ENV;\nmodule.exports = nodeEnv() === 'test';\n"],
    ['productionDependencies', 'src/dev.js', "const jest = require('jest');\nmodule.exports = jest;\n"],
    ['productionDependencies', 'src/undeclared.js', "const left = require('left-pad');\nmodule.exports = left;\n"],
    ['unusedRequires', 'src/unused.js', "const fs = require('fs');\nmodule.exports = 1;\n"],
    ['unusedRequires', 'src/destructured.js', "const {\n  join,\n  resolve,\n} = require('path');\nmodule.exports = join;\n"],
    ['focusedTests', 'tests/focused.test.js', "it.only('x', () => {\n  expect(1).toBe(1);\n});\n"], // static-checks: allow planted fixture
    ['focusedTests', 'tests/only-each.test.js', "it.only.each([1])('x %i', (v) => {\n  expect(v).toBe(1);\n});\n"], // static-checks: allow planted fixture
    ['focusedTests', 'tests/describe-only-each.test.js', "describe.only.each([1])('x %i', (v) => {\n  it('y', () => {\n    expect(v).toBe(1);\n  });\n});\n"], // static-checks: allow planted fixture
    ['focusedTests', 'tests/concurrent-only.test.js', "test.concurrent.only('x', async () => {\n  expect(1).toBe(1);\n});\n"], // static-checks: allow planted fixture
    ['unusedRequires', 'src/comment-only.js', "const fs = require('fs');\n// fs.readFileSync is not called here\n/* nor fs.writeFileSync */\nmodule.exports = 1;\n"],
    ['testGuards', 'tests/guarded.test.js', "it('x', () => {\n  const v = 1;\n  if (v > 0) {\n    expect(v).toBe(1);\n  }\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/elseif.test.js', "it('x', () => {\n  const v = 1;\n  if (v > 1) {\n    v;\n  } else if (v > 0) {\n    expect(v).toBe(1);\n  }\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/early.test.js', "it('y', () => {\n  if (!process.env.X) return;\n  expect(1).toBe(1);\n});\n"],
    ['testGuards', 'tests/oneline-if.test.js', "it('x', () => {\n  const v = 1;\n  if (v) expect(v).toBe(1);\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/oneline-else.test.js', "it('x', () => {\n  const v = 1;\n  if (v) {\n    v;\n  } else expect(v).toBe(1);\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/oneline-and.test.js', "it('x', () => {\n  const v = 1;\n  v && expect(v).toBe(1);\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/oneline-or.test.js', "it('x', () => {\n  const v = 0;\n  v || expect(v).toBe(0);\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/else-block.test.js', "it('x', () => {\n  const v = 1;\n  if (v > 1) {\n    v;\n  } else {\n    expect(v).toBe(1);\n  }\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/same-line-else.test.js', "it('x', () => {\n  const v = 1;\n  if (v > 1) {\n    v;\n  } else { expect(v).toBe(1); }\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/same-line-block.test.js', "it('x', () => {\n  const v = 1;\n  if (v) { expect(v).toBe(1); }\n});\n"], // static-checks: allow planted fixture
    ['testGuards', 'tests/ternary.test.js', "it('x', () => {\n  const v = 1;\n  v ? expect(v).toBe(1) : null;\n});\n"], // static-checks: allow planted fixture
  ])('fails %s on %s', (check, file, content) => {
    const result = run(tree({ ...CLEAN, [file]: content }), ['--only', check]);
    expect(result.stdout).toContain(`FAIL ${check}`);
    expect(result.stdout).toContain(file);
    expect(result.status).toBe(1);
  });

  it('accepts a marked, deliberate conditional assertion and a marked side-effect require', () => {
    const marked = "it('x', () => {\n  const v = 1;\n  if (v > 0) { // static-checks: allow conditional-expect table row\n    expect(v).toBe(1);\n  }\n"
      + "  if (v) expect(v).toBe(1); // static-checks: allow conditional-expect table row\n});\n";
    const sideEffect = "const model = require('./model'); // static-checks: allow side-effect\nmodule.exports = 1;\n";
    expect(run(tree({ ...CLEAN, 'tests/marked.test.js': marked }), ['--only', 'testGuards']).status).toBe(0);
    expect(run(tree({ ...CLEAN, 'src/register.js': sideEffect }), ['--only', 'unusedRequires']).status).toBe(0);
  });

  it('reads a use after a URL string as a use: only real comments are stripped', () => {
    const source = "const http = require('http');\nmodule.exports = ['https://example.test/a', http.globalAgent, `//${'x'}`, /\\/\\//];\n";
    expect(run(tree({ ...CLEAN, 'src/url.js': source }), ['--only', 'unusedRequires']).status).toBe(0);
  });

  it('leaves a helper that returns early alone outside a test file', () => {
    const helper = "module.exports = (v) => {\n  if (!v) return;\n  return v;\n};\n";
    expect(run(tree({ ...CLEAN, 'tests/helpers/maybe.js': helper }), ['--only', 'testGuards']).status).toBe(0);
  });

  it('enforces the 70% per-file line floor from a Jest json-summary', () => {
    const root = tree(CLEAN);
    const summary = (pct) => JSON.stringify({
      total: { lines: { pct: 90 }, branches: { pct: 80 } },
      [path.join(root, 'src', 'app.js')]: { lines: { pct }, branches: { pct: 100 } },
    });
    fs.writeFileSync(path.join(root, 'summary.json'), summary(69.9));
    const low = run(root, ['--only', 'coverageFloor', '--coverage-summary', path.join(root, 'summary.json')]);
    expect(low.stdout).toMatch(/FAIL coverageFloor[\s\S]*src\/app\.js/);
    expect(low.status).toBe(1);
    fs.writeFileSync(path.join(root, 'summary.json'), summary(70));
    expect(run(root, ['--only', 'coverageFloor', '--coverage-summary', path.join(root, 'summary.json')]).status).toBe(0);
  });

  it('fails the coverage floor when the summary is missing, rather than passing silently', () => {
    const root = tree(CLEAN);
    const result = run(root, ['--only', 'coverageFloor', '--coverage-summary', path.join(root, 'missing.json')]);
    expect(result.stdout).toMatch(/FAIL coverageFloor[\s\S]*coverage summary not found/);
    expect(result.status).toBe(1);
  });

  it('fails the coverage floor when no summary entry is a src file of this tree, rather than checking nothing', () => {
    const root = tree(CLEAN);
    const elsewhere = path.join(os.tmpdir(), 'another-checkout', 'src', 'app.js');
    fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify({
      total: { lines: { pct: 90 }, branches: { pct: 80 } },
      [elsewhere]: { lines: { pct: 10 }, branches: { pct: 10 } },
    }));
    const result = run(root, ['--only', 'coverageFloor', '--coverage-summary', path.join(root, 'summary.json')]);
    expect(result.stdout).toMatch(/FAIL coverageFloor[\s\S]*no src file of this tree/);
    expect(result.status).toBe(1);
  });

  it('refuses an unknown check name', () => {
    expect(run(tree(CLEAN), ['--only', 'eslint']).status).toBe(2);
  });
});
