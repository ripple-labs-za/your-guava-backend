const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Cafe API', () => {
  let token;
  let user;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
    user = testUser.user;
  });

  describe('GET /api/cafe/me', () => {
    it('returns current cafe details', async () => {
      const res = await request
        .get('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe).toBeDefined();
      expect(res.body.cafe.name).toBe('Test Cafe');
    });
  });

  describe('PUT /api/cafe/me', () => {
    it('updates cafe name', async () => {
      const res = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Cafe Name' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe.name).toBe('Updated Cafe Name');
    });

    it('updates cafe location', async () => {
      const res = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: { address: '123 Main St', city: 'Cape Town' } });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe.location.city).toBe('Cape Town');
    });

    it('validates coordinates and preserves them during address-only edits', async () => {
      const coordinates = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: { lat: -33.9249, lng: 18.4241 } });
      expect(coordinates.status).toBe(200);
      expect(coordinates.body.cafe.location).toMatchObject({
        lat: -33.9249,
        lng: 18.4241,
      });

      const addressOnly = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: { address: 'Updated address' } });
      expect(addressOnly.status).toBe(200);
      expect(addressOnly.body.cafe.location).toMatchObject({
        address: 'Updated address',
        lat: -33.9249,
        lng: 18.4241,
      });

      const partial = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: { lat: -33.9 } });
      expect(partial.status).toBe(400);

      const outOfRange = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ location: { lat: -33.9, lng: 181 } });
      expect(outOfRange.status).toBe(400);
    });
  });

  describe('Trading hours', () => {
    it('says whether the trading hours were ever saved', async () => {
      const before = await request.get('/api/cafe/me').set('Authorization', `Bearer ${token}`);
      expect(before.body.cafe.tradingHoursSaved).toBe(false);

      const week = before.body.cafe.tradingHours.map((day) => ({ ...day, isOpen: true }));
      await request.put('/api/cafe/me').set('Authorization', `Bearer ${token}`).send({ tradingHours: week });

      const after = await request.get('/api/cafe/me').set('Authorization', `Bearer ${token}`);
      expect(after.body.cafe.tradingHoursSaved).toBe(true);
    });
    
    it('returns sensible default trading hours when none are set', async () => {
      const res = await request
        .get('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.cafe.tradingHours)).toBe(true);
      expect(res.body.cafe.tradingHours).toHaveLength(7);
      const monday = res.body.cafe.tradingHours.find((d) => d.dayOfWeek === 1);
      expect(monday).toMatchObject({ isOpen: true, openTime: '07:00', closeTime: '17:00' });
      const sunday = res.body.cafe.tradingHours.find((d) => d.dayOfWeek === 0);
      expect(sunday.isOpen).toBe(false);
    });

    it('persists trading hours via PUT and returns the updated week', async () => {
      const tradingHours = [
        { dayOfWeek: 0, isOpen: false, openTime: '08:00', closeTime: '14:00' },
        { dayOfWeek: 1, isOpen: true, openTime: '06:30', closeTime: '18:00' },
        { dayOfWeek: 2, isOpen: true, openTime: '06:30', closeTime: '18:00' },
        { dayOfWeek: 3, isOpen: true, openTime: '06:30', closeTime: '18:00' },
        { dayOfWeek: 4, isOpen: true, openTime: '06:30', closeTime: '18:00' },
        { dayOfWeek: 5, isOpen: true, openTime: '06:30', closeTime: '20:00' },
        { dayOfWeek: 6, isOpen: true, openTime: '08:00', closeTime: '16:00' },
      ];

      const res = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ tradingHours });

      expect(res.status).toBe(200);
      expect(res.body.cafe.tradingHours).toHaveLength(7);
      expect(res.body.cafe.tradingHours.find((d) => d.dayOfWeek === 1)).toMatchObject({
        isOpen: true,
        openTime: '06:30',
        closeTime: '18:00',
      });
      expect(res.body.cafe.tradingHours.find((d) => d.dayOfWeek === 0).isOpen).toBe(false);
    });

    it('rejects an open day where closeTime is not after openTime', async () => {
      const tradingHours = [
        { dayOfWeek: 0, isOpen: false, openTime: '08:00', closeTime: '14:00' },
        { dayOfWeek: 1, isOpen: true, openTime: '17:00', closeTime: '17:00' },
        { dayOfWeek: 2, isOpen: true, openTime: '07:00', closeTime: '17:00' },
        { dayOfWeek: 3, isOpen: true, openTime: '07:00', closeTime: '17:00' },
        { dayOfWeek: 4, isOpen: true, openTime: '07:00', closeTime: '17:00' },
        { dayOfWeek: 5, isOpen: true, openTime: '07:00', closeTime: '17:00' },
        { dayOfWeek: 6, isOpen: true, openTime: '08:00', closeTime: '15:00' },
      ];

      const res = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ tradingHours });

      expect(res.status).toBe(400);
    });
  });

  describe('Manager access', () => {
    it('blocks managers from updating the cafe but still lets them read it', async () => {
      const manager = await createTestManager(token, [user.activeCafeId]);

      const res = await request
        .put('/api/cafe/me')
        .set('Authorization', `Bearer ${manager.token}`)
        .send({ name: 'Hijacked Cafe', location: { lat: -26.2, lng: 28.04 } });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, message: 'Insufficient permissions' });

      const me = await request
        .get('/api/cafe/me')
        .set('Authorization', `Bearer ${manager.token}`);
      expect(me.status).toBe(200);
      expect(me.body.cafe.name).toBe('Test Cafe');

      const list = await request
        .get('/api/cafe/list')
        .set('Authorization', `Bearer ${manager.token}`);
      expect(list.status).toBe(200);
      expect(list.body.cafes).toHaveLength(1);
    });
  });

  describe('GET /api/cafe/list', () => {
    it('owner sees all org cafes', async () => {
      const res = await request
        .get('/api/cafe/list')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cafes).toBeDefined();
      expect(Array.isArray(res.body.cafes)).toBe(true);
      expect(res.body.cafes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
