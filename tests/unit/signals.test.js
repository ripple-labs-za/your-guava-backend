jest.mock('axios');

const axios = require('axios');
const {
  isPayday,
  isPublicHoliday,
  getPublicHolidayInfo,
  getPublicHolidaysForYear,
  getSchoolCalendarForYear,
  isSchoolHoliday,
  getLoadSheddingStage,
  clearLoadSheddingCache,
  getSignalsForDate,
} = require('../../src/utils/signals');

describe('signals utility', () => {
  describe('isPayday', () => {
    it('returns true for the 1st of the month', () => {
      expect(isPayday(new Date(2026, 5, 1))).toBe(true); // Jun 1
    });

    it('returns true for the 25th of the month', () => {
      expect(isPayday(new Date(2026, 0, 23))).toBe(true); // Jan 25 is a Sunday, so the Friday before
      expect(isPayday(new Date(2026, 7, 25))).toBe(true); // Aug 25
    });

    it('returns true for the last business day of the month', () => {
      // January 2026: 31st is Saturday, so last biz day = Friday 30th
      expect(isPayday(new Date(2026, 0, 30))).toBe(true);
      // February 2026: 28th is Saturday, so last biz day = Friday 27th
      expect(isPayday(new Date(2026, 1, 27))).toBe(true);
    });

    it('returns false for non-payday dates', () => {
      expect(isPayday(new Date(2026, 0, 15))).toBe(false); // Jan 15
      expect(isPayday(new Date(2026, 2, 10))).toBe(false); // Mar 10
      expect(isPayday(new Date(2026, 5, 18))).toBe(false); // Jun 18
    });
  });

  describe('isPublicHoliday', () => {
    it('returns true for New Year\'s Day (Jan 1)', () => {
      expect(isPublicHoliday(new Date(2026, 0, 1))).toBe(true);
    });

    it('returns true for Christmas Day (Dec 25)', () => {
      expect(isPublicHoliday(new Date(2026, 11, 25))).toBe(true);
    });

    it('returns true for Freedom Day (Apr 27)', () => {
      expect(isPublicHoliday(new Date(2026, 3, 27))).toBe(true);
    });

    it('returns true for Human Rights Day (Mar 21)', () => {
      expect(isPublicHoliday(new Date(2026, 2, 21))).toBe(true);
    });

    it('returns true for 2026 Good Friday (Apr 3)', () => {
      expect(isPublicHoliday(new Date(2026, 3, 3))).toBe(true);
    });

    it('returns true for 2026 Family Day / Easter Monday (Apr 6)', () => {
      expect(isPublicHoliday(new Date(2026, 3, 6))).toBe(true);
    });

    it('calculates Easter-based holidays for future years', () => {
      expect(getPublicHolidayInfo(new Date(2028, 3, 14))).toEqual(
        expect.objectContaining({ name: 'Good Friday' })
      );
      expect(getPublicHolidayInfo(new Date(2028, 3, 17))).toEqual(
        expect.objectContaining({ name: 'Family Day' })
      );
    });

    it('marks the following Monday when a public holiday falls on Sunday', () => {
      expect(isPublicHoliday(new Date(2026, 7, 9))).toBe(true); // National Women's Day
      expect(getPublicHolidayInfo(new Date(2026, 7, 10))).toEqual(
        expect.objectContaining({
          name: "National Women's Day observed",
          observedOf: "National Women's Day",
        })
      );
    });

    it('includes known one-off declared public holidays', () => {
      expect(getPublicHolidayInfo(new Date(2024, 4, 29))).toEqual(
        expect.objectContaining({ name: 'National and Provincial Elections' })
      );
      expect(getPublicHolidayInfo(new Date(2022, 11, 27))).toEqual(
        expect.objectContaining({ name: 'Special Public Holiday' })
      );
    });

    it('accepts environment-configured public holiday overrides', () => {
      const original = process.env.PUBLIC_HOLIDAY_OVERRIDES;
      process.env.PUBLIC_HOLIDAY_OVERRIDES = '2030-02-14:Cafe Closure Day';

      expect(getPublicHolidayInfo(new Date(2030, 1, 14))).toEqual(
        expect.objectContaining({ name: 'Cafe Closure Day' })
      );

      if (original === undefined) delete process.env.PUBLIC_HOLIDAY_OVERRIDES;
      else process.env.PUBLIC_HOLIDAY_OVERRIDES = original;
    });

    it('returns a generated yearly holiday calendar', () => {
      const holidays = getPublicHolidaysForYear(2026);

      expect(holidays).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ date: '2026-04-03', name: 'Good Friday' }),
          expect.objectContaining({ date: '2026-08-10', observedOf: "National Women's Day" }),
        ])
      );
    });

    it('returns false for non-holiday dates', () => {
      expect(isPublicHoliday(new Date(2026, 0, 15))).toBe(false); // Jan 15
      expect(isPublicHoliday(new Date(2026, 6, 4))).toBe(false);  // Jul 4
      expect(isPublicHoliday(new Date(2026, 10, 15))).toBe(false); // Nov 15
    });
  });

  describe('isSchoolHoliday', () => {
    const originalSchoolCalendarOverrides = {
      SCHOOL_CALENDAR_OVERRIDES: process.env.SCHOOL_CALENDAR_OVERRIDES,
      SCHOOL_TERM_OVERRIDES: process.env.SCHOOL_TERM_OVERRIDES,
      SA_SCHOOL_TERM_OVERRIDES: process.env.SA_SCHOOL_TERM_OVERRIDES,
    };

    afterEach(() => {
      for (const [key, value] of Object.entries(originalSchoolCalendarOverrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('exposes the gazetted learner calendar through 2027', () => {
      expect(getSchoolCalendarForYear(2027)).toEqual({
        terms: [
          { start: '2027-01-13', end: '2027-03-19' },
          { start: '2027-04-06', end: '2027-06-25' },
          { start: '2027-07-20', end: '2027-09-22' },
          { start: '2027-10-05', end: '2027-12-08' },
        ],
        specialSchoolHolidays: ['2027-04-26'],
      });
    });

    it('returns false during school term (in session)', () => {
      // 2026 Term 1: Jan 14 - Mar 27
      expect(isSchoolHoliday(new Date(2026, 0, 20))).toBe(false); // Jan 20
      expect(isSchoolHoliday(new Date(2026, 1, 15))).toBe(false); // Feb 15
      // 2026 Term 2: Apr 8 - Jun 26
      expect(isSchoolHoliday(new Date(2026, 3, 8))).toBe(false); // Apr 8
      expect(isSchoolHoliday(new Date(2026, 4, 10))).toBe(false); // May 10
      // 2027 Term 3: Jul 20 - Sep 22
      expect(isSchoolHoliday(new Date(2027, 6, 20))).toBe(false); // Jul 20
    });

    it('returns true during school holiday (outside term)', () => {
      // Between Term 1 and Term 2: Mar 28 - Apr 7
      expect(isSchoolHoliday(new Date(2026, 3, 1))).toBe(true); // Apr 1
      // After Term 4: Dec 10+
      expect(isSchoolHoliday(new Date(2026, 11, 10))).toBe(true); // Dec 10
      expect(isSchoolHoliday(new Date(2026, 11, 20))).toBe(true); // Dec 20
      // Before Term 1: Jan 1-13
      expect(isSchoolHoliday(new Date(2026, 0, 5))).toBe(true); // Jan 5
      // 2027 winter break
      expect(isSchoolHoliday(new Date(2027, 6, 1))).toBe(true); // Jul 1
    });

    it('corrects the published 2025 and 2026 term boundaries', () => {
      expect(isSchoolHoliday(new Date(2025, 9, 1))).toBe(false); // 2025 Term 3 still active
      expect(isSchoolHoliday(new Date(2025, 9, 8))).toBe(true); // 2025 Oct break
      expect(isSchoolHoliday(new Date(2026, 8, 24))).toBe(true); // 2026 Sep break
    });

    it('marks gazetted special school holidays inside a term', () => {
      expect(isSchoolHoliday(new Date(2025, 3, 29))).toBe(true); // Apr 29
      expect(isSchoolHoliday(new Date(2026, 5, 15))).toBe(true); // Jun 15
      expect(isSchoolHoliday(new Date(2027, 3, 26))).toBe(true); // Apr 26
    });

    it('fails safe (no signal) for years without term data', () => {
      expect(getSchoolCalendarForYear(2030)).toBeNull();
      expect(isSchoolHoliday(new Date(2030, 3, 1))).toBe(false);
    });

    it('accepts environment-configured school calendar overrides', () => {
      process.env.SCHOOL_CALENDAR_OVERRIDES = JSON.stringify({
        2030: {
          terms: [
            ['2030-01-10', '2030-03-20'],
            ['2030-04-07', '2030-06-19'],
            ['2030-07-14', '2030-09-18'],
            ['2030-10-06', '2030-12-05'],
          ],
          specialSchoolHolidays: ['2030-06-17'],
        },
      });

      expect(getSchoolCalendarForYear(2030)).toEqual(
        expect.objectContaining({
          specialSchoolHolidays: ['2030-06-17'],
        })
      );
      expect(isSchoolHoliday(new Date(2030, 0, 15))).toBe(false); // In term
      expect(isSchoolHoliday(new Date(2030, 2, 25))).toBe(true); // Between terms
      expect(isSchoolHoliday(new Date(2030, 5, 17))).toBe(true); // Special school holiday
    });

    it('ignores malformed school calendar overrides safely', () => {
      process.env.SCHOOL_CALENDAR_OVERRIDES = JSON.stringify({
        2030: {
          terms: [['2030-01-10', '2030-03-20']],
        },
      });

      expect(getSchoolCalendarForYear(2030)).toBeNull();
      expect(isSchoolHoliday(new Date(2030, 0, 15))).toBe(false);
    });
  });

  describe('load-shedding signals', () => {
    const originalApiKey = process.env.ESKOMSEPUSH_API_KEY;

    beforeEach(() => {
      jest.clearAllMocks();
      clearLoadSheddingCache();
      process.env.ESKOMSEPUSH_API_KEY = 'test-eskom-key';
    });

    afterAll(() => {
      if (originalApiKey === undefined) delete process.env.ESKOMSEPUSH_API_KEY;
      else process.env.ESKOMSEPUSH_API_KEY = originalApiKey;
    });

    it('distinguishes an unconfigured service from a verified stage zero', async () => {
      process.env.ESKOMSEPUSH_API_KEY = '';
      await expect(getLoadSheddingStage('Cape Town')).resolves.toEqual({
        available: false,
        stage: null,
        unavailableReason: 'Load-shedding service is not configured',
      });

      process.env.ESKOMSEPUSH_API_KEY = 'test-eskom-key';
      axios.get.mockResolvedValueOnce({
        data: {
          status: {
            capetown: { stage: 0 },
            eskom: { stage: 2 },
          },
        },
      });
      await expect(getLoadSheddingStage('Cape Town')).resolves.toEqual({
        available: true,
        stage: 0,
      });
    });

    it('returns unknown rather than stage zero when the provider fails', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      axios.get.mockRejectedValueOnce(new Error('provider offline'));

      await expect(getLoadSheddingStage('Johannesburg')).resolves.toEqual({
        available: false,
        stage: null,
        unavailableReason: 'Load-shedding data is temporarily unavailable',
        transient: true,
      });
      errorSpy.mockRestore();
    });

    it('rejects malformed or out-of-range provider stages', async () => {
      axios.get.mockResolvedValueOnce({
        data: {
          status: {
            capetown: { stage: 999 },
            eskom: { stage: 1.5 },
          },
        },
      });

      await expect(getLoadSheddingStage('Cape Town')).resolves.toEqual({
        available: false,
        stage: null,
        unavailableReason: 'Load-shedding provider returned no stage for this area',
      });
    });

    it('marks an unannounced future day as unknown', async () => {
      axios.get.mockResolvedValueOnce({
        data: { status: { capetown: { stage: '0', next_stages: [] }, eskom: { stage: '0', next_stages: [] } } },
      });
      const future = new Date();
      future.setDate(future.getDate() + 1);

      const signals = await getSignalsForDate(future, { city: 'Cape Town', timezone: 'Africa/Johannesburg' });

      expect(signals.loadSheddingStage).toBeNull();
      expect(signals.loadSheddingAvailable).toBe(false);
      expect(signals.loadSheddingUnavailableReason).toBe('EskomSePush has not published a schedule for this date');
    });
  });
});
