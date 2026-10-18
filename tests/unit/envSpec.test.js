const fs = require('fs');
const path = require('path');
const { NUMERIC_ENV, KNOWN_ENV } = require('../../src/config/envSpec');
const { maxObjectBytes } = require('../../src/services/r2.service');
const { yocoSyncTotalMs } = require('../../src/services/yoco.service');
const { parserLimits } = require('../../src/services/parser/limits');

const SRC_ROOT = path.resolve(__dirname, '../../src');
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
const collect = (pattern) => {
  const names = new Set();
  for (const file of walk(SRC_ROOT)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern)) names.add(match[1]);
  }
  return [...names].sort();
};

  describe('environment catalogue', () => {
    it.each([
      ['UPLOAD_MAX_BYTES', maxObjectBytes],
      ['YOCO_SYNC_TOTAL_MS', yocoSyncTotalMs],
      ['UPLOAD_MAX_ROWS', () => parserLimits().maxRows],
      ['UPLOAD_MAX_COLUMNS', () => parserLimits().maxColumns],
      ['UPLOAD_MAX_CELL_CHARS', () => parserLimits().maxCellChars],
    ])('matches the real %s getter at both catalogue boundaries', (name, read) => {
      const previous = process.env[name];
      const { min, max } = NUMERIC_ENV[name];
      try {
        process.env[name] = String(min - 1);
        expect(read()).toBe(min);
        process.env[name] = String(max + 1);
        expect(read()).toBe(max);
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    });

    it('classifies dynamically selected outbound deadlines and feature model overrides', () => {
      const { OUTBOUND_SERVICES } = require('../../src/utils/http');
      const { FEATURES } = require('../../src/config/ai');
      const timeoutNames = Object.keys(OUTBOUND_SERVICES).map((name) => `OUTBOUND_${name.toUpperCase()}_TIMEOUT_MS`);
      for (const name of timeoutNames) expect(NUMERIC_ENV[name]).toEqual({ min: 50, max: 120000 });
      for (const { env } of Object.values(FEATURES)) expect(KNOWN_ENV.has(env)).toBe(true);
    });
  it('classifies every environment variable src reads, so none skips validation', () => {
    const unclassified = collect(/process\.env\.([A-Z][A-Z0-9_]*)/g).filter((name) => !KNOWN_ENV.has(name));
    expect(unclassified).toEqual([]);
  });

  it('has a range for every setting src parses as a number', () => {
    const numeric = collect(
      /(?:boundedInteger|boundedPolicyInteger|clampInteger|parseInt|Number)\(\s*process\.env\.([A-Z][A-Z0-9_]*)/g
    );
    expect(numeric.length).toBeGreaterThan(20);
    expect(numeric.filter((name) => !(name in NUMERIC_ENV))).toEqual([]);
  });
});
