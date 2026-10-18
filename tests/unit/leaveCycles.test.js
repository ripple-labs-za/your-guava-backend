const {
  cycleWindow,
  cycleTotal,
  addMonthsUtc,
  LEAVE_CYCLE_RULES,
} = require('../../src/services/workforce/leaveCycles');

const d = (key) => new Date(`${key}T00:00:00.000Z`);
const key = (date) => date.toISOString().slice(0, 10);
const span = (window) => [window.index, key(window.start), key(window.end)];

describe('BCEA leave cycles (D-014)', () => {
  it('starts each annual cycle on the employment anniversary', () => {
    expect(span(cycleWindow('annual', d('2025-01-06'), d('2026-01-05')))).toEqual([0, '2025-01-06', '2026-01-05']);
    expect(span(cycleWindow('annual', d('2025-01-06'), d('2026-01-06')))).toEqual([1, '2026-01-06', '2027-01-05']);
  });

  it('runs sick leave over a 36-month cycle and family leave over the annual cycle', () => {
    expect(span(cycleWindow('sick', d('2025-01-06'), d('2027-12-31')))).toEqual([0, '2025-01-06', '2028-01-05']);
    expect(span(cycleWindow('sick', d('2025-01-06'), d('2028-01-06')))).toEqual([1, '2028-01-06', '2031-01-05']);
    expect(span(cycleWindow('family', d('2025-01-06'), d('2026-02-01')))).toEqual([1, '2026-01-06', '2027-01-05']);
  });

  it('keeps a 29 February start on the last day of February in other years', () => {
    expect(key(addMonthsUtc(d('2024-02-29'), 12))).toBe('2025-02-28');
    expect(span(cycleWindow('annual', d('2024-02-29'), d('2025-03-01')))).toEqual([1, '2025-02-28', '2026-02-27']);
  });

  it('puts a date before the recorded start date in the first cycle, with no lower bound', () => {
    const window = cycleWindow('annual', d('2026-05-04'), d('2026-04-13'));
    expect(span(window)).toEqual([0, '2026-05-04', '2027-05-03']);
    expect(window.countsFrom).toBeNull();
  });

  it('has no cycle for unpaid leave, unknown types or prototype keys', () => {
    expect(cycleWindow('unpaid', d('2025-01-06'), d('2026-01-06'))).toBeNull();
    expect(cycleWindow('constructor', d('2025-01-06'), d('2026-01-06'))).toBeNull();
    expect(cycleWindow('__proto__', d('2025-01-06'), d('2026-01-06'))).toBeNull();
  });

  it("uses the owner's latest adjustment for that cycle and the default for every other cycle", () => {
    const balance = {
      annual: { total: 15 },
      adjustments: [
        { type: 'annual', cycleStart: d('2025-01-06'), total: 10, at: new Date('2025-02-01T08:00:00Z') },
        { type: 'annual', cycleStart: d('2025-01-06'), total: 7.5, at: new Date('2025-03-01T08:00:00Z') },
        { type: 'sick', cycleStart: d('2025-01-06'), total: 20, at: new Date('2025-03-02T08:00:00Z') },
      ],
    };
    expect(cycleTotal(balance, 'annual', d('2025-01-06'))).toBe(7.5);
    expect(cycleTotal(balance, 'annual', d('2026-01-06'))).toBe(15);
    expect(cycleTotal(balance, 'family', d('2025-01-06'))).toBe(3);
  });

  it('matches the BCEA defaults for a five-day week', () => {
    expect(LEAVE_CYCLE_RULES).toEqual({
      annual: { months: 12, defaultTotal: 15 },
      sick: { months: 36, defaultTotal: 30 },
      family: { months: 12, defaultTotal: 3 },
    });
  });
});
