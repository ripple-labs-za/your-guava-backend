const { buildSummaryStats } = require('../../src/services/ai/prompts');
const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: dayOfWeek !== 0 }));
const row = (day) => ({ date: new Date(`${day}T10:00:00+02:00`), total: 100, items: [] });

it('includes a zero-sale open Tuesday between Monday and Wednesday in the AI daily average', () => {
  const stats = buildSummaryStats([row('2026-03-02'), row('2026-03-04')], 'Africa/Johannesburg', hours);
  expect(stats.avgDailyRevenue).toBe(66.67);
  expect(stats.dayOfWeekAverages.find((entry) => entry.day === 'Tuesday').avgRevenue).toBe(0);
});

it('includes missing open occurrences in weekday averages', () => {
  const stats = buildSummaryStats([row('2026-03-02'), row('2026-03-11')], 'Africa/Johannesburg', hours);
  expect(stats.dayOfWeekAverages.find((entry) => entry.day === 'Monday').avgRevenue).toBe(50);
  expect(stats.dayOfWeekAverages.find((entry) => entry.day === 'Wednesday').avgRevenue).toBe(50);
});
