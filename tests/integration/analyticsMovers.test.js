const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await clearDB();
});

// One basket per day, at 09:00 Johannesburg (no daylight saving, so +02:00 is exact).
const basket = (cafeId, day, lines) => ({
  cafeId,
  date: new Date(`${day}T09:00:00+02:00`),
  hour: 9,
  dayOfWeek: new Date(`${day}T12:00:00Z`).getUTCDay(),
  status: 'approved',
  items: lines.map(([name, quantity, unitPrice]) => ({ name, quantity, unitPrice })),
  total: lines.reduce((sum, [, quantity, unitPrice]) => sum + quantity * unitPrice, 0),
});

describe('analytics movers and heatmap open hours', () => {
  let token;
  let cafeId;

  beforeEach(async () => {
    const owner = await createTestUser();
    token = owner.token;
    cafeId = owner.user.activeCafeId;
  });

  const get = (path, query) => request.get(`/api/analytics/${path}`).set('Authorization', `Bearer ${token}`).query(query);
  const freezeAt = (iso) => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'hrtime'] });
    jest.setSystemTime(new Date(iso));
    const jwt = require('jsonwebtoken');
    const claims = jwt.decode(token);
    delete claims.iat;
    delete claims.exp;
    token = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' });
  };

  it('keeps flat movers at zero at midday while totals include partial-today sales', async () => {
    freezeAt('2026-10-20T12:00:00+02:00');
    const docs = [];
    for (let n = 28; n >= 1; n -= 1) {
      const key = new Date(Date.UTC(2026, 9, 20 - n, 12)).toISOString().slice(0, 10);
      docs.push(basket(cafeId, key, [['Flat White', 8, 50]]));
    }
    docs.push(basket(cafeId, '2026-10-20', [['Flat White', 3, 50], ['Only Today', 20, 10]]));
    await Transaction.insertMany(docs);

    const res = await get('items', { days: 30 });
    expect(res.status).toBe(200);
    const flat = res.body.items.find((item) => item.name === 'Flat White');
    expect(flat.trend).toBe(0);
    expect(flat.totalQty).toBe(227); // today remains in the selected-range totals
    expect(res.body.meta.risingItems).toEqual([]);
    expect(res.body.meta.decliningItems).toEqual([]);
    expect(res.body.meta.newItems).toEqual([]);
    expect(res.body.items.find((item) => item.name === 'Only Today').isNew).toBe(false);

    const historical = await get('items', { startDate: '2026-10-06', endDate: '2026-10-19' });
    expect(historical.status).toBe(200);
    expect(historical.body.items.find((item) => item.name === 'Flat White')).toEqual(expect.objectContaining({ trend: 0, totalQty: 112 }));
  });

  it('keeps today-only quantities without inventing a completed-week mover or New label', async () => {
    freezeAt('2026-10-20T12:00:00+02:00');
    await Transaction.create(basket(cafeId, '2026-10-20', [['Only Today', 20, 10]]));
    const res = await get('items', { days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toEqual(expect.objectContaining({ totalQty: 20, totalRevenue: 200, trend: null, isNew: false }));
    expect(res.body.meta.risingItems).toEqual([]);
    expect(res.body.meta.decliningItems).toEqual([]);
    expect(res.body.meta.newItems).toEqual([]);
    expect(res.body.meta.observedSpan.endDate).toBe('2026-10-20');
  });

  it('uses the revenue completed end across a saved Sunday closure instead of Saturday data', async () => {
    freezeAt('2026-10-19T12:00:00+02:00'); // Monday; Sunday18 is complete but scheduled closed.
    const Cafe = require('../../src/models/Cafe.model');
    await Cafe.findByIdAndUpdate(cafeId, { tradingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek, isOpen: dayOfWeek !== 0, openTime: '07:00', closeTime: '17:00',
    })) });
    await Transaction.insertMany([
      basket(cafeId, '2026-10-11', [['Boundary Item', 20, 10]]),
      basket(cafeId, '2026-10-17', [['Flat White', 20, 50]]),
      basket(cafeId, '2026-10-19', [['Flat White', 3, 50]]),
    ]);
    const revenue = await get('revenue', { days: 30 });
    expect(revenue.body.meta.effectiveWindow.endDate).toBe('2026-10-18');
    const res = await get('items', { days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.items.find((item) => item.name === 'Boundary Item')).toEqual(expect.objectContaining({ trend: -100, isNew: false }));
    expect(res.body.meta.decliningItems).toContainEqual({ name: 'Boundary Item', trend: -100 });
  });

  it('uses the cafe local today when UTC and the cafe are on different dates', async () => {
    freezeAt('2026-10-20T00:30:00Z'); // Los Angeles is still trading on19Oct.
    const Cafe = require('../../src/models/Cafe.model');
    await Cafe.findByIdAndUpdate(cafeId, { timezone: 'America/Los_Angeles' });
    const docs = [];
    for (let n = 28; n >= 0; n -= 1) {
      const key = new Date(Date.UTC(2026, 9, 19 - n, 12)).toISOString().slice(0, 10);
      docs.push({ ...basket(cafeId, key, [['Flat White', n === 0 ? 3 : 8, 50]]), date: new Date(`${key}T09:00:00-07:00`) });
    }
    await Transaction.insertMany(docs);
    const res = await get('items', { days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.meta.effectiveEndDay).toBe('2026-10-19');
    expect(res.body.items[0]).toEqual(expect.objectContaining({ trend: 0, totalQty: 227 }));
  });

  it('ranks only items that sell 2+ a day and lists new items as new, not +100%', async () => {
    // The last day with data is Wed 11 Feb, so the movers compare 5-11 Feb with 29 Jan-4 Feb.
    await Transaction.insertMany([
      basket(cafeId, '2026-02-04', [['Latte', 40, 30], ['Coke', 1, 20], ['Muffin', 42, 35], ['Brownie', 6, 30]]),
      basket(cafeId, '2026-02-11', [
        ['Latte', 52, 30], ['Coke', 8, 20], ['Iced Matcha', 20, 45], ['Scone', 12, 30], ['Muffin', 21, 35], ['Brownie', 2, 30],
      ]),
    ]);

    const res = await get('items', { startDate: '2026-02-01', endDate: '2026-02-14' });

    expect(res.status).toBe(200);
    expect(res.body.meta.risingItems).toEqual([{ name: 'Latte', trend: 30 }]); // Coke +700% is under the floor
    expect(res.body.meta.decliningItems).toEqual([{ name: 'Muffin', trend: -50 }]); // Brownie is under the floor
    expect(res.body.meta.newItems).toEqual([{ name: 'Iced Matcha', currentQty: 20 }]); // Scone (12) is under the floor
    expect(res.body.meta.moverFloor).toEqual({
      windowDays: 7, minQty: 14, eligibleCount: 3, belowFloorCount: 3, busiestQty: 52,
    });
    const byName = Object.fromEntries(res.body.items.map((item) => [item.name, item]));
    expect(byName['Iced Matcha']).toEqual(expect.objectContaining({ trend: null, isNew: true }));
    expect(byName.Scone).toEqual(expect.objectContaining({ trend: null, isNew: false }));
    expect(byName.Latte).toEqual(expect.objectContaining({ trend: 30, isNew: false }));
  });

  it('marks every heatmap cell open or closed from the trading hours, keeping sales in closed hours', async () => {
    // Default trading hours: weekdays 07:00-17:00, Saturday 08:00-15:00, Sunday closed. 8 Feb 2026 is a Sunday.
    await Transaction.insertMany([
      basket(cafeId, '2026-02-08', [['Flat White', 1, 40]]),
      basket(cafeId, '2026-02-09', [['Flat White', 2, 40]]),
    ]);

    const res = await get('heatmap', { startDate: '2026-02-01', endDate: '2026-02-14' });
    const cell = (dayOfWeek, hour) => res.body.heatmap.find((c) => c.dayOfWeek === dayOfWeek && c.hour === hour);

    expect(res.body.heatmap).toHaveLength(119);
    for (const each of res.body.heatmap) expect(typeof each.isOpen).toBe('boolean');
    expect(cell(1, 9).isOpen).toBe(true);
    expect(cell(1, 6).isOpen).toBe(false); // before opening
    expect(cell(1, 17).isOpen).toBe(false); // the hour that starts at closing time
    expect(cell(0, 9)).toEqual(expect.objectContaining({ isOpen: false, totalRevenue: 40 }));
  });
});
