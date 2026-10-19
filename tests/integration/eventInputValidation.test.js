const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Event = require('../../src/models/Event.model');

const request = supertest(app);
const valid = { name: 'Market day', date: '2031-05-10', impact: 'medium', notes: 'Original notes', type: 'event' };
const badValues = [{ $gt: '' }, ['2031-05-10'], 123, true, null];

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('event input types are checked before database casting', () => {
  let token;
  let eventId;
  beforeEach(async () => {
    ({ token } = await createTestUser());
    const created = await request.post('/api/events').set('Authorization', `Bearer ${token}`).send(valid);
    expect(created.status).toBe(201);
    eventId = created.body.event._id;
  });

  it.each(['name', 'date', 'impact', 'notes', 'type'])('rejects non-string %s updates and preserves the original event', async (field) => {
    const before = await Event.findById(eventId).lean();
    for (const value of badValues) {
      const response = await request.put(`/api/events/${eventId}`)
        .set('Authorization', `Bearer ${token}`).send({ [field]: value });
      expect({ field, value, status: response.status }).toEqual({ field, value, status: 400 });
      expect(response.body.message).toMatch(new RegExp(`${field}.*string`, 'i'));
      expect(await Event.findById(eventId).lean()).toEqual(before);
    }
  });

  it.each(['name', 'date', 'impact', 'notes', 'type'])('rejects non-string %s on create without adding an event', async (field) => {
    for (const value of badValues) {
      const response = await request.post('/api/events').set('Authorization', `Bearer ${token}`)
        .send({ ...valid, [field]: value });
      expect({ field, value, status: response.status }).toEqual({ field, value, status: 400 });
      expect(await Event.countDocuments()).toBe(1);
    }
  });

  it('rejects array closure windows and non-string times without changing an event', async () => {
    const before = await Event.findById(eventId).lean();
    const windows = [[], { startTime: ['09:00'], endTime: '12:00' }, { startTime: '09:00', endTime: ['12:00'] }];
    for (const closureWindow of windows) {
      const response = await request.put(`/api/events/${eventId}`).set('Authorization', `Bearer ${token}`)
        .send({ type: 'partial_closure', closureWindow });
      expect(response.status).toBe(400);
      expect(await Event.findById(eventId).lean()).toEqual(before);
    }
  });

  it('keeps valid edits, blank notes and partial closure times working', async () => {
    const response = await request.put(`/api/events/${eventId}`).set('Authorization', `Bearer ${token}`)
      .send({ name: '  Updated market  ', notes: '', date: '2031-05-11', impact: 'high',
        type: 'partial_closure', closureWindow: { startTime: '09:00', endTime: '12:00' } });
    expect(response.status).toBe(200);
    expect(response.body.event).toMatchObject({ name: 'Updated market', notes: '', dateKey: '2031-05-11', impact: 'high',
      type: 'partial_closure', closureWindow: { startTime: '09:00', endTime: '12:00' } });
  });

  it('keeps a foreign event inaccessible before checking its update fields', async () => {
    const foreign = await createTestUser({ email: 'other-event@example.test' });
    const before = await Event.findById(eventId).lean();
    const response = await request.put(`/api/events/${eventId}`).set('Authorization', `Bearer ${foreign.token}`)
      .send({ name: { $gt: '' } });
    expect(response.status).toBe(404);
    expect(await Event.findById(eventId).lean()).toEqual(before);
  });
});
