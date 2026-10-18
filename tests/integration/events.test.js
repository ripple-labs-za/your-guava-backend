const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Events API', () => {
  let token;
  let user;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
    user = testUser.user;
  });

  describe('POST /api/events', () => {
    it('creates an event', async () => {
      const res = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Jazz Night',
          date: '2026-04-15',
          impact: 'high',
          impactPct: 45,
          notes: 'Live music event',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.event).toBeDefined();
      expect(res.body.event.name).toBe('Jazz Night');
      expect(res.body.event.impact).toBe('high');
      expect(res.body.event.impactPct).toBe(45);
    });

    it('returns 400 when impactPct is outside the supported range', async () => {
      const res = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Bad Signal', date: '2026-04-15', impactPct: 250 });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/impactPct/i);
    });

    it('returns 400 when name or date is missing', async () => {
      const res = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ impact: 'low' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects impossible calendar dates and reversed partial closures', async () => {
      const badDate = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Impossible', date: '2026-02-30' });
      expect(badDate.status).toBe(400);

      const badClosure = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Bad closure',
          date: '2026-04-15',
          type: 'partial_closure',
          closureWindow: { startTime: '15:00', endTime: '09:00' },
        });
      expect(badClosure.status).toBe(400);
      expect(badClosure.body.message).toMatch(/after startTime/i);
    });

    it('invalidates existing planning forecasts for the event date', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const target = new Date();
      target.setDate(target.getDate() + 2);
      target.setHours(0, 0, 0, 0);
      const stale = await Forecast.create({
        cafeId: user.activeCafeId,
        date: target,
        generatedAt: new Date(),
        items: [],
        signals: {
          weather: { temp: 20, condition: 'clear', humidity: 60 },
          loadSheddingStage: 0,
          isPublicHoliday: false,
          isSchoolHoliday: false,
          isPayday: false,
          dayOfWeek: target.getDay(),
          events: [],
        },
        totalPredictedRevenue: 123,
      });

      const res = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Market Day',
          date: target.toISOString().slice(0, 10),
          impact: 'high',
        });

      expect(res.status).toBe(201);
      expect(await Forecast.findById(stale._id)).toBeNull();
    });
  });

  describe('GET /api/events', () => {
    it('lists events for the cafe', async () => {
      // Create some events
      await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Event 1', date: '2026-12-01', impact: 'low' });

      await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Event 2', date: '2026-12-15', impact: 'high' });

      const res = await request
        .get('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-12-01', to: '2026-12-31' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.events.length).toBe(2);
    });
  });

  describe('GET /api/events/effects', () => {
    it('compares event-day sales against comparable non-event weekdays', async () => {
      await require('../../src/models/Organization.model').findByIdAndUpdate(user.orgId, { plan: 'growth' });
      const eventDate = new Date('2026-04-22T09:00:00.000Z');
      const baselineDates = [
        '2026-04-01T09:00:00.000Z',
        '2026-04-08T09:00:00.000Z',
        '2026-04-15T09:00:00.000Z',
      ];

      await Transaction.create([
        ...baselineDates.map((date, index) => ({
          cafeId: user.activeCafeId,
          receiptId: `base-${index}`,
          date: new Date(date),
          total: 1000,
          status: 'approved',
          items: [{ name: 'Flat White', quantity: 20, unitPrice: 50 }],
        })),
        {
          cafeId: user.activeCafeId,
          receiptId: 'event-day',
          date: eventDate,
          total: 1500,
          status: 'approved',
          items: [{ name: 'Flat White', quantity: 30, unitPrice: 50 }],
        },
      ]);

      await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Market Day', date: '2026-04-22', impact: 'high' });

      const res = await request
        .get('/api/events/effects')
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-04-01', to: '2026-04-30', baselineWeeks: 4 });

      expect(res.status).toBe(200);
      expect(res.body.effects).toHaveLength(1);
      expect(res.body.effects[0]).toMatchObject({
        name: 'Market Day',
        actualRevenue: 1500,
        baselineRevenue: 1000,
        baselineDayCount: 3,
        revenueImpactPct: 50,
        expectedImpactPct: 35,
        vsExpectedPct: 15,
        confidence: 'low',
      });
      expect(res.body.summary.avgRevenueImpactPct).toBe(50);
      expect(res.body.summary.aboveExpected).toBe(1);
    });
  });

  describe('DELETE /api/events/:id', () => {
    it('deletes an event', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const eventDate = new Date();
      eventDate.setDate(eventDate.getDate() + 3);
      eventDate.setHours(0, 0, 0, 0);
      const createRes = await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'To Delete', date: eventDate.toISOString().slice(0, 10) });

      const eventId = createRes.body.event._id;
      const target = new Date(createRes.body.event.date);
      target.setHours(0, 0, 0, 0);
      const stale = await Forecast.create({
        cafeId: user.activeCafeId,
        date: target,
        generatedAt: new Date(),
        items: [],
        signals: {
          weather: { temp: 20, condition: 'clear', humidity: 60 },
          loadSheddingStage: 0,
          isPublicHoliday: false,
          isSchoolHoliday: false,
          isPayday: false,
          dayOfWeek: target.getDay(),
          events: [],
        },
        totalPredictedRevenue: 123,
      });

      const res = await request
        .delete(`/api/events/${eventId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/deleted/i);
      expect(await Forecast.findById(stale._id)).toBeNull();
    });

    it('returns 404 for non-existent event', async () => {
      const fakeId = '507f1f77bcf86cd799439011';
      const res = await request
        .delete(`/api/events/${fakeId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('Event scoping', () => {
    it('user A cannot see user B events', async () => {
      // User A creates an event
      await request
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'User A Event', date: '2026-06-01' });

      // Create User B
      const userB = await createTestUser({ email: 'userb@yourguava.com', cafeName: 'Cafe B' });

      // User B should not see User A's events
      const res = await request
        .get('/api/events')
        .set('Authorization', `Bearer ${userB.token}`)
        .query({ from: '2026-06-01', to: '2026-06-30' });

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBe(0);
    });
  });
});
