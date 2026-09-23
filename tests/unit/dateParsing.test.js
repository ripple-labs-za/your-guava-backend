const { parseDateTime } = require('../../src/services/parser/dates');
const { parseBuffer } = require('../../src/services/parser.service');

const ZONE = 'Africa/Johannesburg';
const LF = String.fromCharCode(10);
const localClock = (date, timezone = ZONE) =>
  date.toLocaleTimeString('en-ZA', { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit' });

describe('12-hour clocks at their edges', () => {
  it.each([
    ['12:00 AM', '00:00'],
    ['12:00 PM', '12:00'],
    ['0:30', '00:30'],
    ['2:15PM', '14:15'],
    ['2:15 P.M.', '14:15'],
  ])('reads %s as %s', (time, clock) => {
    const { date, timeKnown } = parseDateTime('2026-09-14', time, ZONE);
    expect(localClock(date)).toBe(clock);
    expect(timeKnown).toBe(true);
  });

  it.each(['00:30 AM', '2.15 PM', '13:00 PM', '24:00', '9:60'])('refuses %s instead of guessing', (time) => {
    expect(parseDateTime('2026-09-14', time, ZONE).date).toBeNull();
  });
});

describe('spreadsheet cells', () => {
  it('treats a date-only cell (midnight UTC) as having no time of day', () => {
    const { date, timeKnown } = parseDateTime(new Date(Date.UTC(2026, 8, 14)), undefined, ZONE);
    expect(timeKnown).toBe(false);
    expect(localClock(date)).toBe('00:00');
  });

  it('treats a datetime cell at 09:30 as known', () => {
    const { date, timeKnown } = parseDateTime(new Date(Date.UTC(2026, 8, 14, 9, 30)), undefined, ZONE);
    expect(timeKnown).toBe(true);
    expect(localClock(date)).toBe('09:30');
  });

  it('treats an Excel serial with a fraction as known and a whole serial as not', () => {
    expect(parseDateTime(46279.5, undefined, ZONE).timeKnown).toBe(true);
    expect(parseDateTime(46279, undefined, ZONE).timeKnown).toBe(false);
  });
});

describe('day/month order across a long file', () => {
  const lines = (count) => Array.from({ length: count }, (_, index) => `0${1 + (index % 9)}/0${1 + (index % 9)}/2026,1 x Latte,38.00`);

  it('names the real source rows when a contradiction appears thousands of rows in', async () => {
    const file = ['Date,Items,Total', ...lines(5000), '13/09/2026,1 x Latte,38.00', '09/14/2026,1 x Latte,38.00'].join(LF);
    await expect(parseBuffer(Buffer.from(file), {
      columnMapping: { date: 'Date', items: 'Items', total: 'Total' }, itemsMode: 'packed', timezone: ZONE,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/row 5002 reads 13\/09\/2026 and row 5003 reads 09\/14\/2026/),
    });
  });

  it('settles the order from a single decisive row at the end of the file', async () => {
    const file = ['Date,Items,Total', ...lines(5000), '09/13/2026,1 x Latte,38.00'].join(LF);
    const result = await parseBuffer(Buffer.from(file), {
      columnMapping: { date: 'Date', items: 'Items', total: 'Total' }, itemsMode: 'packed', timezone: ZONE,
    });
    expect(result.rows[result.rows.length - 1].dateKey).toBe('2026-09-13');
    expect(result.rows[0].dateKey).toBe('2026-01-01');
  });
});

describe('a cafe in another zone than the host', () => {
  it.each([
    ['14 Sep 2026 23:30'],
    ['2026-09-14 23:30:00.250'],
  ])('lands %s on the cafe day in Auckland', (cell) => {
    const { date } = parseDateTime(cell, undefined, 'Pacific/Auckland');
    expect(date.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' })).toBe('2026-09-14');
    expect(localClock(date, 'Pacific/Auckland')).toBe('23:30');
  });
});

// Review of BE-03-T06: shapes production already imported correctly (server.js pins the process zone to
// Africa/Johannesburg, so new Date(string) read naive strings in the cafe zone for SA cafes).
describe('shapes the old new Date(string) fallback already read', () => {
  const packed = { date: 'Date', items: 'Items', total: 'Total' };
  const parseFile = (cells) => parseBuffer(
    Buffer.from(['Date,Items,Total', ...cells.map((cell) => `"${cell}",1 x Latte,38.00`)].join(LF)),
    { columnMapping: packed, itemsMode: 'packed', timezone: ZONE }
  );

  it('keeps an en-US 12-hour file with no day above 12 month-first, as it imported before', async () => {
    const result = await parseFile(['9/1/2026 8:05:00 AM', '9/3/2026 2:15:00 PM', '9/10/2026 11:30:00 AM']);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows.map((row) => row.dateKey)).toEqual(['2026-09-01', '2026-09-03', '2026-09-10']);
    expect(localClock(result.rows[1].date)).toBe('14:15');
  });

  it('still reads a 24-hour file with no day above 12 day-first', async () => {
    const result = await parseFile(['03/09/2026 14:15', '04/09/2026 09:00']);
    expect(result.rows.map((row) => row.dateKey)).toEqual(['2026-09-03', '2026-09-04']);
  });

  it('reads en-US toLocaleString cells (a comma before the time) month-first from the file', async () => {
    const result = await parseFile(['9/14/2026, 11:30:00 PM', '9/3/2026, 8:05:00 AM']);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows.map((row) => row.date.toISOString())).toEqual(['2026-09-14T21:30:00.000Z', '2026-09-03T06:05:00.000Z']);
  });

  it('lets a decisive day-first value win over AM/PM', async () => {
    const result = await parseFile(['13/09/2026 2:15 PM', '03/09/2026 9:00 AM']);
    expect(result.rows.map((row) => row.dateKey)).toEqual(['2026-09-13', '2026-09-03']);
  });

  it.each([
    ['2026/09/14, 23:30:00', '2026-09-14T21:30:00.000Z'],
    ['2026-09-14T23:30:00.1234567+02:00', '2026-09-14T21:30:00.123Z'],
    ['2026-09-14T21:30:00.1234567Z', '2026-09-14T21:30:00.123Z'],
    ['2026-09-14 21:30:00+00', '2026-09-14T21:30:00.000Z'],
    ['2026-09-14 21:30:00 UTC', '2026-09-14T21:30:00.000Z'],
    ['Mon, 14 Sep 2026 23:30:00 +0200', '2026-09-14T21:30:00.000Z'],
    ['Mon Sep 14 2026 23:30:00 GMT+0200 (South Africa Standard Time)', '2026-09-14T21:30:00.000Z'],
    ['Sep-14-2026 23:30', '2026-09-14T21:30:00.000Z'],
    ['2026-Sep-14 23:30', '2026-09-14T21:30:00.000Z'],
    ['14th Sep 2026 23:30', '2026-09-14T21:30:00.000Z'],
    ['sept 14, 2026 11:30 pm', '2026-09-14T21:30:00.000Z'],
  ])('reads %s', (cell, iso) => {
    const { date, timeKnown } = parseDateTime(cell, undefined, ZONE);
    expect(date && date.toISOString()).toBe(iso);
    expect(timeKnown).toBe(true);
  });
});

