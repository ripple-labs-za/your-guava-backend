const {
  shiftSpan,
  splitWeekHours,
  weekStartFor,
  localWeekBounds,
} = require('../../src/services/workforce/shiftHours');

const d = (key) => new Date(`${key}T00:00:00.000Z`);
const key = (date) => date.toISOString().slice(0, 10);

describe('shift hours (BE-08-T04)', () => {
  it('reads an end time before the start time as the next day', () => {
    expect(shiftSpan('22:00', '02:00')).toEqual({ start: 1320, end: 1560, endsNextDay: true, hours: 4 });
    expect(shiftSpan('16:00', '00:00')).toMatchObject({ endsNextDay: true, hours: 8 });
    expect(shiftSpan('07:00', '15:30')).toMatchObject({ endsNextDay: false, hours: 8.5 });
  });

  it('refuses equal or malformed times', () => {
    expect(shiftSpan('07:00', '07:00')).toBeNull();
    expect(shiftSpan('24:00', '02:00')).toBeNull();
    expect(shiftSpan({ $gt: '' }, '02:00')).toBeNull();
  });

  it('splits a week in the order it is worked, not the order it was entered', () => {
    const shift = (date) => ({ date: d(date), startTime: '06:00', hoursWorked: 10 });
    const rows = splitWeekHours([
      shift('2026-04-10'), shift('2026-04-06'), shift('2026-04-07'), shift('2026-04-08'), shift('2026-04-09'),
    ]);
    expect(rows.map((row) => [key(row.shift.date), row.regularHours, row.overtimeHours, row.type])).toEqual([
      ['2026-04-06', 10, 0, 'regular'],
      ['2026-04-07', 10, 0, 'regular'],
      ['2026-04-08', 10, 0, 'regular'],
      ['2026-04-09', 10, 0, 'regular'],
      ['2026-04-10', 5, 5, 'overtime'],
    ]);
  });

  it('puts a Sunday in the week that began the Monday before', () => {
    expect(key(weekStartFor(d('2026-09-20')))).toBe('2026-09-14');
    expect(key(weekStartFor(d('2026-09-21')))).toBe('2026-09-21');
  });

  it("takes this week from the cafe's calendar, not the server's", () => {
    const halfPastMidnightMondayInJohannesburg = new Date('2026-09-20T22:30:00Z');
    expect(key(localWeekBounds(halfPastMidnightMondayInJohannesburg, 'Africa/Johannesburg').monday)).toBe('2026-09-21');
    expect(key(localWeekBounds(halfPastMidnightMondayInJohannesburg, 'UTC').monday)).toBe('2026-09-14');
  });
});
