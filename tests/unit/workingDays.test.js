const { execFileSync } = require('child_process');
const {
  leaveDayBreakdown,
  describeWorkPattern,
  DEFAULT_WORK_DAYS,
} = require('../../src/services/workforce/workingDays');

const d = (key) => new Date(`${key}T00:00:00.000Z`);

describe('leave days on the working pattern (BE-08-T03)', () => {
  it('charges a Monday-to-Friday worker nothing for a weekend', () => {
    expect(leaveDayBreakdown(d('2026-10-03'), d('2026-10-04'), DEFAULT_WORK_DAYS).days).toBe(0);
  });

  it('charges a Friday-to-Sunday worker for Saturday and Sunday', () => {
    expect(leaveDayBreakdown(d('2026-10-03'), d('2026-10-04'), [5, 6, 0])).toEqual({
      days: 2,
      chargedDates: ['2026-10-03', '2026-10-04'],
      holidayDates: [],
    });
  });

  it('charges a Friday-to-Monday absence on the days the person works', () => {
    expect(leaveDayBreakdown(d('2026-10-09'), d('2026-10-12'), [5, 6, 0]).days).toBe(3);
    expect(leaveDayBreakdown(d('2026-10-09'), d('2026-10-12'), DEFAULT_WORK_DAYS).days).toBe(2);
  });

  it("does not charge Christmas Day or New Year's Day inside a leave period", () => {
    const result = leaveDayBreakdown(d('2026-12-21'), d('2027-01-01'), DEFAULT_WORK_DAYS);
    expect(result.days).toBe(8);
    expect(result.holidayDates).toEqual([
      { date: '2026-12-25', name: 'Christmas Day' },
      { date: '2027-01-01', name: "New Year's Day" },
    ]);
  });

  it('does not charge the Monday that a Sunday holiday moves to', () => {
    const result = leaveDayBreakdown(d('2027-12-27'), d('2027-12-31'), DEFAULT_WORK_DAYS);
    expect(result.days).toBe(4);
    expect(result.holidayDates.map((holiday) => holiday.date)).toEqual(['2027-12-27']);
  });

  it('treats a missing or empty pattern as Monday to Friday', () => {
    expect(leaveDayBreakdown(d('2026-10-05'), d('2026-10-11'), undefined).days).toBe(5);
    expect(leaveDayBreakdown(d('2026-10-05'), d('2026-10-11'), []).days).toBe(5);
  });

  it('names a pattern in week order', () => {
    expect(describeWorkPattern([0, 5, 6])).toBe('Fri, Sat, Sun');
    expect(describeWorkPattern(undefined)).toBe('Mon, Tue, Wed, Thu, Fri');
  });

  // The suite runs pinned to SAST (tests/globalSetup.js), where UTC midnight is
  // the same calendar day locally, so a slip from getUTCDay to getDay would pass
  // here. A child process in a negative-offset zone, where UTC midnight is the
  // evening before, counts the same leave the same way or fails (BE-08-T03 review).
  it('counts the same days in a timezone behind UTC', () => {
    const script = `
      const { leaveDayBreakdown } = require(${JSON.stringify(require.resolve('../../src/services/workforce/workingDays'))});
      const d = (key) => new Date(key + 'T00:00:00.000Z');
      console.log(JSON.stringify({
        localDayOfUtcMidnight: d('2026-10-03').getDay(),
        weekend: leaveDayBreakdown(d('2026-10-03'), d('2026-10-04'), [5, 6, 0]),
        friToMon: leaveDayBreakdown(d('2026-10-09'), d('2026-10-12'), [1, 2, 3, 4, 5]).days,
        christmas: leaveDayBreakdown(d('2026-12-21'), d('2027-01-01'), [1, 2, 3, 4, 5]).days,
      }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    });
    const result = JSON.parse(output.trim().split('\n').pop());
    expect(result.localDayOfUtcMidnight).toBe(5); // Saturday 00:00 UTC is Friday evening in New York: the zone took effect
    expect(result.weekend).toEqual({ days: 2, chargedDates: ['2026-10-03', '2026-10-04'], holidayDates: [] });
    expect(result.friToMon).toBe(2);
    expect(result.christmas).toBe(8);
  });
});
