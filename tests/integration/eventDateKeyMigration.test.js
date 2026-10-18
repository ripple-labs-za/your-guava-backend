const { setup, teardown, clearDB, createTestUser } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Event = require('../../src/models/Event.model');
const { backfillEventDateKeys } = require('../../src/migrations/backfill-event-date-keys');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

it('gives every legacy event the calendar day it meant, once', async () => {
  await createTestUser();
  await createTestUser({ email: 'bogota@yourguava.com', cafeName: 'Cafe Bogota' });
  const [johannesburg, bogota] = await Cafe.find({}).sort({ createdAt: 1 }).lean();
  await Cafe.updateOne({ _id: bogota._id }, { $set: { timezone: 'America/Bogota' } });
  // Raw inserts: no pre-validate hook, like rows written before dateKey existed.
  await Event.collection.insertMany([
    { cafeId: johannesburg._id, name: 'Nominal', type: 'event', date: new Date('2026-09-27T00:00:00.000Z') },
    { cafeId: johannesburg._id, name: 'Local instant', type: 'event', date: new Date('2026-09-26T22:00:00.000Z') },
    { cafeId: bogota._id, name: 'Bogota instant', type: 'event', date: new Date('2026-09-27T05:00:00.000Z') },
  ]);

  expect(await backfillEventDateKeys()).toEqual({ scanned: 3, updated: 0, wouldUpdate: 3 });
  expect(await Event.countDocuments({ dateKey: { $exists: true } })).toBe(0);

  expect(await backfillEventDateKeys({ apply: true })).toEqual({ scanned: 3, updated: 3, wouldUpdate: 3 });
  expect((await Event.find({}).lean()).map((event) => event.dateKey)).toEqual(['2026-09-27', '2026-09-27', '2026-09-27']);

  expect(await backfillEventDateKeys({ apply: true })).toEqual({ scanned: 0, updated: 0, wouldUpdate: 0 });
});

it('can confine local migration verification to one scratch cafe', async () => {
  await createTestUser();
  const cafe = await Cafe.findOne({});
  const other = await Cafe.create({ name: 'Other migration cafe', orgId: cafe.orgId, timezone: 'America/Bogota' });
  await Event.collection.insertMany([cafe, other].map((owner) => ({ cafeId: owner._id, name: 'Legacy day',
    date: new Date('2026-09-27T00:00:00Z'), type: 'event' })));
  expect(await backfillEventDateKeys({ apply: true, cafeId: cafe._id })).toEqual({ scanned: 1, updated: 1, wouldUpdate: 1 });
  expect((await Event.findOne({ cafeId: cafe._id }).lean()).dateKey).toBe('2026-09-27');
  expect((await Event.findOne({ cafeId: other._id }).lean()).dateKey).toBeUndefined();
  expect(await backfillEventDateKeys({ apply: true })).toEqual({ scanned: 1, updated: 1, wouldUpdate: 1 });
});
