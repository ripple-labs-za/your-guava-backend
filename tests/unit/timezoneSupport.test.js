const { isSupportedTimezone } = require('../../src/utils/timezone');

describe('isSupportedTimezone', () => {
  it.each(['Africa/Johannesburg', 'Europe/London', 'America/New_York', 'Indian/Mauritius', 'UTC'])('accepts %s', (zone) => {
    expect(isSupportedTimezone(zone)).toBe(true);
  });

  it.each(['Not/AZone', 'GMT+2', '', 'africa/johannesburg', null, 42])('rejects %p', (zone) => {
    expect(isSupportedTimezone(zone)).toBe(false);
  });
});
