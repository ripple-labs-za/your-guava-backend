const supertest = require('supertest');
const mongoose = require('mongoose');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const InsightChat = require('../../src/models/InsightChat.model');
const User = require('../../src/models/User.model');
const AuthSession = require('../../src/models/AuthSession.model');
const AccessAuditEvent = require('../../src/models/AccessAuditEvent.model');
const request = supertest(app);
beforeAll(setup);
afterAll(teardown);
afterEach(async () => { jest.restoreAllMocks(); await clearDB(); });

test('member removal erases current and legacy member chats only within the organisation', async () => {
  const owner = await createTestUser();
  const cafeId = owner.user.activeCafeId;
  const member = await createTestManager(owner.token, [cafeId]);
  const foreignOrg = new mongoose.Types.ObjectId();
  const foreignCafe = new mongoose.Types.ObjectId();
  await InsightChat.create([
    { cafeId, orgId: owner.user.orgId, userId: member.user.id, title: 'Private' },
    { cafeId, userId: member.user.id, title: 'Legacy', archived: true },
    { cafeId, orgId: owner.user.orgId, userId: owner.user.id, title: 'Owner' },
    { cafeId: foreignCafe, orgId: foreignOrg, userId: member.user.id, title: 'Foreign' },
  ]);
  const response = await request.delete(`/api/team/${member.user.id}`).set('Authorization', `Bearer ${owner.token}`);
  expect(response.status).toBe(200);
  expect((await InsightChat.find({}).lean()).map((chat) => chat.title).sort()).toEqual(['Foreign', 'Owner']);
  expect(await User.findById(member.user.id)).toBeNull();
  expect(await AuthSession.countDocuments({ userId: member.user.id })).toBe(0);
});

test('chat deletion failure rolls back member and sessions inside the same transaction', async () => {
  const owner = await createTestUser();
  const member = await createTestManager(owner.token, [owner.user.activeCafeId]);
  const chat = await InsightChat.create({ cafeId: owner.user.activeCafeId, orgId: owner.user.orgId, userId: member.user.id });
  const sessions = await AuthSession.countDocuments({ userId: member.user.id });
  jest.spyOn(InsightChat, 'deleteMany').mockRejectedValue(new Error('chat deletion failed'));
  const response = await request.delete(`/api/team/${member.user.id}`).set('Authorization', `Bearer ${owner.token}`);
  expect(response.status).toBe(500);
  expect(await User.findById(member.user.id)).not.toBeNull();
  expect(await InsightChat.findById(chat._id)).not.toBeNull();
  expect(await AuthSession.countDocuments({ userId: member.user.id })).toBe(sessions);
});

test('a later audit failure rolls back the actual chat deletion with the member and sessions', async () => {
  const owner = await createTestUser();
  const member = await createTestManager(owner.token, [owner.user.activeCafeId]);
  const chat = await InsightChat.create({ cafeId: owner.user.activeCafeId, orgId: owner.user.orgId, userId: member.user.id });
  const sessions = await AuthSession.countDocuments({ userId: member.user.id });
  jest.spyOn(AccessAuditEvent, 'create').mockRejectedValue(new Error('audit unavailable'));
  const response = await request.delete(`/api/team/${member.user.id}`).set('Authorization', `Bearer ${owner.token}`);
  expect(response.status).toBe(500);
  expect(await User.findById(member.user.id)).not.toBeNull();
  expect(await InsightChat.findById(chat._id)).not.toBeNull();
  expect(await AuthSession.countDocuments({ userId: member.user.id })).toBe(sessions);
});
