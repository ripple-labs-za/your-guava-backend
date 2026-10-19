const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Shifts API', () => {
  let token;
  let staffId;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;

    // Create a staff member for shift tests
    const staffRes = await request
      .post('/api/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Shift Worker', hourlyRate: 55, role: 'barista' });

    staffId = staffRes.body.staff._id;
  });

  describe('pay data visibility', () => {
    // Staff reads already hide hourlyRate from managers; the roster and summary
    // endpoints populate it straight from the Staff document, which reopened the
    // same leak (and estimatedPay is the rate multiplied out).
    it('hides hourlyRate and estimatedPay from managers on week and summary, but not from owners', async () => {
      // Take the roster's own first day so the shift is guaranteed to fall
      // inside the window /week reports, whatever the local/UTC offset is.
      const emptyWeek = await request.get('/api/shifts/week').set('Authorization', `Bearer ${token}`);
      const date = emptyWeek.body.roster[0].date;
      await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({ staffId, date, startTime: '07:00', endTime: '15:00' })
        .expect(201);

      const cafeRes = await request.get('/api/cafe/me').set('Authorization', `Bearer ${token}`);
      const manager = await createTestManager(token, [cafeRes.body.cafe._id]);

      const ownerWeek = await request.get('/api/shifts/week').set('Authorization', `Bearer ${token}`);
      const ownerSummary = await request
        .get(`/api/shifts/summary?startDate=${date}&endDate=${date}`)
        .set('Authorization', `Bearer ${token}`);
      const managerWeek = await request.get('/api/shifts/week').set('Authorization', `Bearer ${manager.token}`);
      const managerSummary = await request
        .get(`/api/shifts/summary?startDate=${date}&endDate=${date}`)
        .set('Authorization', `Bearer ${manager.token}`);

      expect(ownerWeek.status).toBe(200);
      expect(JSON.stringify(ownerWeek.body)).toContain('"hourlyRate":55');
      expect(ownerSummary.body.summary[0].hourlyRate).toBe(55);
      expect(ownerSummary.body.summary[0].estimatedPay).toBe(440);

      expect(managerWeek.status).toBe(200);
      expect(JSON.stringify(managerWeek.body)).not.toContain('hourlyRate');
      expect(managerSummary.status).toBe(200);
      expect(managerSummary.body.summary[0].totalHours).toBe(8);
      expect(managerSummary.body.summary[0]).not.toHaveProperty('hourlyRate');
      expect(managerSummary.body.summary[0]).not.toHaveProperty('estimatedPay');
    });
  });

  describe('POST /api/shifts', () => {
    it('creates a shift', async () => {
      const res = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          staffId,
          date: '2026-04-06', // a Monday
          startTime: '07:00',
          endTime: '15:00',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.shift).toBeDefined();
      expect(res.body.shift.hoursWorked).toBe(8);
      expect(res.body.shift.type).toBe('regular');
    });

    it('returns 400 when required fields missing', async () => {
      const res = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({ staffId, date: '2026-04-06' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when the start and end times are the same', async () => {
      const res = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({ staffId, date: '2026-04-06', startTime: '07:00', endTime: '07:00' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SHIFT_TIMES');
    });

    it('flags overtime when exceeding 45 weekly hours', async () => {
      // Create shifts for Mon-Fri, 10 hrs each (= 50 hrs)
      const dates = ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'];
      let lastRes;
      for (const date of dates) {
        lastRes = await request
          .post('/api/shifts')
          .set('Authorization', `Bearer ${token}`)
          .send({
            staffId,
            date,
            startTime: '06:00',
            endTime: '16:00',
          });
      }

      // The 5th shift (total 50 hrs) should be flagged overtime
      expect(lastRes.body.shift.type).toBe('overtime');
      expect(lastRes.body.shift.regularHours).toBe(5);
      expect(lastRes.body.shift.overtimeHours).toBe(5);
    });

    it('rejects malformed dates and unbounded query ranges', async () => {
      const malformed = await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          staffId,
          date: '2026-02-30',
          startTime: '07:00',
          endTime: '15:00',
        });
      expect(malformed.status).toBe(400);

      const unbounded = await request
        .get('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2020-01-01', endDate: '2026-01-01' });
      expect(unbounded.status).toBe(400);
      expect(unbounded.body.message).toMatch(/cannot exceed/i);
    });
  });

  describe('Shift overlap detection', () => {
    const createShift = (body) =>
      request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({ staffId, date: '2026-09-07', ...body });

    it('rejects a shift that overlaps an existing shift for the same person on the same day', async () => {
      const first = await createShift({ startTime: '07:00', endTime: '15:00' });
      expect(first.status).toBe(201);

      const overlapping = await createShift({ startTime: '08:00', endTime: '16:00' });
      expect(overlapping.status).toBe(409);
      expect(overlapping.body).toMatchObject({ success: false, code: 'SHIFT_OVERLAP' });
      expect(overlapping.body.message).toMatch(/07:00/);

      const summary = await request
        .get('/api/shifts/summary')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-09-07', endDate: '2026-09-07' });
      expect(summary.body.summary[0].totalHours).toBe(8);
    });

    it('accepts an adjacent shift that starts exactly when the previous one ends', async () => {
      await createShift({ startTime: '07:00', endTime: '15:00' });

      const adjacent = await createShift({ startTime: '15:00', endTime: '18:00' });
      expect(adjacent.status).toBe(201);
      expect(adjacent.body.shift.hoursWorked).toBe(3);
    });

    it('does not treat another person, another day, or a cancelled shift as an overlap', async () => {
      await createShift({ startTime: '07:00', endTime: '15:00' });

      const otherStaff = await request
        .post('/api/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Second Worker', hourlyRate: 50 });
      const otherPerson = await createShift({
        staffId: otherStaff.body.staff._id,
        startTime: '08:00',
        endTime: '16:00',
      });
      expect(otherPerson.status).toBe(201);

      const otherDay = await createShift({ date: '2026-09-08', startTime: '08:00', endTime: '16:00' });
      expect(otherDay.status).toBe(201);

      const cancelled = await createShift({ date: '2026-09-09', startTime: '07:00', endTime: '15:00', status: 'cancelled' });
      expect(cancelled.status).toBe(201);
      const replacement = await createShift({ date: '2026-09-09', startTime: '08:00', endTime: '16:00' });
      expect(replacement.status).toBe(201);
    });

    it('rejects an update that would overlap another shift', async () => {
      await createShift({ startTime: '07:00', endTime: '15:00' });
      const second = await createShift({ startTime: '15:00', endTime: '18:00' });

      const res = await request
        .put(`/api/shifts/${second.body.shift._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ startTime: '14:00' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'SHIFT_OVERLAP' });
    });

    it('allows updating a shift to a superset of itself', async () => {
      const created = await createShift({ startTime: '07:00', endTime: '15:00' });

      const res = await request
        .put(`/api/shifts/${created.body.shift._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ startTime: '06:00', endTime: '16:00' });

      expect(res.status).toBe(200);
      expect(res.body.shift.hoursWorked).toBe(10);
    });
  });

  describe('GET /api/shifts', () => {
    it('lists shifts for a date range', async () => {
      await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          staffId,
          date: '2026-04-06',
          startTime: '07:00',
          endTime: '15:00',
        });

      const res = await request
        .get('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-04-01', endDate: '2026-04-30' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.shifts).toBeDefined();
      expect(res.body.shifts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/shifts/week', () => {
    it('returns current week roster grouped by day', async () => {
      const res = await request
        .get('/api/shifts/week')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.roster).toBeDefined();
      expect(res.body.roster.length).toBe(7); // Mon-Sun
    });
  });

  describe('GET /api/shifts/summary', () => {
    it('returns hours summary per staff member', async () => {
      // Create shifts
      await request
        .post('/api/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          staffId,
          date: '2026-04-06',
          startTime: '07:00',
          endTime: '15:00',
        });

      const res = await request
        .get('/api/shifts/summary')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-04-06', endDate: '2026-04-12' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary).toBeDefined();
      expect(Array.isArray(res.body.summary)).toBe(true);

      // 07:00-15:00 is 8 h at the R55 rate; estimatedPay is owner-only and this is the owner's token.
      expect(res.body.summary).toHaveLength(1);
      expect(res.body.summary[0]).toEqual(expect.objectContaining({
        staffId, totalHours: 8, estimatedPay: 440, overThreshold: false,
      }));
    });

    it('applies the overtime threshold independently to each week', async () => {
      const dates = [
        '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10',
        '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17',
      ];
      for (const date of dates) {
        await request
          .post('/api/shifts')
          .set('Authorization', `Bearer ${token}`)
          .send({ staffId, date, startTime: '06:00', endTime: '16:00' });
      }

      const res = await request
        .get('/api/shifts/summary')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-04-06', endDate: '2026-04-19' });

      expect(res.status).toBe(200);
      expect(res.body.summary[0]).toEqual(expect.objectContaining({
        totalHours: 100,
        regularHours: 90,
        overtimeHours: 10,
        estimatedPay: 5775,
      }));
      expect(res.body.summaries).toEqual(res.body.summary);
    });
  });
});
