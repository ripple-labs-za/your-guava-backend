const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Event = require('../../src/models/Event.model');
const Organization = require('../../src/models/Organization.model');
const Transaction = require('../../src/models/Transaction.model');
const { generateForecast } = require('../../src/services/forecast.service');
const { addZonedDays, zonedDayStart, zonedDateKey } = require('../../src/utils/timezone');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const openAllWeek = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: true, openTime: '08:00', closeTime: '16:00' }));
const sale = (cafeId, isoInstant, total) => ({
  cafeId, date: new Date(isoInstant), status: 'approved', total, items: [{ name: 'Flat White', quantity: total / 50, unitPrice: 50 }],
});

describe('events', () => {
  let token;
  let user;
  let cafe;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    ({ token, user } = await createTestUser());
    cafe = await Cafe.findOne({});
  });

  it('keeps past recurring events removable with their next valid anniversary', async () => {
    await Event.create([
      { cafeId: cafe._id, name: 'Annual market', date: new Date('2024-12-24'), recurring: true },
      { cafeId: cafe._id, name: 'Leap market', date: new Date('2024-02-29'), recurring: true },
      { cafeId: cafe._id, name: 'Old one-off', date: new Date('2024-12-24') },
    ]);
    await Event.collection.insertOne({ cafeId: cafe._id, name: 'Legacy future', date: new Date('2099-05-10'), type: 'event' });
    const foreign = await createTestUser({ email: 'foreign-recurring@example.test', cafeName: 'Other' });
    await Event.create({ cafeId: foreign.user.activeCafeId, name: 'Other annual', date: new Date('2024-12-24'), recurring: true });
    const res = await request.get('/api/events').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.events.map((event) => event.name).sort()).toEqual(['Annual market', 'Leap market', 'Legacy future']);
    const today = zonedDateKey(new Date(), cafe.timezone);
    const year = Number(today.slice(0, 4));
    const annual = res.body.events.find((event) => event.name === 'Annual market');
    expect(annual.nextDateKey).toBe(`${today <= `${year}-12-24` ? year : year + 1}-12-24`);
    const leap = res.body.events.find((event) => event.name === 'Leap market');
    expect(leap.nextDateKey >= today).toBe(true);
    expect(Number(leap.nextDateKey.slice(0, 4)) % 4).toBe(0);
    const bounded = await request.get('/api/events').set(auth()).query({ from: '2099-05-10', to: '2099-05-10' });
    expect(bounded.body.events.map((event) => event.name)).toEqual(['Legacy future']);
  });

  it('scores mixed legacy and keyed event dates across the whole sales window', async () => {
    await Transaction.create(['2026-03-18', '2026-03-25', '2026-04-01', '2026-04-08',
      '2026-04-29', '2026-05-06', '2026-05-13', '2026-05-20'].map((key) =>
      sale(cafe._id, `${key}T09:00:00Z`, ['2026-04-08', '2026-05-20'].includes(key) ? 1500 : 1000)));
    await Event.collection.insertOne({ cafeId: cafe._id, name: 'Legacy later', type: 'event', date: new Date('2026-05-20') });
    await request.post('/api/events').set(auth()).send({ name: 'Keyed earlier', date: '2026-04-08' });
    const res = await request.get('/api/events/effects').set(auth()).query({ from: '2026-03-01', to: '2026-06-01', baselineWeeks: 3 });
    expect(res.status).toBe(200);
    expect(res.body.effects.map((event) => event.name)).toEqual(['Legacy later', 'Keyed earlier']);
    expect(res.body.effects.map((event) => event.dateKey)).toEqual(['2026-05-20', '2026-04-08']);
    expect(res.body.effects.every((event) => event.revenueImpactPct === 50 && event.baselineDayCount === 3)).toBe(true);
  });

  it('excludes recurring anniversaries from another event normal days', async () => {
    await Transaction.create(['2025-12-03', '2025-12-10', '2025-12-17', '2025-12-24', '2025-12-31']
      .map((key) => sale(cafe._id, `${key}T09:00:00Z`, key === '2025-12-24' ? 5000 : key === '2025-12-31' ? 2000 : 1000)));
    await request.post('/api/events').set(auth()).send({ name: 'Annual Xmas', date: '2024-12-24', recurring: true });
    await request.post('/api/events').set(auth()).send({ name: 'NYE', date: '2025-12-31' });
    const res = await request.get('/api/events/effects').set(auth()).query({ from: '2025-12-30', to: '2025-12-31', baselineWeeks: 4 });
    expect(res.body.effects[0]).toEqual(expect.objectContaining({ name: 'NYE', baselineRevenue: 1000, baselineDayCount: 3, revenueImpactPct: 100 }));
  });

  it('returns no scored events for a valid today-only range', async () => {
    const today = zonedDateKey(new Date(), cafe.timezone);
    const res = await request.get('/api/events/effects').set(auth()).query({ from: today, to: today });
    expect(res.status).toBe(200);
    expect(res.body.effects).toEqual([]);
    expect((await request.get('/api/events/effects').set(auth()).query({ from: '2031-01-02', to: '2031-01-01' })).status).toBe(400);
  });

  it('closes Sunday, not Saturday, for a cafe at UTC−5', async () => {
    const zone = 'America/Bogota'; // UTC−5 all year, no daylight saving
    await Cafe.updateOne({ _id: cafe._id }, { $set: { timezone: zone, tradingHours: openAllWeek } });
    const created = await request.post('/api/events').set(auth())
      .send({ name: 'Family day', date: '2031-03-16', type: 'closure' });
    expect(created.status).toBe(201);

    const sunday = (await generateForecast(cafe._id, zonedDayStart('2031-03-16', zone))).toObject();
    const saturday = (await generateForecast(cafe._id, zonedDayStart('2031-03-15', zone))).toObject();

    expect(sunday.availability).toEqual(expect.objectContaining({ status: 'closed' }));
    expect(sunday.availability.reason).toMatch(/Family day/);
    expect(saturday.availability.status).not.toBe('closed');
    expect(saturday.signals.events).toEqual([]);
  });

  it('stores the calendar day the owner typed, and moves it with the date', async () => {
    const created = await request.post('/api/events').set(auth()).send({ name: 'Market', date: '2031-03-16' });
    expect(created.body.event.dateKey).toBe('2031-03-16');

    const moved = await request.put(`/api/events/${created.body.event._id}`).set(auth()).send({ date: '2031-03-23' });
    expect(moved.body.event.dateKey).toBe('2031-03-23');
  });

  it('applies a recurring event on its anniversary, and only a recurring one', async () => {
    await Organization.findByIdAndUpdate(user.orgId, { plan: 'growth' });
    await request.post('/api/events').set(auth())
      .send({ name: 'Christmas Eve market', date: '2030-12-24', impactPct: 40, recurring: true });
    await request.post('/api/events').set(auth())
      .send({ name: 'One-off fair', date: '2030-12-24', impactPct: 90, recurring: false });
    const zone = cafe.timezone;

    const eve = (await generateForecast(cafe._id, zonedDayStart('2031-12-24', zone))).toObject();
    const christmas = (await generateForecast(cafe._id, zonedDayStart('2031-12-25', zone))).toObject();

    expect(eve.signals.events.map((event) => event.name)).toEqual(['Christmas Eve market']);
    expect(eve.factors.find((factor) => factor.key === 'events')).toEqual(expect.objectContaining({ active: true, adjustmentPct: 40 }));
    expect(christmas.signals.events).toEqual([]);
  });

  it('does not score an event day without sales, and does not list closures', async () => {
    await Organization.findByIdAndUpdate(user.orgId, { plan: 'growth' });
    await Transaction.create([
      sale(cafe._id, '2026-04-01T09:00:00.000Z', 1000),
      sale(cafe._id, '2026-04-08T09:00:00.000Z', 1000),
      sale(cafe._id, '2026-04-15T09:00:00.000Z', 1000),
      sale(cafe._id, '2026-04-22T09:00:00.000Z', 1500),
    ]);
    await request.post('/api/events').set(auth()).send({ name: 'Market Day', date: '2026-04-22', impact: 'high' });
    await request.post('/api/events').set(auth()).send({ name: 'Rained-out fair', date: '2026-04-29', impact: 'high' });
    await request.post('/api/events').set(auth()).send({ name: 'Stocktake', date: '2026-04-30', type: 'closure' });

    const res = await request.get('/api/events/effects').set(auth()).query({ from: '2026-04-01', to: '2026-04-30', baselineWeeks: 4 });

    expect(res.status).toBe(200);
    expect(res.body.effects.map((effect) => effect.name).sort()).toEqual(['Market Day', 'Rained-out fair']);
    const fair = res.body.effects.find((effect) => effect.name === 'Rained-out fair');
    expect(fair).toEqual(expect.objectContaining({ revenueImpactPct: null, vsExpectedPct: null, confidence: 'none', dateKey: '2026-04-29' }));
    // The fair's missing upload used to count as -100% and drag the average from +50% to -25%.
    expect(res.body.summary).toEqual(expect.objectContaining({ avgRevenueImpactPct: 50, belowExpected: 0, insufficientData: 1 }));
  });

  it('compares effects with what the plan let the forecast apply', async () => {
    await Transaction.create([
      sale(cafe._id, '2026-04-01T09:00:00.000Z', 1000),
      sale(cafe._id, '2026-04-08T09:00:00.000Z', 1000),
      sale(cafe._id, '2026-04-15T09:00:00.000Z', 1000),
      sale(cafe._id, '2026-04-22T09:00:00.000Z', 1500),
    ]);
    await request.post('/api/events').set(auth()).send({ name: 'Market Day', date: '2026-04-22', impact: 'high' });
    const query = { from: '2026-04-01', to: '2026-04-30', baselineWeeks: 4 };

    const starter = (await request.get('/api/events/effects').set(auth()).query(query)).body.effects[0];
    expect(starter).toEqual(expect.objectContaining({
      expectedApplied: false,
      expectedImpactPct: 0,
      expectedNote: 'Local events are not applied to forecasts on the Starter plan.',
      vsExpectedPct: 50,
    }));

    await Organization.findByIdAndUpdate(user.orgId, { plan: 'growth' });
    const growth = (await request.get('/api/events/effects').set(auth()).query(query)).body.effects[0];
    expect(growth).toEqual(expect.objectContaining({ expectedApplied: true, expectedImpactPct: 35, expectedNote: null, vsExpectedPct: 15 }));
  });

  it('does not score today, which has no complete sales yet', async () => {
    const todayKey = zonedDateKey(new Date(), cafe.timezone);
    await request.post('/api/events').set(auth()).send({ name: 'Today market', date: todayKey });

    const res = await request.get('/api/events/effects').set(auth()).query({ to: todayKey });

    expect(res.body.effects.map((effect) => effect.name)).not.toContain('Today market');
  });

  it('clears a custom impact so the preset applies again', async () => {
    const created = await request.post('/api/events').set(auth()).send({ name: 'Derby', date: '2031-05-10', impact: 'high', impactPct: 45 });

    const cleared = await request.put(`/api/events/${created.body.event._id}`).set(auth()).send({ impactPct: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.event.impactPct).toBeUndefined();
    expect((await Event.findById(created.body.event._id).lean()).impactPct).toBeUndefined();
    const stored = await Event.findById(created.body.event._id).lean();
    expect(stored.dateKey).toBe('2031-05-10');
    expect(stored.date.toISOString()).toBe('2031-05-10T00:00:00.000Z');
    expect(stored.type).toBe('event');
  });

  it('removes the closure window when a partial closure becomes an event', async () => {
    const created = await request.post('/api/events').set(auth()).send({
      name: 'Plumber', date: '2031-05-10', type: 'partial_closure', closureWindow: { startTime: '07:00', endTime: '10:00' },
    });

    const changed = await request.put(`/api/events/${created.body.event._id}`).set(auth()).send({ type: 'event' });

    expect(changed.status).toBe(200);
    expect((await Event.findById(created.body.event._id).lean()).closureWindow).toBeUndefined();
  });

  it('expands across New Year once and skips February 29 in non-leap years', async () => {
    const { loadEventsByDateKey } = require('../../src/services/forecast/history');
    await Event.create([
      { cafeId: cafe._id, name: 'Annual market', date: new Date('2030-12-24T00:00:00Z'), recurring: true },
      { cafeId: cafe._id, name: 'Leap market', date: new Date('2028-02-29T00:00:00Z'), recurring: true },
      { cafeId: cafe._id, name: 'First occurrence', date: new Date('2032-01-02T00:00:00Z'), recurring: true },
    ]);
    const events = await loadEventsByDateKey(cafe._id, '2031-11-01', '2032-03-01', cafe.timezone);
    expect([...events.keys()].sort()).toEqual(['2031-12-24', '2032-01-02', '2032-02-29']);
    expect([...events.values()].every((rows) => rows.length === 1)).toBe(true);
    expect((await loadEventsByDateKey(cafe._id, '2033-02-01', '2033-03-01', cafe.timezone)).size).toBe(0);
  });

  it.each(['false', 1, null])('rejects non-boolean recurrence %p on create and update', async (recurring) => {
    const created = await request.post('/api/events').set(auth()).send({ name: 'Market', date: '2031-05-10' });
    expect((await request.post('/api/events').set(auth()).send({ name: 'Invalid market', date: '2031-05-10', recurring })).status).toBe(400);
    expect((await request.put(`/api/events/${created.body.event._id}`).set(auth()).send({ recurring })).status).toBe(400);
    expect((await Event.findById(created.body.event._id).lean()).recurring).toBe(false);
  });

  it('reads a migrated local-instant boundary by its key and uses only the current org plan', async () => {
    const foreign = await createTestUser({ email: 'foreign-event-plan@example.test', cafeName: 'Foreign events' });
    await Organization.findByIdAndUpdate(foreign.user.orgId, { plan: 'growth' });
    await Transaction.create([
      sale(cafe._id, '2026-04-01T09:00:00Z', 1000), sale(cafe._id, '2026-04-08T09:00:00Z', 1000),
      sale(cafe._id, '2026-04-15T09:00:00Z', 1000), sale(cafe._id, '2026-04-22T09:00:00Z', 1500),
    ]);
    await Event.collection.insertOne({ cafeId: cafe._id, name: 'Migrated market', type: 'event', impact: 'high',
      date: new Date('2026-04-21T22:00:00Z'), dateKey: '2026-04-22' });
    const listed = await request.get('/api/events').set(auth()).query({ from: '2026-04-22', to: '2026-04-22' });
    expect(listed.body.events.map((event) => event.name)).toEqual(['Migrated market']);
    const query = { from: '2026-04-22', to: '2026-04-22', orgId: String(foreign.user.orgId), baselineWeeks: 3 };
    const starter = await request.get('/api/events/effects').set(auth()).query(query);
    expect(starter.body.effects[0]).toEqual(expect.objectContaining({ dateKey: '2026-04-22', revenueImpactPct: 50,
      expectedApplied: false, expectedImpactPct: 0 }));
    await Organization.findByIdAndUpdate(user.orgId, { plan: 'growth' });
    await Cafe.updateOne({ _id: cafe._id }, { $set: { 'forecastSettings.events.enabled': false } });
    const disabled = await request.get('/api/events/effects').set(auth()).query({ ...query, baselineWeeks: 16 });
    expect(disabled.body.effects[0]).toEqual(expect.objectContaining({ expectedApplied: false,
      expectedNote: 'The events factor is switched off in Factors.' }));
  });
});
