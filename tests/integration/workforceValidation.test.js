const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Staff = require('../../src/models/Staff.model');
const Shift = require('../../src/models/Shift.model');
const LeaveRequest = require('../../src/models/LeaveRequest.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Workforce input validation (BE-08-T05)', () => {
  let token;
  let staffId;

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const expect400 = (res, field) =>
    expect({ status: res.status, code: res.body.code, field: res.body.field }).toEqual({
      status: 400,
      code: 'INVALID_WORKFORCE_INPUT',
      field,
    });

  beforeEach(async () => {
    token = (await createTestUser()).token;
    const staff = await auth(request.post('/api/staff')).send({ name: 'Valid Barista', hourlyRate: 55, startDate: '2026-01-05' });
    staffId = staff.body.staff._id;
  });

  describe('staff', () => {
    it.each([
      ['a blank rate', { name: 'Thandi', hourlyRate: '' }, 'hourlyRate'],
      ['a null rate', { name: 'Thandi', hourlyRate: null }, 'hourlyRate'],
      ['a non-numeric rate', { name: 'Thandi', hourlyRate: 'fifty' }, 'hourlyRate'],
      ['a null name', { name: null, hourlyRate: 55 }, 'name'],
      ['a blank name', { name: '   ', hourlyRate: 55 }, 'name'],
      ['a 101-character name', { name: 'x'.repeat(101), hourlyRate: 55 }, 'name'],
      ['a null role', { name: 'Thandi', hourlyRate: 55, role: null }, 'role'],
      ['an unknown role', { name: 'Thandi', hourlyRate: 55, role: 'chef' }, 'role'],
      ['a malformed email', { name: 'Thandi', hourlyRate: 55, email: 'not-an-email' }, 'email'],
      ['a 31-character phone', { name: 'Thandi', hourlyRate: 55, phone: '0'.repeat(31) }, 'phone'],
      ['an operator object as the name', { name: { $gt: '' }, hourlyRate: 55 }, 'name'],
    ])('refuses %s on create', async (_label, body, field) => {
      expect400(await auth(request.post('/api/staff')).send(body), field);
      expect(await Staff.countDocuments({})).toBe(1);
    });

    it('accepts a numeric-string rate and an empty email and phone', async () => {
      const res = await auth(request.post('/api/staff')).send({ name: 'Thandi', hourlyRate: '62.50', email: '', phone: '' });
      expect(res.status).toBe(201);
      expect(res.body.staff.hourlyRate).toBe(62.5);
    });

    it.each([
      ['a null rate', { hourlyRate: null }, 'hourlyRate'],
      ['a blank rate', { hourlyRate: '' }, 'hourlyRate'],
      ['a null name', { name: null }, 'name'],
      ['a null role', { role: null }, 'role'],
      ['a string isActive', { isActive: 'false' }, 'isActive'],
    ])('refuses %s on update and leaves the record alone', async (_label, body, field) => {
      expect400(await auth(request.put(`/api/staff/${staffId}`)).send(body), field);
      const stored = await Staff.findById(staffId).lean();
      expect(stored).toMatchObject({ name: 'Valid Barista', hourlyRate: 55, role: 'barista', isActive: true });
    });

    it('still clears an email or phone sent as an empty string', async () => {
      await auth(request.put(`/api/staff/${staffId}`)).send({ email: 'thandi@cafe.co.za', phone: '0821234567' }).expect(200);
      const res = await auth(request.put(`/api/staff/${staffId}`)).send({ email: '', phone: '' });
      expect(res.status).toBe(200);
      expect(res.body.staff).toMatchObject({ email: '', phone: '' });
    });
  });

  describe('shifts', () => {
    it.each([
      ['an operator object as staffId', { staffId: { $ne: null } }, 'staffId'],
      ['an array as staffId', { staffId: ['64b7f0c2a1b2c3d4e5f60718'] }, 'staffId'],
      ['a short staffId', { staffId: 'abc' }, 'staffId'],
      ['a 501-character note', { notes: 'x'.repeat(501) }, 'notes'],
      ['a null note', { notes: null }, 'notes'],
      ['an unknown status', { status: 'done' }, 'status'],
    ])('refuses %s', async (_label, overrides, field) => {
      const body = { staffId, date: '2026-10-05', startTime: '07:00', endTime: '15:00', ...overrides };
      expect400(await auth(request.post('/api/shifts')).send(body), field);
      expect(await Shift.countDocuments({})).toBe(0);
    });
  });

  describe('leave', () => {
    it.each([
      ['an operator object as staffId', { staffId: { $ne: null } }, 'staffId'],
      ['a 501-character reason', { reason: 'x'.repeat(501) }, 'reason'],
      ['an object as the reason', { reason: { $gt: '' } }, 'reason'],
    ])('refuses %s', async (_label, overrides, field) => {
      const body = { staffId, type: 'annual', startDate: '2026-11-02', endDate: '2026-11-06', ...overrides };
      expect400(await auth(request.post('/api/leave')).send(body), field);
      expect(await LeaveRequest.countDocuments({})).toBe(0);
    });

    it('refuses repeated or unknown list filters', async () => {
      expect400(await auth(request.get(`/api/leave?staffId=${staffId}&staffId=${staffId}`)), 'staffId');
      expect400(await auth(request.get('/api/leave?status=everything')), 'status');
      expect((await auth(request.get(`/api/leave?staffId=${staffId}&status=pending`))).status).toBe(200);
    });

    it('refuses a body that is not a JSON object', async () => {
      expect400(await auth(request.post('/api/leave')).send([{ staffId }]), 'body');
    });
  });

  it('caps free text in the schemas as well as in the API', async () => {
    const { cafeId } = await Staff.findById(staffId).lean();
    await expect(Staff.create({ cafeId, name: 'x'.repeat(101), hourlyRate: 1 })).rejects.toThrow(/maximum allowed length \(100\)/);
    await expect(
      Shift.create({ cafeId, staffId, date: new Date('2026-10-05T00:00:00Z'), startTime: '07:00', endTime: '15:00', notes: 'x'.repeat(501) })
    ).rejects.toThrow(/maximum allowed length \(500\)/);
    await expect(
      LeaveRequest.create({
        cafeId, staffId, type: 'annual', startDate: new Date('2026-11-02T00:00:00Z'), endDate: new Date('2026-11-06T00:00:00Z'), days: 5,
        reason: 'x'.repeat(501),
      })
    ).rejects.toThrow(/maximum allowed length \(500\)/);
  });

  it('refuses repeated or incomplete date filters before querying', async () => {
    for (const route of ['/api/shifts', '/api/shifts/summary', '/api/leave/calendar']) {
      expect400(await auth(request.get(`${route}?startDate=2026-10-05&startDate=2026-10-06&endDate=2026-10-07`)), 'startDate');
      expect400(await auth(request.get(`${route}?startDate=2026-10-05`)), 'endDate');
    }
  });

  it('can update a rate and deactivate a legacy record whose name exceeds the new limit', async () => {
    await Staff.collection.updateOne({ _id: (await Staff.findById(staffId))._id }, { $set: { name: 'x'.repeat(101) } });
    const res = await auth(request.put(`/api/staff/${staffId}`)).send({ hourlyRate: 60, isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.staff).toMatchObject({ name: 'x'.repeat(101), hourlyRate: 60, isActive: false });
  });
});
