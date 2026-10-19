const {
  defaultTradingHours,
  normalizeTradingHours,
  isWeekdayHourOpen,
} = require('../../src/utils/tradingHours');

describe('tradingHours utility', () => {
  describe('defaultTradingHours', () => {
    it('returns 7 entries indexed Sun..Sat', () => {
      const week = defaultTradingHours();
      expect(week).toHaveLength(7);
      expect(week.map((d) => d.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('defaults Sunday closed and weekdays open 07:00-17:00', () => {
      const week = defaultTradingHours();
      expect(week[0].isOpen).toBe(false);
      expect(week[1]).toMatchObject({ isOpen: true, openTime: '07:00', closeTime: '17:00' });
      expect(week[6]).toMatchObject({ isOpen: true, openTime: '08:00', closeTime: '15:00' });
    });
  });

  describe('normalizeTradingHours', () => {
    it('falls back to defaults when input is not an array', () => {
      expect(normalizeTradingHours(null)).toEqual(defaultTradingHours());
      expect(normalizeTradingHours('garbage')).toEqual(defaultTradingHours());
    });

    it('throws 400 when an open day has closeTime <= openTime', () => {
      expect(() =>
        normalizeTradingHours([{ dayOfWeek: 1, isOpen: true, openTime: '12:00', closeTime: '10:00' }])
      ).toThrow(/closeTime must be after openTime/);
    });

    it('keeps unspecified days at their defaults', () => {
      const result = normalizeTradingHours([
        { dayOfWeek: 1, isOpen: true, openTime: '06:30', closeTime: '20:00' },
      ]);
      expect(result.find((d) => d.dayOfWeek === 1)).toMatchObject({ openTime: '06:30', closeTime: '20:00' });
      expect(result.find((d) => d.dayOfWeek === 6)).toMatchObject({ openTime: '08:00', closeTime: '15:00' });
    });
  });

  describe('isWeekdayHourOpen', () => {
    const cafe = { tradingHours: defaultTradingHours() };

    it('marks hours inside the window as open', () => {
      // Monday at 10:00 should be open.
      expect(isWeekdayHourOpen(1, 10, cafe)).toBe(true);
    });

    it('marks hours outside the window as closed', () => {
      // Monday at 22:00 is outside default 07:00-17:00.
      expect(isWeekdayHourOpen(1, 22, cafe)).toBe(false);
    });

    it('marks every hour of a closed day as closed', () => {
      // Sunday default is closed.
      for (let h = 0; h < 24; h++) {
        expect(isWeekdayHourOpen(0, h, cafe)).toBe(false);
      }
    });
  });
});
