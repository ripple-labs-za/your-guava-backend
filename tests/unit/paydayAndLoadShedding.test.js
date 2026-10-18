jest.mock('axios');

const axios = require('axios');
const { isPayday, getLoadSheddingForDate, clearLoadSheddingCache } = require('../../src/utils/signals');

const day = (y, m, d) => new Date(y, m - 1, d, 12);

describe('payday', () => {
  it('moves a Saturday 25th to the Friday before', () => {
    expect(isPayday(day(2026, 7, 24))).toBe(true);
    expect(isPayday(day(2026, 7, 25))).toBe(false);
  });
  it('moves a 25th that is a public holiday to the business day before', () => {
    expect(isPayday(day(2026, 12, 24))).toBe(true); // Thursday before Christmas Day
    expect(isPayday(day(2026, 12, 25))).toBe(false);
  });
  it('skips public holidays in the month-end walk', () => {
    // 31 March 2029 is a Saturday and 30 March is Good Friday.
    expect(isPayday(day(2029, 3, 29))).toBe(true);
    expect(isPayday(day(2029, 3, 30))).toBe(false);
  });
  it('does not put payday on New Year’s Day', () => {
    expect(isPayday(day(2026, 1, 1))).toBe(false);
    expect(isPayday(day(2026, 6, 1))).toBe(true); // a Monday 1st still counts
  });
  it('keeps a weekday 25th', () => {
    expect(isPayday(day(2026, 8, 25))).toBe(true);
  });
});

describe('load-shedding for the planning horizon', () => {
  const TZ = 'Africa/Johannesburg';
  const NOW = new Date('2026-09-22T06:00:00.000Z'); // 08:00 SAST on Tuesday 22 September
  const original = process.env.ESKOMSEPUSH_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    clearLoadSheddingCache();
    process.env.ESKOMSEPUSH_API_KEY = 'test-eskom-key';
    axios.get.mockResolvedValue({
      data: {
        status: {
          eskom: {
            stage: '2',
            next_stages: [
              { stage: '4', stage_start_timestamp: '2026-09-23T16:00:00+02:00' },
              { stage: '0', stage_start_timestamp: '2026-09-25T05:00:00+02:00' },
            ],
          },
          capetown: { stage: '0', next_stages: [] },
        },
      },
    });
  });
  afterAll(() => {
    if (original === undefined) delete process.env.ESKOMSEPUSH_API_KEY;
    else process.env.ESKOMSEPUSH_API_KEY = original;
  });

  it('applies an announced stage that starts during the trading day', async () => {
    await expect(getLoadSheddingForDate('Johannesburg', '2026-09-23', TZ, NOW))
      .resolves.toEqual({ available: true, stage: 4, source: 'esp_schedule' });
  });

  it('carries an announced stage through a day that is inside the schedule', async () => {
    await expect(getLoadSheddingForDate('Johannesburg', '2026-09-24', TZ, NOW))
      .resolves.toEqual({ available: true, stage: 4, source: 'esp_schedule' });
    // Stage 0 from 05:00, before the 06:00-20:00 trading window opens.
    await expect(getLoadSheddingForDate('Johannesburg', '2026-09-25', TZ, NOW))
      .resolves.toEqual({ available: true, stage: 0, source: 'esp_schedule' });
  });

  it('says unknown, with the reason, for a day the schedule has not reached', async () => {
    await expect(getLoadSheddingForDate('Johannesburg', '2026-09-26', TZ, NOW)).resolves.toEqual({
      available: false, stage: null, unavailableReason: 'EskomSePush has not published a schedule for this date',
    });
  });

  it('never asks the provider about a day it cannot know', async () => {
    await expect(getLoadSheddingForDate('Johannesburg', '2026-10-05', TZ, NOW)).resolves.toEqual({
      available: false, stage: null, unavailableReason: 'EskomSePush publishes at most 7 days ahead',
    });
    await expect(getLoadSheddingForDate('Johannesburg', '2026-09-20', TZ, NOW)).resolves.toEqual({
      available: false, stage: null, unavailableReason: 'Load-shedding history is not recorded for past dates',
    });
    expect(axios.get).not.toHaveBeenCalled();
  });
});


