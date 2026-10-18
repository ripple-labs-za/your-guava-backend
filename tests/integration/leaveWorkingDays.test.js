const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const LeaveRequest = require('../../src/models/LeaveRequest.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Leave on the working pattern, public holidays and overlaps (BE-08-T03)', () => {
  let token;
  let cafeId;

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const hire = async (body) => {
    const res = await auth(request.post('/api/staff')).send({ hourlyRate: 60, startDate: '2026-01-05', ...body });
    expect(res.status).toBe(201);
    return res.body.staff._id;
  };
  const requestLeave = (staffId, body) => auth(request.post('/api/leave')).send({ staffId, type: 'annual', ...body });

  beforeEach(async () => {
    const owner = await createTestUser();
    token = owner.token;
    cafeId = owner.user.activeCafeId;
  });

  it('lets a Friday-to-Sunday worker book a Saturday and Sunday', async () => {
    const weekender = await hire({ name: 'Weekend Barista', workDays: [5, 6, 0] });

    const weekend = await requestLeave(weekender, { startDate: '2026-10-03', endDate: '2026-10-04' });
    expect(weekend.status).toBe(201);
    expect(weekend.body.leaveRequest.days).toBe(2);

    const friToMon = await requestLeave(weekender, { startDate: '2026-10-09', endDate: '2026-10-12' });
    expect(friToMon.body.leaveRequest.days).toBe(3);
  });

  it('refuses a weekend for a Monday-to-Friday worker and names their pattern', async () => {
    const weekday = await hire({ name: 'Weekday Barista' });
    const res = await requestLeave(weekday, { startDate: '2026-10-03', endDate: '2026-10-04' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LEAVE_NO_WORKING_DAYS');
    expect(res.body.message).toMatch(/Mon, Tue, Wed, Thu, Fri/);
  });

  it('does not charge public holidays', async () => {
    const weekday = await hire({ name: 'Holiday Barista' });
    const res = await requestLeave(weekday, { startDate: '2026-12-21', endDate: '2027-01-01' });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.days).toBe(8);
  });

  it('shows weekend leave on the calendar', async () => {
    const weekender = await hire({ name: 'Weekend Barista', workDays: [5, 6, 0] });
    const created = await requestLeave(weekender, { startDate: '2026-10-02', endDate: '2026-10-04' });
    await auth(request.put(`/api/leave/${created.body.leaveRequest._id}/approve`)).expect(200);

    const res = await auth(request.get('/api/leave/calendar')).query({ startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(res.status).toBe(200);
    expect(res.body.calendar.map((day) => day.date)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
    expect(res.body.calendar[1].staff).toEqual([{ name: 'Weekend Barista', type: 'annual' }]);
  });

  it('refuses a request that overlaps a pending or approved one of any type, and a duplicate', async () => {
    const staffId = await hire({ name: 'Overlap Barista' });
    const first = await requestLeave(staffId, { startDate: '2026-11-02', endDate: '2026-11-06' });
    expect(first.status).toBe(201);

    const sick = await requestLeave(staffId, { type: 'sick', startDate: '2026-11-04', endDate: '2026-11-05' });
    expect(sick.status).toBe(409);
    expect(sick.body.code).toBe('LEAVE_OVERLAP');
    expect(sick.body.message).toMatch(/2026-11-02 to 2026-11-06/);

    const duplicate = await requestLeave(staffId, { startDate: '2026-11-02', endDate: '2026-11-06' });
    expect(duplicate.status).toBe(409);

    await auth(request.put(`/api/leave/${first.body.leaveRequest._id}/reject`)).expect(200);
    const afterReject = await requestLeave(staffId, { startDate: '2026-11-02', endDate: '2026-11-06' });
    expect(afterReject.status).toBe(201);
  });

  it('approves only one of two overlapping requests that both reached pending', async () => {
    const staffId = await hire({ name: 'Race Barista' });
    const common = {
      staffId,
      cafeId,
      startDate: new Date('2026-11-09T00:00:00Z'),
      endDate: new Date('2026-11-11T00:00:00Z'),
      days: 3,
    };
    // Inserted directly: two creates that raced past the create-time check.
    const [annual, sick] = await LeaveRequest.create([{ ...common, type: 'annual' }, { ...common, type: 'sick' }]);

    await auth(request.put(`/api/leave/${annual._id}/approve`)).expect(200);
    const second = await auth(request.put(`/api/leave/${sick._id}/approve`));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('LEAVE_OVERLAP');
  });

  it('stores a working pattern and refuses an empty or malformed one', async () => {
    const staffId = await hire({ name: 'Pattern Barista' });
    const updated = await auth(request.put(`/api/staff/${staffId}`)).send({ workDays: [6, 0, 6] });
    expect(updated.status).toBe(200);
    expect(updated.body.staff.workDays).toEqual([0, 6]);

    for (const workDays of [[], [7], ['1'], 'weekdays', [1.5], { $gt: 0 }]) {
      const res = await auth(request.put(`/api/staff/${staffId}`)).send({ workDays });
      expect({ workDays, status: res.status, field: res.body.field }).toEqual({ workDays, status: 400, field: 'workDays' });
    }

    const plain = await auth(request.post('/api/staff')).send({ name: 'Default Pattern', hourlyRate: 50 });
    expect(plain.body.staff.workDays).toEqual([1, 2, 3, 4, 5]);
  });
});
