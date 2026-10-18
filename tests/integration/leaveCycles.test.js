const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const LeaveBalance = require('../../src/models/LeaveBalance.model');
const LeaveRequest = require('../../src/models/LeaveRequest.model');
const { cafeToday } = require('../../src/services/workforce/cafeCalendar');
const { formatDateOnly } = require('../../src/utils/timezone');

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

  it('cancels an approved request and returns its days to the cycle, so they can be booked again', async () => {
    const leave = await bookAndApprove('2026-02-02', '2026-02-06');
    await bookAndApprove('2026-03-02', '2026-03-06');
    await bookAndApprove('2026-05-04', '2026-05-08');
    expect((await balanceOn('2026-06-01')).annual).toMatchObject({ used: 15, remaining: 0 });
    const whileFull = await requestLeave({ startDate: '2026-06-01', endDate: '2026-06-05' });
    expect(whileFull.status).toBe(400);
    expect(whileFull.body.code).toBe('LEAVE_INSUFFICIENT_BALANCE');

    const cancelled = await auth(request.put(`/api/leave/${leave._id}/cancel`)).send({ reason: 'Approved in error' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.leaveRequest).toMatchObject({ status: 'cancelled', cancelReason: 'Approved in error' });
    expect((await balanceOn('2026-06-01')).annual).toMatchObject({ used: 10, remaining: 5 });

    const rebooked = await requestLeave({ startDate: '2026-06-01', endDate: '2026-06-05' });
    expect(rebooked.status).toBe(201);
    const approved = await auth(request.put(`/api/leave/${rebooked.body.leaveRequest._id}/approve`));
    expect(approved.status).toBe(200);
    expect((await balanceOn('2026-06-01')).annual).toMatchObject({ used: 15, remaining: 0 });

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

  // BE-08-T02 fix-back: the cycle boundary, the start-date lock, the adjustment
  // warning and the default start date. Cycle 0 for a 2025-01-06 start runs to
  // 2026-01-05; cycle 1 starts on the anniversary, 2026-01-06.
  describe('cycle boundary and the start date', () => {
    const approve = (leaveRequest) => auth(request.put(`/api/leave/${leaveRequest._id}/approve`));
    const adjust = (body) => auth(request.put(`/api/leave/balances/${staffId}`)).send({ type: 'annual', reason: 'Boundary check', ...body });
    const moveStart = (startDate, extra = {}) => auth(request.put(`/api/staff/${staffId}`)).send({ startDate, ...extra });

    it('charges the last day of a cycle to that cycle and the anniversary to the next, in the views and at approval', async () => {
      // One day per cycle, so every boundary comparison changes an outcome.
      expect((await adjust({ total: 1, onDate: '2025-06-01' })).status).toBe(200);
      expect((await adjust({ total: 1, onDate: '2026-06-01' })).status).toBe(200);
      const lastDay = await requestLeave({ startDate: '2026-01-05', endDate: '2026-01-05' });
      const weekBefore = await requestLeave({ startDate: '2025-12-29', endDate: '2025-12-29' });
      const anniversary = await requestLeave({ startDate: '2026-01-06', endDate: '2026-01-06' });
      const dayAfter = await requestLeave({ startDate: '2026-01-07', endDate: '2026-01-07' });
      expect([lastDay, weekBefore, anniversary, dayAfter].map((res) => res.status)).toEqual([201, 201, 201, 201]);

      expect((await approve(lastDay.body.leaveRequest)).status).toBe(200);
      expect((await balanceOn('2026-01-05')).annual).toMatchObject({ used: 1, remaining: 0, cycleEnd: '2026-01-05' });
      expect((await balanceOn('2026-01-06')).annual).toMatchObject({ used: 0, remaining: 1, cycleStart: '2026-01-06' });

      const intoFullCycle = await approve(weekBefore.body.leaveRequest);
      expect(intoFullCycle.status).toBe(400);
      expect(intoFullCycle.body.code).toBe('LEAVE_INSUFFICIENT_BALANCE');

      expect((await approve(anniversary.body.leaveRequest)).status).toBe(200);
      expect((await balanceOn('2026-01-06')).annual).toMatchObject({ used: 1, remaining: 0 });
      expect((await balanceOn('2026-01-05')).annual).toMatchObject({ used: 1, remaining: 0 });

      const afterAnniversary = await approve(dayAfter.body.leaveRequest);
      expect(afterAnniversary.status).toBe(400);
      expect(afterAnniversary.body.code).toBe('LEAVE_INSUFFICIENT_BALANCE');
    });

    it('refuses a request across the anniversary when it is made and when a pending one is approved', async () => {
      const across = await requestLeave({ startDate: '2026-01-05', endDate: '2026-01-06' });
      expect(across.status).toBe(400);
      expect(across.body.code).toBe('LEAVE_CROSSES_CYCLE');

      // A pending request saved before cycles were enforced.
      const pending = await LeaveRequest.create({
        staffId,
        cafeId: owner.user.activeCafeId,
        type: 'annual',
        startDate: new Date('2026-01-05T00:00:00.000Z'),
        endDate: new Date('2026-01-06T00:00:00.000Z'),
        days: 2,
      });
      const res = await approve(pending);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LEAVE_CROSSES_CYCLE');
      expect((await LeaveRequest.findById(pending._id).lean()).status).toBe('pending');
    });

    it('lets the start date move until approved paid leave is recorded, then refuses and says why', async () => {
      expect((await moveStart('2025-01-13')).status).toBe(200);
      await requestLeave({ startDate: '2025-03-03', endDate: '2025-03-07' }); // pending
      await bookAndApprove('2025-04-07', '2025-04-07', 'unpaid'); // unpaid is outside the cycles
      expect((await moveStart('2025-01-06')).status).toBe(200);

      await bookAndApprove('2025-05-05', '2025-05-06');
      const locked = await moveStart('2025-02-03');
      expect(locked.status).toBe(409);
      expect(locked.body.code).toBe('STAFF_START_DATE_LOCKED');
      expect(locked.body.message).toMatch(/approved leave/);
      expect(locked.body.message).toMatch(/2025-01-06/);

      // Saving the form with the same date is not a change.
      const same = await moveStart('2025-01-06', { name: 'Cycle Barista Renamed' });
      expect(same.status).toBe(200);
      expect(same.body.staff).toMatchObject({ name: 'Cycle Barista Renamed', startDate: '2025-01-06T00:00:00.000Z' });
    });

    it('locks the start date once an adjustment is recorded', async () => {
      expect((await adjust({ total: 7.5, onDate: '2025-03-01' })).status).toBe(200);
      const locked = await moveStart('2025-02-03');
      expect(locked.status).toBe(409);
      expect(locked.body.code).toBe('STAFF_START_DATE_LOCKED');
      expect(locked.body.message).toMatch(/an owner's adjustment to a leave total is already recorded/);
      expect(locked.body.message).not.toMatch(/cancel the approved leave/);

      await bookAndApprove('2025-05-05', '2025-05-06');
      const both = await moveStart('2025-02-03');
      expect(both.body.message).toMatch(/approved leave and an owner's adjustment to a leave total are already recorded/);
      expect(both.body.message).toMatch(/cancel the approved leave first/);
    });

    it('allows an adjustment below the days already taken and warns about it', async () => {
      await bookAndApprove('2026-02-02', '2026-02-13');
      const below = await adjust({ total: 5, onDate: '2026-03-01' });
      expect(below.status).toBe(200);
      expect(below.body.balance.annual).toMatchObject({ total: 5, used: 10, remaining: -5 });
      expect(below.body.warning).toBe(
        '10 days already taken in this cycle exceed the new total of 5, so the balance shows -5 until leave is cancelled or the total is raised.'
      );

      const above = await adjust({ total: 12, onDate: '2026-03-01' });
      expect(above.status).toBe(200);
      expect(above.body.warning).toBeUndefined();
    });

    it("starts a new staff member on the cafe's today when no start date is sent", async () => {
      const res = await auth(request.post('/api/staff')).send({ name: 'No Start Date', hourlyRate: 60 });
      expect(res.status).toBe(201);
      const today = formatDateOnly(await cafeToday(owner.user.activeCafeId));
      expect(res.body.staff.startDate).toBe(`${today}T00:00:00.000Z`);
    });
  });
});