describe('bounded review regressions for calendars and shared load shedding', () => {
  const originalKey = process.env.ESKOMSEPUSH_API_KEY;
  afterEach(() => {
    jest.restoreAllMocks();
    clearLoadSheddingCache();
    if (originalKey === undefined) delete process.env.ESKOMSEPUSH_API_KEY;
    else process.env.ESKOMSEPUSH_API_KEY = originalKey;
  });

  it('moves Christmas 2028 through the observed Monday to Friday 22 December', () => {
    expect(isPayday(day(2028, 12, 22))).toBe(true);
    expect(isPayday(day(2028, 12, 25))).toBe(false);
  });

  it('keeps observed holidays and date-only overrides local in a negative-offset timezone', () => {
    const { execFileSync } = require('child_process');
    const script = [
      "const { getPublicHolidaysForYear, isPayday } = require('./src/utils/signals');",
      "console.log(JSON.stringify({ holidays: getPublicHolidaysForYear(2026), payday: isPayday(new Date(2028, 11, 22, 12)) }));",
    ].join('\n');
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, TZ: 'America/Los_Angeles', PUBLIC_HOLIDAY_OVERRIDES: '2026-10-20:Special day' },
    }));
    expect(result.holidays).toContainEqual(expect.objectContaining({ date: '2026-08-10', observedOf: "National Women's Day" }));
    expect(result.holidays).toContainEqual(expect.objectContaining({ date: '2026-10-20', name: 'Special day' }));
    expect(result.payday).toBe(true);
  });

  it('logs one failure for seven concurrent dates and keeps each result explicitly unavailable', async () => {
    process.env.ESKOMSEPUSH_API_KEY = 'test-eskom-key';
    clearLoadSheddingCache();
    axios.get.mockReset().mockRejectedValue(new Error('provider unavailable'));
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    const now = new Date('2026-09-22T06:00:00Z');
    const results = await Promise.all(Array.from({ length: 7 }, (_, index) =>
      getLoadSheddingForDate('Johannesburg', `2026-09-${22 + index}`, 'Africa/Johannesburg', now)));
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toEqual({ available: false, stage: null, transient: true, unavailableReason: 'Load-shedding data is temporarily unavailable' });
    await getLoadSheddingForDate('Johannesburg', '2026-09-23', 'Africa/Johannesburg', now);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('pins the seven-day horizon and local 06:00 to 20:00 window', async () => {
    const { LOAD_SHEDDING_SCHEDULE_DAYS, LOAD_SHEDDING_WINDOW } = require('../../src/utils/signals');
    expect(LOAD_SHEDDING_SCHEDULE_DAYS).toBe(7);
    expect(LOAD_SHEDDING_WINDOW).toEqual({ startHour: 6, endHour: 20 });
    process.env.ESKOMSEPUSH_API_KEY = 'test-eskom-key';
    clearLoadSheddingCache();
    axios.get.mockReset().mockResolvedValue({ data: { status: { eskom: { stage: '0', next_stages: [
      { stage: '2', stage_start_timestamp: '2026-09-29T05:59:00+02:00' },
      { stage: '3', stage_start_timestamp: '2026-09-29T06:00:00+02:00' },
      { stage: '4', stage_start_timestamp: '2026-09-29T19:59:00+02:00' },
      { stage: '8', stage_start_timestamp: '2026-09-29T20:00:00+02:00' },
    ] } } } });
    const now = new Date('2026-09-22T06:00:00Z');
    await expect(getLoadSheddingForDate('Johannesburg', '2026-09-29', 'Africa/Johannesburg', now))
      .resolves.toEqual({ available: true, stage: 4, source: 'esp_schedule' });
    await expect(getLoadSheddingForDate('Johannesburg', '2026-09-30', 'Africa/Johannesburg', now))
      .resolves.toEqual(expect.objectContaining({ available: false, unavailableReason: 'EskomSePush publishes at most 7 days ahead' }));
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});
