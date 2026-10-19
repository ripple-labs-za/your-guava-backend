const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Item = require('../../src/models/Item.model');
const Forecast = require('../../src/models/Forecast.model');
const Organization = require('../../src/models/Organization.model');
const Transaction = require('../../src/models/Transaction.model');
const forecastService = require('../../src/services/forecast.service');
const { addZonedDays, zonedDayStart, zonedDateKey } = require('../../src/utils/timezone');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const TZ = 'Africa/Johannesburg';
const localDay = (offset) => addZonedDays(zonedDayStart(new Date(), TZ), offset, TZ);
const quietSignals = {
  weather: { temp: 20, condition: 'clear', humidity: 60 },
  loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false, dayOfWeek: 0, events: [],
};

describe('forecast generation integrity', () => {
  let token;
  let user;
  let cafe;

  beforeEach(async () => {
    ({ token, user } = await createTestUser());
    cafe = await Cafe.findOne({});
  });

  it('refuses to regenerate a past day and leaves its scored forecast alone', async () => {
    const yesterday = localDay(-1);
    await Forecast.create({
      cafeId: cafe._id, date: yesterday, generatedAt: new Date(), origin: 'live', items: [], signals: quietSignals,
      totalPredictedRevenue: 100, actualRevenue: 90, actualsUpdatedAt: new Date(), accuracy: 90,
    });

    const res = await request.post('/api/forecasts/generate').set('Authorization', `Bearer ${token}`)
      .send({ date: zonedDateKey(yesterday, TZ) });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'FORECAST_DATE_OUT_OF_RANGE',
      allowedFrom: zonedDateKey(localDay(0), TZ),
      allowedTo: zonedDateKey(localDay(13), TZ),
    }));
    const stored = await Forecast.findOne({ cafeId: cafe._id, date: yesterday }).lean();
    expect(stored).toEqual(expect.objectContaining({ origin: 'live', accuracy: 90, actualRevenue: 90 }));
  });

  it('refuses a day beyond the two-week planning horizon', async () => {
    const res = await request.post('/api/forecasts/generate').set('Authorization', `Bearer ${token}`)
      .send({ date: zonedDateKey(localDay(14), TZ) });
    expect(res.status).toBe(400);
    expect(await Forecast.countDocuments({ cafeId: cafe._id })).toBe(0);
  });

  it('generates today and the last day of the horizon', async () => {
    for (const offset of [0, 13]) {
      const res = await request.post('/api/forecasts/generate').set('Authorization', `Bearer ${token}`)
        .send({ date: zonedDateKey(localDay(offset), TZ) });
      expect(res.status).toBe(200);
    }
  });

  it('does not let a generation that started before an invalidation overwrite the fresh forecast', async () => {
    await Organization.findByIdAndUpdate(user.orgId, { plan: 'growth' });
    const target = localDay(2);
    const realFind = Item.find.bind(Item);
    let fresh = null;
    let raced = false;
    jest.spyOn(Item, 'find').mockImplementation((...args) => {
      if (raced) return realFind(...args);
      raced = true;
      const chain = {
        select: () => chain,
        // The first generation is paused here, after it read settings and history: the owner saves a factor meanwhile.
        lean: async () => {
          await Cafe.updateOne({ _id: cafe._id }, { $set: { 'forecastSettings.payday.pct': 5 } });
          await forecastService.invalidatePlanningForecasts(cafe._id);
          fresh = await forecastService.generateForecast(cafe._id, target, { origin: 'live' });
          return realFind(...args).lean();
        },
      };
      return chain;
    });

    const stale = await forecastService.generateForecast(cafe._id, target, { origin: 'live' });

    const stored = await Forecast.find({ cafeId: cafe._id, date: target }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].inputsVersion).toBe(1);
    expect(stored[0].factorSettings.payday.pct).toBe(5);
    expect(String(stale._id)).toBe(String(fresh._id));
  });

  it('re-scores a renamed menu item by its id, under its new name', async () => {
    const created = await request.post('/api/items').set('Authorization', `Bearer ${token}`)
      .send({ name: 'flat white', category: 'coffee' });
    const itemId = created.body.item._id;
    const yesterday = localDay(-1);
    await Transaction.create({
      cafeId: cafe._id, date: new Date(yesterday.getTime() + 10 * 3600 * 1000), hour: 10, dayOfWeek: 0,
      status: 'approved', total: 420, items: [{ name: 'flat white', salesItemId: itemId, quantity: 14, unitPrice: 30 }],
    });
    await Forecast.create({
      cafeId: cafe._id, date: yesterday, generatedAt: new Date(), origin: 'live', signals: quietSignals,
      items: [{ itemName: 'flat white', salesItemId: itemId, predictedQty: 15, expectedQty: 15 }],
      forecastCoverage: { itemCount: 1, storedItemCount: 1, totalPredictedQty: 15, includesAllRevenue: true },
      totalPredictedRevenue: 450, actualRevenue: 420, actualsUpdatedAt: new Date(), accuracy: 93.3,
    });

    const renamed = await request.put(`/api/items/${itemId}`).set('Authorization', `Bearer ${token}`).send({ name: 'Flat White' });
    expect(renamed.status).toBe(200);
    await forecastService._test.waitForMenuRefresh(cafe._id);

    const line = (await Forecast.findOne({ cafeId: cafe._id, date: yesterday }).lean()).items[0];
    // Scored by the old name the line reads 0 sold against 15 predicted, and learning cuts every item for 60 days.
    expect(line).toEqual(expect.objectContaining({ itemName: 'Flat White', actualQty: 14 }));
  });

  it('keeps a day with a merged line out of calibration instead of double-counting the target', async () => {
    const target = await request.post('/api/items').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cappuccino', category: 'coffee' });
    const source = await request.post('/api/items').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Capuccino', category: 'coffee' });
    const targetId = target.body.item._id;
    const sourceId = source.body.item._id;
    const yesterday = localDay(-1);
    await Transaction.create({
      cafeId: cafe._id, date: new Date(yesterday.getTime() + 9 * 3600 * 1000), hour: 9, dayOfWeek: 0, status: 'approved', total: 390,
      items: [
        { name: 'Capuccino', salesItemId: sourceId, quantity: 4, unitPrice: 30 },
        { name: 'Cappuccino', salesItemId: targetId, quantity: 9, unitPrice: 30 },
      ],
    });
    await Forecast.create({
      cafeId: cafe._id, date: yesterday, generatedAt: new Date(), origin: 'live', signals: quietSignals,
      items: [
        { itemName: 'Capuccino', salesItemId: sourceId, predictedQty: 5, expectedQty: 5 },
        { itemName: 'Cappuccino', salesItemId: targetId, predictedQty: 10, expectedQty: 10 },
      ],
      forecastCoverage: { itemCount: 2, storedItemCount: 2, totalPredictedQty: 15, includesAllRevenue: true },
      totalPredictedRevenue: 450, actualRevenue: 390, actualsUpdatedAt: new Date(), accuracy: 86.7,
    });

    const merged = await request.post(`/api/items/${sourceId}/resolve`).set('Authorization', `Bearer ${token}`)
      .send({ action: 'map_to', targetItemId: targetId });
    expect(merged.status).toBe(200);
    await forecastService._test.waitForMenuRefresh(cafe._id);

    const stored = await Forecast.findOne({ cafeId: cafe._id, date: yesterday }).lean();
    expect(stored.items.find((line) => String(line.salesItemId) === String(targetId)).actualQty).toBe(13);
    expect(stored.items.find((line) => String(line.salesItemId) === String(sourceId)).actualQty).toBeNull();
    expect(stored.calibrationExcluded).toBe(true);
  });

  it.each(['flat white', 'Old till label', 'Last till label'])('retains legacy %s forecast actuals through a rename', async (oldForecastName) => {
    const aliases = oldForecastName === 'Last till label'
      ? [...Array.from({ length: 49 }, (_, index) => `Till alias ${index}`), oldForecastName]
      : ['Old till label'];
    const created = await request.post('/api/items').set('Authorization', `Bearer ${token}`)
      .send({ name: 'flat white', aliases, category: 'coffee' });
    expect(created.status).toBe(201);
    const itemId = created.body.item._id;
    const otherItem = await request.post('/api/items').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Already linked coffee', category: 'coffee' });
    expect(otherItem.status).toBe(201);
    const otherId = otherItem.body.item._id;
    const yesterday = localDay(-1);
    await Transaction.create({
      cafeId: cafe._id, date: new Date(yesterday.getTime() + 10 * 3600 * 1000), hour: 10, dayOfWeek: 0,
      status: 'approved', total: 420, items: [{ name: 'flat white', salesItemId: itemId, quantity: 14, unitPrice: 30 }],
    });
    const forecast = await Forecast.create({
      cafeId: cafe._id, date: yesterday, generatedAt: new Date(), origin: 'live', signals: quietSignals,
      items: [
        { itemName: oldForecastName, predictedQty: 15, expectedQty: 15 },
        { itemName: oldForecastName, salesItemId: otherId, predictedQty: 2, expectedQty: 2 },
      ],
      forecastCoverage: { itemCount: 2, storedItemCount: 2, totalPredictedQty: 17, includesAllRevenue: true },
      totalPredictedRevenue: 510, actualRevenue: 420, actualsUpdatedAt: new Date(), accuracy: 80,
    });
    const otherCafe = await Cafe.create({ name: 'Unrelated forecast cafe', orgId: cafe.orgId, timezone: TZ });
    const untouched = await Forecast.create({
      cafeId: otherCafe._id, date: yesterday, generatedAt: new Date(), origin: 'live', signals: quietSignals,
      items: [{ itemName: oldForecastName, predictedQty: 1, expectedQty: 1 }], totalPredictedRevenue: 30,
    });
    expect(forecast.items[0].salesItemId).toBeUndefined();

    const renamed = await request.put(`/api/items/${itemId}`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Flat White' });
    expect(renamed.status).toBe(200);
    await forecastService._test.waitForMenuRefresh(cafe._id);

    const stored = await Forecast.findById(forecast._id).lean();
    expect(stored.items[0]).toEqual(expect.objectContaining({ itemName: 'Flat White', actualQty: 14, predictedQty: 15, expectedQty: 15 }));
    expect(String(stored.items[0].salesItemId)).toBe(String(itemId));
    expect(String(stored.items[1].salesItemId)).toBe(String(otherId));
    expect(stored.items[1].predictedQty).toBe(2);
    const foreign = await Forecast.findById(untouched._id).lean();
    expect(foreign.items[0]).toEqual(expect.objectContaining({ itemName: oldForecastName, predictedQty: 1 }));
    expect(foreign.items[0].salesItemId).toBeUndefined();
  });

  it('retains canonical ownership when two legacy forecast lines are merged', async () => {
    const target = await request.post('/api/items').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cappuccino', category: 'coffee' });
    const source = await request.post('/api/items').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Capuccino', category: 'coffee' });
    expect(target.status).toBe(201);
    expect(source.status).toBe(201);
    const targetId = target.body.item._id;
    const sourceId = source.body.item._id;
    const yesterday = localDay(-1);
    await Transaction.create({
      cafeId: cafe._id, date: new Date(yesterday.getTime() + 9 * 3600 * 1000), hour: 9, dayOfWeek: 0, status: 'approved', total: 390,
      items: [
        { name: 'Capuccino', salesItemId: sourceId, quantity: 4, unitPrice: 30 },
        { name: 'Cappuccino', salesItemId: targetId, quantity: 9, unitPrice: 30 },
      ],
    });
    const before = await Forecast.create({
      cafeId: cafe._id, date: yesterday, generatedAt: new Date(), origin: 'live', signals: quietSignals,
      items: [{ itemName: 'Capuccino', predictedQty: 5, expectedQty: 5 }, { itemName: 'Cappuccino', predictedQty: 10, expectedQty: 10 }],
      forecastCoverage: { itemCount: 2, storedItemCount: 2, totalPredictedQty: 15, includesAllRevenue: true },
      totalPredictedRevenue: 450, actualRevenue: 390, actualsUpdatedAt: new Date(), accuracy: 84.6,
    });
    const merged = await request.post(`/api/items/${sourceId}/resolve`).set('Authorization', `Bearer ${token}`)
      .send({ action: 'map_to', targetItemId: targetId });
    expect(merged.status).toBe(200);
    await forecastService._test.waitForMenuRefresh(cafe._id);

    const stored = await Forecast.findById(before._id).lean();
    expect(stored.items.find((line) => String(line.salesItemId) === String(targetId)).actualQty).toBe(13);
    expect(stored.items.find((line) => String(line.salesItemId) === String(sourceId)).actualQty).toBeNull();
    expect(stored.items.map((line) => line.expectedQty)).toEqual([5, 10]);
    expect(stored.calibrationExcluded).toBe(true);
  });

  it.each(['rename', 'merge'])('keeps another item canonical name ahead of a clashing alias during a %s', async (action) => {
    const auth = { Authorization: `Bearer ${token}` };
    const latte = await request.post('/api/items').set(auth).send({ name: 'Latte', category: 'coffee' });
    const flat = await request.post('/api/items').set(auth)
      .send({ name: 'flat white', aliases: ['Latte'], category: 'coffee' });
    expect(latte.status).toBe(201);
    expect(flat.status).toBe(201);
    const latteId = latte.body.item._id;
    const flatId = flat.body.item._id;
    const yesterday = localDay(-1);
    await Transaction.create({
      cafeId: cafe._id, date: new Date(yesterday.getTime() + 10 * 3600 * 1000), hour: 10, dayOfWeek: 0,
      status: 'approved', total: 630,
      items: [
        { name: 'flat white', salesItemId: flatId, quantity: 14, unitPrice: 30 },
        { name: 'Latte', salesItemId: latteId, quantity: 7, unitPrice: 30 },
      ],
    });
    const forecast = await Forecast.create({
      cafeId: cafe._id, date: yesterday, generatedAt: new Date(), origin: 'live', signals: quietSignals,
      items: [{ itemName: 'flat white', predictedQty: 15, expectedQty: 15 }, { itemName: 'Latte', predictedQty: 8, expectedQty: 8 }],
      forecastCoverage: { itemCount: 2, storedItemCount: 2, totalPredictedQty: 23, includesAllRevenue: true },
      totalPredictedRevenue: 690, actualRevenue: 630, actualsUpdatedAt: new Date(), accuracy: 90,
    });
    let ownerId = flatId;
    let ownerName = 'Flat White';
    if (action === 'rename') { // static-checks: allow conditional-expect it.each row: rename and merge take different requests
      expect((await request.put(`/api/items/${flatId}`).set(auth).send({ name: ownerName })).status).toBe(200);
    } else { // static-checks: allow conditional-expect the merge half of the it.each row above
      const target = await request.post('/api/items').set(auth).send({ name: 'White coffee', category: 'coffee' });
      expect(target.status).toBe(201);
      ownerId = target.body.item._id;
      ownerName = 'White coffee';
      expect((await request.post(`/api/items/${flatId}/resolve`).set(auth)
        .send({ action: 'map_to', targetItemId: ownerId })).status).toBe(200);
    }
    await forecastService._test.waitForMenuRefresh(cafe._id);

    const stored = await Forecast.findById(forecast._id).lean();
    expect(stored.items[1]).toEqual(expect.objectContaining({ itemName: 'Latte', actualQty: 7, predictedQty: 8, expectedQty: 8 }));
    expect(String(stored.items[1].salesItemId)).toBe(latteId);
    expect(stored.items[0]).toEqual(expect.objectContaining({ itemName: ownerName, actualQty: 14, predictedQty: 15, expectedQty: 15 }));
    // A merge with no separate target line retains the source identity and follows its canonical target for actuals.
    expect(String(stored.items[0].salesItemId)).toBe(flatId);
    expect(stored.calibrationExcluded).not.toBe(true);
    const sales = await Transaction.findOne({ cafeId: cafe._id }).lean();
    expect(sales.items.find((line) => String(line.salesItemId) === latteId).quantity).toBe(7);
    expect(sales.items.find((line) => String(line.salesItemId) === ownerId).quantity).toBe(14);
  });

  it('replaces a raw legacy generation that has no inputsVersion', async () => {
    const target = localDay(2);
    await Forecast.collection.insertOne({
      cafeId: cafe._id, date: target, generatedAt: new Date(0), origin: 'live', modelVersion: 'legacy', items: [], totalPredictedRevenue: 1,
    });
    expect((await Forecast.collection.findOne({ cafeId: cafe._id, date: target })).inputsVersion).toBeUndefined();
    const generated = await forecastService.generateForecast(cafe._id, target, { origin: 'live' });
    const stored = await Forecast.collection.find({ cafeId: cafe._id, date: target }).toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0].modelVersion).toBe(forecastService.FORECAST_MODEL_VERSION);
    expect(String(generated._id)).toBe(String(stored[0]._id));
  });

  it('bumps the forecast inputs version on every invalidation path', async () => {
    const version = async () => (await Cafe.findById(cafe._id).lean()).forecastInputsVersion;
    const auth = { Authorization: `Bearer ${token}` };

    await request.put('/api/forecasts/factors').set(auth).send({ settings: { weather: { hotTemp: 28 } } });
    expect(await version()).toBe(1);
    await request.post('/api/events').set(auth).send({ name: 'Market', date: zonedDateKey(localDay(3), TZ) });
    expect(await version()).toBe(2);
    const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: true, openTime: '07:00', closeTime: '17:00' }));
    await request.put('/api/cafe/me').set(auth).send({ tradingHours: hours });
    expect(await version()).toBe(3);
  });
});
