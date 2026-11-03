// L-4 (#117): accuracy by week on /forecasts/accuracy, with the same definition of a scored day as the headline.
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');
const { weeklyAccuracy, WEEKLY_ACCURACY_WEEKS } = require('../../src/services/forecast/accuracy');
const { addZonedDays, zonedDateKey, zonedDayOfWeek, zonedDayStart } = require('../../src/utils/timezone');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const TZ = 'Africa/Johannesburg';
const today = () => zonedDayStart(new Date(), TZ);
const thisMonday = () => addZonedDays(today(), -((zonedDayOfWeek(today(), TZ) + 6) % 7), TZ);

let token;
let cafe;
beforeEach(async () => {
  ({ token } = await createTestUser());
  cafe = await Cafe.findOneAndUpdate({}, { $set: { timezone: TZ } }, { new: true }).lean();
});

const scored = (date, accuracy, extra = {}) => Forecast.create({
  cafeId: cafe._id, date, dateKey: zonedDateKey(date, TZ), generatedAt: new Date(), origin: 'live', items: [],
  totalPredictedRevenue: 100, actualRevenue: 100, actualsUpdatedAt: new Date(), accuracy, itemAccuracy: accuracy - 10,
  modelVersion: 'test-model', availability: { status: 'ready' }, signals: { events: [] }, ...extra,
});

describe('weekly accuracy (L-4)', () => {
  it('groups scored days by cafe-local week, live first, leaving out days still building history', async () => {
    const lastWeek = addZonedDays(thisMonday(), -7, TZ);
    const twoWeeksAgo = addZonedDays(thisMonday(), -14, TZ);
    await scored(lastWeek, 80);
    await scored(addZonedDays(lastWeek, 1, TZ), 90);
    await scored(addZonedDays(lastWeek, 2, TZ), 85);
    await scored(addZonedDays(lastWeek, 3, TZ), 10, { availability: { status: 'insufficient_data' } });
    await scored(twoWeeksAgo, 70, { origin: 'backfill' });

    const weeks = await weeklyAccuracy(cafe._id, TZ);
    expect(weeks).toHaveLength(WEEKLY_ACCURACY_WEEKS);
    const byStart = new Map(weeks.map((week) => [week.weekStart, week]));
    expect(byStart.get(zonedDateKey(lastWeek, TZ))).toMatchObject({
      days: 3, avgAccuracy: 85, avgItemAccuracy: 75, basis: 'live', modelVersions: ['test-model'],
    });
    expect(byStart.get(zonedDateKey(twoWeeksAgo, TZ))).toMatchObject({ days: 1, avgAccuracy: 70, basis: 'backtest' });
    expect(weeks[0].weekStart < weeks[weeks.length - 1].weekStart).toBe(true);
    expect(weeks.filter((week) => week.basis === 'none').every((week) => week.avgAccuracy === null)).toBe(true);
  });

  it('is part of GET /forecasts/accuracy', async () => {
    await scored(addZonedDays(thisMonday(), -7, TZ), 88);
    const res = await request.get('/api/forecasts/accuracy').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.weekly).toHaveLength(WEEKLY_ACCURACY_WEEKS);
    expect(res.body.weekly.find((week) => week.days > 0)).toMatchObject({ avgAccuracy: 88 });
  });
});
