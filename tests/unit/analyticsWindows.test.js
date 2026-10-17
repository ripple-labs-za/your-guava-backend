const {
  shiftDay,
  daysInclusive,
  lastCompleteDay,
  trendWindows,
} = require('../../src/services/analytics/windows');

describe('analytics day-key arithmetic', () => {
  it('shifts across month and year ends and counts days inclusively', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2025-12-31', 1)).toBe('2026-01-01');
    expect(daysInclusive('2026-09-16', '2026-09-22')).toBe(7);
    expect(lastCompleteDay({ endDate: '2026-09-22', today: '2026-09-22' })).toBe('2026-09-21');
    expect(lastCompleteDay({ endDate: '2026-01-31', today: '2026-09-22' })).toBe('2026-01-31');
  });
});

describe('trendWindows', () => {
  it('ends the current window at the last complete day when the range reaches today', () => {
    expect(trendWindows({
      startDate: '2026-09-16', endDate: '2026-09-22', today: '2026-09-22',
      firstDataDate: '2026-01-01', lastDataDate: '2026-09-21',
    })).toEqual({
      effective: { startDate: '2026-09-16', endDate: '2026-09-21', days: 6, endReason: 'today_incomplete' },
      comparison: { startDate: '2026-09-10', endDate: '2026-09-15', days: 6 },
      comparable: true,
      reason: null,
    });
  });

  it('ends the current window at the last day with data when uploads are behind', () => {
    const result = trendWindows({
      startDate: '2026-09-16', endDate: '2026-09-22', today: '2026-09-22',
      firstDataDate: '2026-01-01', lastDataDate: '2026-09-19',
    });
    expect(result.effective).toEqual({ startDate: '2026-09-16', endDate: '2026-09-19', days: 4, endReason: 'data_ends' });
    expect(result.comparison).toEqual({ startDate: '2026-09-12', endDate: '2026-09-15', days: 4 });
  });

  it('keeps a range that ended in the past as requested', () => {
    const result = trendWindows({
      startDate: '2026-01-01', endDate: '2026-01-31', today: '2026-09-22',
      firstDataDate: '2025-06-01', lastDataDate: '2026-01-31',
    });
    expect(result.effective).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31', days: 31, endReason: 'requested' });
    expect(result.comparison).toEqual({ startDate: '2025-12-01', endDate: '2025-12-31', days: 31 });
  });

  it('refuses to compare when the cafe has no history covering the comparison window', () => {
    const result = trendWindows({
      startDate: '2026-08-24', endDate: '2026-09-22', today: '2026-09-22',
      firstDataDate: '2026-09-01', lastDataDate: '2026-09-21',
    });
    expect(result.comparable).toBe(false);
    expect(result.reason).toBe('insufficient_history');
    expect(result.comparison).toEqual({ startDate: '2026-07-26', endDate: '2026-08-23', days: 29 });
  });

  it('has nothing to compare when no complete day in the window has data', () => {
    expect(trendWindows({
      startDate: '2026-09-16', endDate: '2026-09-22', today: '2026-09-22',
      firstDataDate: '2026-09-22', lastDataDate: null,
    })).toEqual({ effective: null, comparison: null, comparable: false, reason: 'no_data_in_window' });
  });

  it('has nothing complete when the window is only today', () => {
    expect(trendWindows({
      startDate: '2026-09-22', endDate: '2026-09-22', today: '2026-09-22',
      firstDataDate: '2026-01-01', lastDataDate: null,
    }).reason).toBe('window_not_complete');
  });

  it('clips a past range to its last uploaded day and accepts history exactly on the comparison boundary', () => {
    const input = {
      startDate: '2026-01-01', endDate: '2026-01-31', today: '2026-09-22',
      firstDataDate: '2025-12-12', lastDataDate: '2026-01-20',
    };
    const result = trendWindows(input);
    expect(result.effective).toEqual({ startDate: '2026-01-01', endDate: '2026-01-20', days: 20, endReason: 'data_ends' });
    expect(result.comparison).toEqual({ startDate: '2025-12-12', endDate: '2025-12-31', days: 20 });
    expect(result.comparable).toBe(true);
    expect(trendWindows({ ...input, firstDataDate: '2025-12-13' }).reason).toBe('insufficient_history');
  });
});
