const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.join(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

describe('coverage instrumentation never judges resource budgets', () => {
  it('accounts for every budget marker and refuses tags outside a supported test-name start', () => {
    const { budgetFiles } = require('../../scripts/ci-budget-files.cjs');
    const selected = new Set(budgetFiles(root));
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : file.endsWith('.test.js') ? [file] : [];
    });
    const registration = /^\s*(?:(?:it|test|describe)(?:\.each\([^\r\n]*\))?|\]\))\(\s*['"`]\[budget\] /;
    const tagged = walk(path.join(root, 'tests')).filter((file) => file !== __filename
      && fs.readFileSync(file, 'utf8').includes('[budget]'));
    expect(tagged.length).toBeGreaterThan(0);
    for (const file of tagged) {
      expect({ file, discovered: selected.has(file.replaceAll('\\', '/')) }).toEqual({ file, discovered: true });
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.includes('[budget]'));
      for (const line of lines) {
        expect(line).toMatch(registration);
        expect({ file, markers: line.split('[budget]').length - 1 }).toEqual({ file, markers: 1 });
      }
    }
  });

  it('runs coverage and plain budgets in separate gating jobs', () => {
    expect(workflow).toMatch(/node node_modules\/jest\/bin\/jest\.js --config jest\.coverage\.config\.js --coverage/);
    const budgets = workflow.split(/^  budgets:/m)[1]?.split(/^  \w+:/m)[0];
    expect(budgets).toBeDefined();
    expect(budgets).toMatch(/run: node node_modules\/jest\/bin\/jest\.js --config jest\.budgets\.config\.js --runInBand/);
    expect(budgets).not.toMatch(/--coverage/);
    expect(budgets).toMatch(/timeout-minutes: 30/);
  });

  it('uses complementary name filters so no test disappears or runs in both jobs', () => {
    const coverage = require('../../jest.coverage.config');
    const budgets = require('../../jest.budgets.config');
    for (const name of ['ordinary correctness', '[budget] 10 MB scan', 'suite [budget] parameterized row', 'suite\n[budget] row']) {
      const selected = [coverage, budgets].map((config) => new RegExp(config.testNamePattern).test(name));
      expect(selected.filter(Boolean)).toHaveLength(1);
    }
    expect(new RegExp(coverage.testNamePattern).test('[budget] 10 MB scan')).toBe(false);
    expect(new RegExp(budgets.testNamePattern).test('[budget] 10 MB scan')).toBe(true);
    expect(budgets.collectCoverage).toBe(false);
    expect(coverage.maxWorkers).toBe(4);
  });

  it('loads only tagged files and includes all originally failing budget families', () => {
    const { budgetFiles } = require('../../scripts/ci-budget-files.cjs');
    const files = budgetFiles(root).map((file) => path.relative(root, file).replaceAll('\\', '/'));
    expect(files).toEqual(expect.arrayContaining([
      'tests/unit/parserCsvStructure.test.js', 'tests/security/dos.test.js',
      'tests/unit/menuMatching.test.js', 'tests/integration/xlsxStreamUpload.test.js',
      'tests/integration/uploadDosLimits.test.js', 'tests/integration/menuMatchingBudget.test.js',
    ]));
    expect(files).not.toContain('tests/unit/ciBudgetPartition.test.js');
    expect(files.length).toBeGreaterThan(6);
    expect(new Set(files).size).toBe(files.length);
  });

  it('discovers direct, parameterized and suite tags and refuses an empty budget gate', () => {
    const { budgetFiles } = require('../../scripts/ci-budget-files.cjs');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-budget-partition-'));
    try {
      fs.mkdirSync(path.join(fixture, 'tests'));
      expect(() => budgetFiles(fixture)).toThrow('No [budget] tests found');
      const cases = {
        'direct.test.js': "it('[budget] direct', () => {});",
        'rows.test.js': "it.each([1, 2])('[budget] row %s', () => {});",
        'suite.test.js': "describe('[budget] suite', () => {});",
        'ordinary.test.js': "it('ordinary', () => {});",
      };
      for (const [file, source] of Object.entries(cases)) fs.writeFileSync(path.join(fixture, 'tests', file), source);
      expect(budgetFiles(fixture).map((file) => path.basename(file)).sort()).toEqual(['direct.test.js', 'rows.test.js', 'suite.test.js']);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('retains the total and per-file coverage floors over every source file', () => {
    const coverage = require('../../jest.coverage.config');
    expect(coverage.collectCoverageFrom).toEqual(['src/**/*.js']);
    expect(coverage.coverageThreshold).toEqual({ global: { lines: 85, branches: 75 } });
    expect(workflow).toMatch(/node scripts\/static-checks\.mjs --coverage-summary coverage\/coverage-summary\.json/);
    const checks = fs.readFileSync(path.join(root, 'scripts/static-checks.mjs'), 'utf8');
    expect(checks).toMatch(/const FILE_LINE_FLOOR = 70;/);
  });
});
