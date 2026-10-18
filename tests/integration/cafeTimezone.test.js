const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Forecast = require('../../src/models/Forecast.model');

const request = supertest(app);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const localKey = (date, timeZone) => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const shift = (key, days) => new Date(Date.parse(`${key}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const sale = (cafeId, date) => ({
  cafeId, date, hour: 9, dayOfWeek: 4, status: 'approved', items: [{ name: 'Flat White', quantity: 1, unitPrice: 40 }], total: 40,
});

describe('cafe timezone', () => {
  let token;
  let user;

  beforeEach(async () => {
    const owner = await createTestUser();
    token = owner.token;
    user = owner.user;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const putCafe = (body) => request.put('/api/cafe/me').set(auth()).send(body);

  it('lets the owner set an IANA timezone before the first import', async () => {
    const res = await putCafe({ timezone: 'America/New_York' });

    expect(res.status).toBe(200);
    expect(res.body.cafe.timezone).toBe('America/New_York');
    const me = await request.get('/api/cafe/me').set(auth());
    expect(me.body.cafe).toEqual(expect.objectContaining({ timezone: 'America/New_York', timezoneEditable: true }));
  });

  it('refuses anything that is not a supported IANA zone', async () => {
    for (const timezone of ['Not/AZone', 'GMT+2', '', 42, 'Africa/Johannesburg; x']) {
      const res = await putCafe({ timezone });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TIMEZONE');
    }
  });

  it('buckets sales and windows in the cafe timezone once it is set', async () => {
    await putCafe({ timezone: 'America/New_York' });
    // 23:30 on 15 Jan in New York is 06:30 on 16 Jan in Johannesburg.
    await Transaction.create(sale(user.activeCafeId, new Date('2026-01-15T23:30:00-05:00')));

    const res = await request.get('/api/analytics/revenue').set(auth()).query({ startDate: '2026-01-15', endDate: '2026-01-15' });

    expect(res.body.data).toEqual([{ date: '2026-01-15', revenue: 40, transactions: 1 }]);
    expect(res.body.meta).toEqual(expect.objectContaining({
      timezone: 'America/New_York',
      effectiveStartDate: '2026-01-15T05:00:00.000Z',
    }));
  });

  it('takes a window in days and anchors it on the cafe calendar', async () => {
    await putCafe({ timezone: 'America/New_York' });
    const today = localKey(new Date(), 'America/New_York');

    const res = await request.get('/api/analytics/revenue').set(auth()).query({ days: 7 });

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual(expect.objectContaining({
      days: 7,
      effectiveStartDay: shift(today, -6),
      effectiveEndDay: today,
      effectiveDays: 7,
      defaultedStartDate: false,
    }));
  });

  it('rejects days out of range, not a number, or combined with dates', async () => {
    for (const query of [{ days: 0 }, { days: 401 }, { days: 'week' }, { days: 7, startDate: '2026-01-01' }]) {
      const res = await request.get('/api/analytics/revenue').set(auth()).query(query);
      expect(res.status).toBe(400);
      expect(res.body.details.code).toBe('ANALYTICS_INVALID_DAYS');
    }
  });

  it('invalidates forecasts from today when the timezone changes', async () => {
    await Forecast.create({ cafeId: user.activeCafeId, date: new Date(Date.now() + 2 * DAY_MS) });

    await putCafe({ timezone: 'Europe/London' });

    expect(await Forecast.countDocuments({ cafeId: user.activeCafeId })).toBe(0);
  });

  it('locks the timezone once sales exist, and says why', async () => {
    await Transaction.create(sale(user.activeCafeId, new Date('2026-01-15T09:00:00+02:00')));

    const change = await putCafe({ timezone: 'Europe/London' });
    const unchanged = await putCafe({ name: 'Renamed Cafe', timezone: 'Africa/Johannesburg' });

    expect(change.status).toBe(409);
    expect(change.body.code).toBe('TIMEZONE_LOCKED');
    expect(change.body.message).toMatch(/before the first sales are imported/i);
    expect(unchanged.status).toBe(200);
    const me = await request.get('/api/cafe/me').set(auth());
    expect(me.body.cafe).toEqual(expect.objectContaining({
      name: 'Renamed Cafe', timezone: 'Africa/Johannesburg', timezoneEditable: false,
    }));
  });

  it('does not let a manager change the timezone', async () => {
    const manager = await createTestManager(token, [user.activeCafeId]);

    const res = await request.put('/api/cafe/me').set('Authorization', `Bearer ${manager.token}`).send({ timezone: 'Europe/London' });

    expect(res.status).toBe(403);
  });
});
