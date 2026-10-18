const { isSupportedTimezone } = require('../../src/utils/timezone');

describe('isSupportedTimezone', () => {
  it.each(['Africa/Johannesburg', 'Europe/London', 'America/New_York', 'Indian/Mauritius', 'UTC',
    'Asia/Kolkata', 'Europe/Kyiv', 'Asia/Ho_Chi_Minh', 'Asia/Kathmandu', 'America/Argentina/Buenos_Aires', 'America/Nuuk'])('accepts %s', (zone) => {
    expect(isSupportedTimezone(zone)).toBe(true);
  });

  it.each(['Not/AZone', 'GMT+2', '', 'africa/johannesburg', null, 42])('rejects %p', (zone) => {
    expect(isSupportedTimezone(zone)).toBe(false);
  });
});
