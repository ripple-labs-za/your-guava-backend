const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Shift = require('../../src/models/Shift.model');
const LeaveRequest = require('../../src/models/LeaveRequest.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const DAY = 86400000;
// The test cafe uses the model default, Africa/Johannesburg.
const cafeTodayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
const plusDays = (key, days) => new Date(new Date(`${key}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);

describe('Shift rules (BE-08-T04)', () => {
  let token;
  let staffId;

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const createShift = (body) => auth(request.post('/api/shifts')).send({ staffId, ...body });
  const shiftsBetween = async (startDate, endDate, extra = {}) => {
    const res = await auth(request.get('/api/shifts')).query({ startDate, endDate, ...extra });
    expect(res.status).toBe(200);
    return res.body.shifts;
  };
  const byDate = (shifts) => Object.fromEntries(shifts.map((shift) => [shift.date.slice(0, 10), shift]));
  const summary = (startDate, endDate) => auth(request.get('/api/shifts/summary')).query({ startDate, endDate });

  beforeEach(async () => {
    token = (await createTestUser()).token;
    const staff = await auth(request.post('/api/staff')).send({ name: 'Rule Barista', hourlyRate: 55, startDate: '2026-01-05' });
    staffId = staff.body.staff._id;
  });

  describe('overnight shifts', () => {
    it('saves a 22:00 to 02:00 shift as four hours ending the next day', async () => {
      const res = await createShift({ date: '2026-10-05', startTime: '22:00', endTime: '02:00' });
      expect(res.status).toBe(201);
      expect(res.body.shift).toMatchObject({ hoursWorked: 4, endsNextDay: true });
    });

    it('saves a closing shift that ends at midnight', async () => {
      const res = await createShift({ date: '2026-10-05', startTime: '16:00', endTime: '00:00' });
      expect(res.status).toBe(201);
      expect(res.body.shift).toMatchObject({ hoursWorked: 8, endsNextDay: true });
    });

    it('refuses equal start and end times, and a shift over 16 hours', async () => {
      const same = await createShift({ date: '2026-10-05', startTime: '07:00', endTime: '07:00' });
      expect(same.status).toBe(400);
      expect(same.body.code).toBe('INVALID_SHIFT_TIMES');

      const long = await createShift({ date: '2026-10-05', startTime: '06:00', endTime: '23:00' });
      expect(long.status).toBe(400);
      expect(long.body.message).toMatch(/at most 16 hours/);
    });

    it('treats the hours after midnight as overlapping the next morning', async () => {
      await createShift({ date: '2026-10-05', startTime: '22:00', endTime: '02:00' }).expect(201);

      const clash = await createShift({ date: '2026-10-06', startTime: '01:00', endTime: '05:00' });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('SHIFT_OVERLAP');

      await createShift({ date: '2026-10-06', startTime: '02:00', endTime: '06:00' }).expect(201);
    });
  });

  describe('overtime per calendar week', () => {
    it('flags the shift worked past 45 hours, whatever order the week was entered in', async () => {
      for (const date of ['2026-04-10', '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09']) {
        await createShift({ date, startTime: '06:00', endTime: '16:00' }).expect(201);
      }
      const shifts = byDate(await shiftsBetween('2026-04-06', '2026-04-12'));
      expect(shifts['2026-04-10']).toMatchObject({ type: 'overtime', regularHours: 5, overtimeHours: 5 });
      expect(shifts['2026-04-09']).toMatchObject({ type: 'regular', regularHours: 10, overtimeHours: 0 });
    });

    it("clears Friday's overtime when a midweek shift is deleted, and Saturday's when one is cancelled", async () => {
      const created = [];
      for (const date of ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10']) {
        created.push((await createShift({ date, startTime: '06:00', endTime: '16:00' })).body.shift);
      }
      await auth(request.delete(`/api/shifts/${created[2]._id}`)).expect(200);
      expect(byDate(await shiftsBetween('2026-04-06', '2026-04-12'))['2026-04-10']).toMatchObject({ type: 'regular', overtimeHours: 0 });

      await createShift({ date: '2026-04-11', startTime: '06:00', endTime: '16:00' }).expect(201);
      expect(byDate(await shiftsBetween('2026-04-06', '2026-04-12'))['2026-04-11']).toMatchObject({ type: 'overtime', overtimeHours: 5 });

      await auth(request.put(`/api/shifts/${created[3]._id}`)).send({ status: 'cancelled' }).expect(200);
      expect(byDate(await shiftsBetween('2026-04-06', '2026-04-12'))['2026-04-11']).toMatchObject({ type: 'regular', overtimeHours: 0 });
    });

    it('applies the 45-hour rule to calendar weeks, not to the requested range', async () => {
      const dates = ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16'];
      for (const date of dates) await createShift({ date, startTime: '06:00', endTime: '16:00' }).expect(201);

      const res = await summary('2026-04-06', '2026-04-19');
      expect(res.body.summary[0]).toMatchObject({ totalHours: 80, overtimeHours: 0, overThreshold: false });
    });

    it("counts the week's earlier days when the range starts midweek", async () => {
      for (const date of ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17']) {
        await createShift({ date, startTime: '06:00', endTime: '16:00' }).expect(201);
      }
      const res = await summary('2026-04-15', '2026-04-19');
      expect(res.body.summary[0]).toMatchObject({ totalHours: 30, regularHours: 25, overtimeHours: 5, overThreshold: true });
    });
  });

  describe('atomic overlap', () => {
    it('lets exactly one of two simultaneous identical shifts in, every time', async () => {
      for (const date of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']) {
        const body = { date, startTime: '07:00', endTime: '15:00' };
        const results = await Promise.all([createShift(body), createShift(body)]);
        expect({ date, statuses: results.map((res) => res.status).sort() }).toEqual({ date, statuses: [201, 409] });
      }
      expect(await Shift.countDocuments({ staffId })).toBe(5);
    });
  });

  describe('leave and deactivation', () => {
    it('refuses a shift on a day of approved leave, but not of pending leave', async () => {
      const leave = await auth(request.post('/api/leave')).send({ staffId, type: 'annual', startDate: '2026-10-05', endDate: '2026-10-09' });
      await auth(request.put(`/api/leave/${leave.body.leaveRequest._id}/approve`)).expect(200);

      const onLeave = await createShift({ date: '2026-10-07', startTime: '07:00', endTime: '15:00' });
      expect(onLeave.status).toBe(409);
      expect(onLeave.body.code).toBe('SHIFT_ON_LEAVE');
      expect(onLeave.body.message).toMatch(/annual leave from 2026-10-05 to 2026-10-09/);

      await auth(request.post('/api/leave')).send({ staffId, type: 'annual', startDate: '2026-10-12', endDate: '2026-10-13' }).expect(201);
      await createShift({ date: '2026-10-12', startTime: '07:00', endTime: '15:00' }).expect(201);
    });

    it('cancels future shifts and pending leave when a person is deactivated, and refuses new ones', async () => {
      const today = cafeTodayKey();
      const past = await createShift({ date: plusDays(today, -5), startTime: '07:00', endTime: '15:00' });
      const soon = await createShift({ date: plusDays(today, 2), startTime: '07:00', endTime: '15:00' });
      const later = await createShift({ date: plusDays(today, 9), startTime: '07:00', endTime: '15:00' });
      const pending = await auth(request.post('/api/leave')).send({
        staffId, type: 'unpaid', startDate: plusDays(today, 20), endDate: plusDays(today, 26),
      });
      expect([past.status, soon.status, later.status, pending.status]).toEqual([201, 201, 201, 201]);

      const res = await auth(request.delete(`/api/staff/${staffId}`));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ cancelledShifts: 2, cancelledLeaveRequests: 1 });

      const statuses = Object.fromEntries((await Shift.find({ staffId }).lean()).map((shift) => [String(shift._id), shift.status]));
      expect(statuses).toEqual({
        [past.body.shift._id]: 'scheduled',
        [soon.body.shift._id]: 'cancelled',
        [later.body.shift._id]: 'cancelled',
      });
      expect((await LeaveRequest.findById(pending.body.leaveRequest._id).lean()).status).toBe('cancelled');

      expect((await createShift({ date: plusDays(today, 3), startTime: '07:00', endTime: '15:00' })).status).toBe(404);
      const newLeave = await auth(request.post('/api/leave')).send({
        staffId, type: 'unpaid', startDate: plusDays(today, 30), endDate: plusDays(today, 36),
      });
      expect(newLeave.status).toBe(404);
    });

    it('runs the same cascade when the portal deactivates through PUT isActive:false', async () => {
      const soon = await createShift({ date: plusDays(cafeTodayKey(), 2), startTime: '07:00', endTime: '15:00' });
      const res = await auth(request.put(`/api/staff/${staffId}`)).send({ isActive: false });
      expect(res.status).toBe(200);
      expect(res.body.cancelledShifts).toBe(1);
      expect((await Shift.findById(soon.body.shift._id).lean()).status).toBe('cancelled');
    });
  });

  describe('list', () => {
    it('returns the cafe week at 00:30 on Monday in Johannesburg', async () => {
      jest.useFakeTimers({
        now: new Date('2026-09-20T22:30:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
      });
      try {
        const res = await auth(request.get('/api/shifts/week'));
        expect(res.body.roster[0].date).toBe('2026-09-21');
      } finally {
        jest.useRealTimers();
      }
    });

    it('hides cancelled shifts unless asked for them', async () => {
      await createShift({ date: '2026-10-05', startTime: '07:00', endTime: '15:00', status: 'cancelled' }).expect(201);
      await createShift({ date: '2026-10-06', startTime: '07:00', endTime: '15:00' }).expect(201);
      expect(await shiftsBetween('2026-10-05', '2026-10-11')).toHaveLength(1);
      expect(await shiftsBetween('2026-10-05', '2026-10-11', { includeCancelled: 'true' })).toHaveLength(2);
    });
  });
});
