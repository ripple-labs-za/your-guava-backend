const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
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
      minAvgPerDay: 2, windowDays: 7, minQty: 14, eligibleCount: 3, busiestQty: 52,
    });
    const byName = Object.fromEntries(res.body.items.map((item) => [item.name, item]));
    expect(byName['Iced Matcha']).toEqual(expect.objectContaining({ trend: null, isNew: true }));
    expect(byName.Scone).toEqual(expect.objectContaining({ trend: null, isNew: true }));
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
