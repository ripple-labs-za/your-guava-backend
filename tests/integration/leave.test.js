const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Leave API', () => {
  let ownerToken;
  let ownerUser;
  let staffId;

  beforeEach(async () => {
    const testUser = await createTestUser();
    ownerToken = testUser.token;
    ownerUser = testUser.user;

    // Create a staff member
    const staffRes = await request
      .post('/api/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Leave Staff', hourlyRate: 55, role: 'barista' });

    staffId = staffRes.body.staff._id;
  });

  describe('POST /api/leave', () => {
    it('submits a leave request', async () => {
      const res = await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          staffId,
          type: 'annual',
          startDate: '2026-04-06',
          endDate: '2026-04-10',
          reason: 'Family vacation',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.leaveRequest).toBeDefined();
      expect(res.body.leaveRequest.type).toBe('annual');
      expect(res.body.leaveRequest.status).toBe('pending');
      expect(res.body.leaveRequest.days).toBe(4); // Mon-Fri, less Family Day (6 April 2026)
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ staffId });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when endDate is before startDate', async () => {
      const res = await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          staffId,
          type: 'annual',
          startDate: '2026-04-10',
          endDate: '2026-04-06',
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 for an unsupported leave type', async () => {
      const res = await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          staffId,
          type: 'vacation',
          startDate: '2026-04-06',
          endDate: '2026-04-07',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/type must be/i);
    });
  });

  describe('GET /api/leave', () => {
    it('lists leave requests', async () => {
      // Create a request
      await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          staffId,
          type: 'annual',
          startDate: '2026-04-06',
          endDate: '2026-04-10',
        });

      const res = await request
        .get('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.leaveRequests).toBeDefined();
      expect(res.body.leaveRequests.length).toBe(1);
    });
  });

  describe('PUT /api/leave/:id/approve', () => {
    it('approves a leave request (owner only)', async () => {
      const createRes = await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          staffId,
          type: 'annual',
          startDate: '2026-04-06',
          endDate: '2026-04-10',
        });

      const leaveId = createRes.body.leaveRequest._id;

      const res = await request
        .put(`/api/leave/${leaveId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.leaveRequest.status).toBe('approved');
    });

    it('manager cannot approve leave (403)', async () => {
      const cafeId = ownerUser.activeCafeId;
      const manager = await createTestManager(ownerToken, [cafeId]);

      const createRes = await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          staffId,
          type: 'annual',
          startDate: '2026-04-06',
          endDate: '2026-04-10',
        });

      const leaveId = createRes.body.leaveRequest._id;

      const res = await request
        .put(`/api/leave/${leaveId}/approve`)
        .set('Authorization', `Bearer ${manager.token}`);

      expect(res.status).toBe(403);
    });

    it('allows only one concurrent approval and deducts the balance once', async () => {
      const createRes = await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          staffId,
          type: 'annual',
          startDate: '2026-04-06',
          endDate: '2026-04-10',
        });
      const leaveId = createRes.body.leaveRequest._id;

      const responses = await Promise.all([
        request.put(`/api/leave/${leaveId}/approve`).set('Authorization', `Bearer ${ownerToken}`),
        request.put(`/api/leave/${leaveId}/approve`).set('Authorization', `Bearer ${ownerToken}`),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

      const balances = await request
        .get('/api/leave/balances')
        .set('Authorization', `Bearer ${ownerToken}`)
        .query({ onDate: '2026-04-06' });
      expect(balances.body.balances[0].annual.used).toBe(4);
    });
  });

  describe('PUT /api/leave/:id/reject', () => {
    it('rejects a leave request (owner only)', async () => {
      const createRes = await request
        .post('/api/leave')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          staffId,
          type: 'sick',
          startDate: '2026-04-06',
          endDate: '2026-04-07',
        });

      const leaveId = createRes.body.leaveRequest._id;

      const res = await request
        .put(`/api/leave/${leaveId}/reject`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.leaveRequest.status).toBe('rejected');
    });
  });

  describe('GET /api/leave/balances', () => {
    it('returns leave balances for active staff', async () => {
      const res = await request
        .get('/api/leave/balances')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.balances).toBeDefined();
      expect(Array.isArray(res.body.balances)).toBe(true);
      // We created 1 active staff
      expect(res.body.balances.length).toBe(1);
      expect(res.body.balances[0].annual).toBeDefined();
      expect(res.body.balances[0].annual.total).toBe(15);
    });
  });
});
