const fs = require('fs');
const path = require('path');
const { generateDemoSales } = require('../../scripts/gen-demo-sales');

const YOCO_HEADER = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'test-transactions.csv'), 'utf8').split(/\r?\n/)[0];

describe('demo sales generator', () => {
  it('is deterministic for the same end date and length', () => {
    expect(generateDemoSales({ end: '2026-09-21' })).toBe(generateDemoSales({ end: '2026-09-21' }));
  });

  it('writes a Yoco export of approved sales covering ten weeks that end on the end date', () => {
    const lines = generateDemoSales({ end: '2026-09-21', weeks: 10 }).trim().split(/\r?\n/);
    expect(lines[0]).toBe(YOCO_HEADER);
    const rows = lines.slice(1).map((line) => line.split(','));
    const dates = [...new Set(rows.map((row) => row[1]))].sort();
    expect(dates).toHaveLength(71);
    expect(dates[0]).toBe('2026/07/13');
    expect(dates.at(-1)).toBe('2026/09/21');
    expect(rows.every((row) => row[3] === 'Approved')).toBe(true);
    expect(rows.length).toBeGreaterThan(71 * 40);
  });

  it('refuses an end date it cannot read', () => {
    expect(() => generateDemoSales({ end: '21/09/2026' })).toThrow(/YYYY-MM-DD/);
  });
});
