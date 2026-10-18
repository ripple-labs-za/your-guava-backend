const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const LeaveBalance = require('../../src/models/LeaveBalance.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Leave cycles, adjustments and cancellation (BE-08-T02)', () => {
  let token;
  let owner;
  let staffId;

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const requestLeave = (body) => auth(request.post('/api/leave')).send({ staffId, type: 'annual', ...body });
  const bookAndApprove = async (startDate, endDate, type = 'annual') => {
    const created = await requestLeave({ type, startDate, endDate });
    expect(created.status).toBe(201);
    const approved = await auth(request.put(`/api/leave/${created.body.leaveRequest._id}/approve`));
    expect(approved.status).toBe(200);
    return created.body.leaveRequest;
  };
  const balanceOn = async (onDate) => {
    const res = await auth(request.get('/api/leave/balances')).query({ onDate });
    expect(res.status).toBe(200);
    return res.body.balances.find((balance) => balance.staffId === staffId);
  };

  beforeEach(async () => {
    owner = await createTestUser();
    token = owner.token;
    const staff = await auth(request.post('/api/staff')).send({
      name: 'Cycle Barista',
      hourlyRate: 60,
      role: 'barista',
      startDate: '2025-01-06',
    });
    expect(staff.status).toBe(201);
    staffId = staff.body.staff._id;
  });

  it('lets a year-two employee book annual leave after using all 15 days in year one', async () => {
    await bookAndApprove('2025-02-03', '2025-02-07');
    await bookAndApprove('2025-06-02', '2025-06-06');
    await bookAndApprove('2025-09-01', '2025-09-05');

    const yearTwo = await requestLeave({ startDate: '2026-02-02', endDate: '2026-02-06' });
    expect(yearTwo.status).toBe(201);
    expect(yearTwo.body.leaveRequest.days).toBe(5);

    expect((await balanceOn('2025-12-01')).annual).toEqual({
      total: 15, used: 15, remaining: 0, cycleStart: '2025-01-06', cycleEnd: '2026-01-05',
    });
    expect((await balanceOn('2026-03-01')).annual).toEqual({
      total: 15, used: 0, remaining: 15, cycleStart: '2026-01-06', cycleEnd: '2027-01-05',
    });
  });

  it('counts sick leave over 36 months and family leave per annual cycle', async () => {
    await bookAndApprove('2025-03-03', '2025-03-07', 'sick');
    await bookAndApprove('2025-04-07', '2025-04-09', 'family');

    const inYearThree = await balanceOn('2027-06-01');
    expect(inYearThree.sick).toMatchObject({ used: 5, remaining: 25, cycleStart: '2025-01-06', cycleEnd: '2028-01-05' });
    expect(inYearThree.family).toMatchObject({ used: 0, remaining: 3, cycleStart: '2027-01-06' });
    expect((await balanceOn('2028-02-01')).sick).toMatchObject({ used: 0, cycleStart: '2028-01-06' });
  });

  it('refuses leave that crosses into the next cycle and names both halves', async () => {
    const res = await requestLeave({ startDate: '2026-01-05', endDate: '2026-01-07' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LEAVE_CROSSES_CYCLE');
    expect(res.body.message).toMatch(/ends on 2026-01-05.*starting 2026-01-06/);
  });

  it('counts leave dated before the recorded start date in the first cycle', async () => {
    const late = await auth(request.post('/api/staff')).send({ name: 'Late Record', hourlyRate: 60, startDate: '2026-05-04' });
    const created = await auth(request.post('/api/leave')).send({
      staffId: late.body.staff._id, type: 'annual', startDate: '2026-04-13', endDate: '2026-04-17',
    });
    expect(created.status).toBe(201);
    expect((await auth(request.put(`/api/leave/${created.body.leaveRequest._id}/approve`))).status).toBe(200);

    const res = await auth(request.get('/api/leave/balances')).query({ onDate: '2026-06-01' });
    const view = res.body.balances.find((balance) => balance.staffId === late.body.staff._id);
    expect(view.annual).toMatchObject({ used: 5, cycleStart: '2026-05-04', cycleEnd: '2027-05-03' });
  });

  it('lets the owner set a cycle total and keeps who, when, why and the previous total', async () => {
    const res = await auth(request.put(`/api/leave/balances/${staffId}`)).send({
      type: 'annual', total: 7.5, reason: 'Joined mid-year: pro-rata', onDate: '2025-03-01',
    });
    expect(res.status).toBe(200);
    expect(res.body.adjustment).toMatchObject({
      type: 'annual', cycleStart: '2025-01-06', previousTotal: 15, total: 7.5, reason: 'Joined mid-year: pro-rata',
    });
    expect((await balanceOn('2025-03-01')).annual.total).toBe(7.5);
    expect((await balanceOn('2026-03-01')).annual.total).toBe(15);

    const stored = await LeaveBalance.findOne({ staffId }).lean();
    expect(stored.adjustments).toHaveLength(1);
    expect(String(stored.adjustments[0].byUserId)).toBe(String(owner.user.id));
  });

  it('refuses an adjustment without a reason, with a bad total, or from a manager', async () => {
    const noReason = await auth(request.put(`/api/leave/balances/${staffId}`)).send({ type: 'annual', total: 10 });
    expect(noReason.status).toBe(400);
    expect(noReason.body).toMatchObject({ code: 'INVALID_WORKFORCE_INPUT', field: 'reason' });

    const third = await auth(request.put(`/api/leave/balances/${staffId}`)).send({ type: 'annual', total: 10.3, reason: 'x' });
    expect(third.body).toMatchObject({ code: 'INVALID_WORKFORCE_INPUT', field: 'total' });

    const unpaid = await auth(request.put(`/api/leave/balances/${staffId}`)).send({ type: 'unpaid', total: 10, reason: 'x' });
    expect(unpaid.body).toMatchObject({ code: 'INVALID_WORKFORCE_INPUT', field: 'type' });

    const manager = await createTestManager(token, [owner.user.activeCafeId]);
    const asManager = await request
      .put(`/api/leave/balances/${staffId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ type: 'annual', total: 30, reason: 'Generous' });
    expect(asManager.status).toBe(403);
  });

  it('cancels an approved request and returns its days to the cycle', async () => {
    const leave = await bookAndApprove('2026-02-02', '2026-02-06');
    expect((await balanceOn('2026-03-01')).annual.used).toBe(5);

    const cancelled = await auth(request.put(`/api/leave/${leave._id}/cancel`)).send({ reason: 'Approved in error' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.leaveRequest).toMatchObject({ status: 'cancelled', cancelReason: 'Approved in error' });
    expect((await balanceOn('2026-03-01')).annual.used).toBe(0);

    const again = await auth(request.put(`/api/leave/${leave._id}/cancel`)).send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('LEAVE_NOT_CANCELLABLE');
  });

  it('refuses a cancellation from a manager', async () => {
    const leave = await bookAndApprove('2026-02-02', '2026-02-06');
    const manager = await createTestManager(token, [owner.user.activeCafeId]);
    const res = await request.put(`/api/leave/${leave._id}/cancel`).set('Authorization', `Bearer ${manager.token}`).send({});
    expect(res.status).toBe(403);
  });

  it('approves only one of two concurrent requests that together exceed the cycle', async () => {
    const first = await requestLeave({ startDate: '2026-02-02', endDate: '2026-02-13' });
    const second = await requestLeave({ startDate: '2026-03-02', endDate: '2026-03-13' });
    expect([first.body.leaveRequest.days, second.body.leaveRequest.days]).toEqual([10, 10]);

    const results = await Promise.all([
      auth(request.put(`/api/leave/${first.body.leaveRequest._id}/approve`)),
      auth(request.put(`/api/leave/${second.body.leaveRequest._id}/approve`)),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
    expect(results.find((res) => res.status === 400).body.code).toBe('LEAVE_INSUFFICIENT_BALANCE');
    expect((await balanceOn('2026-04-01')).annual.used).toBe(10);
  });
});
