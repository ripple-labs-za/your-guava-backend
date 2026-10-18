jest.mock('axios');
const axios = require('axios');
const request = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const User = require('../../src/models/User.model');
const Transaction = require('../../src/models/Transaction.model');
const { encryptSecret } = require('../../src/services/secrets.service');
const { createOAuthState, processWebhookEvent } = require('../../src/services/yoco.service');
const { buildYocoApp } = require('../helpers/yocoApp');
beforeAll(setup);
afterAll(teardown);
afterEach(async () => { jest.restoreAllMocks(); axios.get.mockReset(); axios.post.mockReset(); await clearDB(); });
it('archiving clears the connection, then a reconnect routes the webhook to cafe B', async () => {
  const owner = await createTestUser();
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${owner.token}`);
  const first = await Cafe.findById(me.body.activeCafeId);
  const second = await Cafe.create({ name: 'Second Location', orgId: first.orgId });
  await User.updateOne({ _id: owner.user.id }, { $addToSet: { cafeIds: second._id } });
  await Cafe.updateOne({ _id: first._id }, { $set: { yocoConnected: true,
    yocoBusinessId: 'reconnected-business', yocoWebhookSubscriptionId: 'old-sub',
    'yocoTokens.accessToken': encryptSecret('old-access'), 'yocoTokens.refreshToken': encryptSecret('old-refresh') } });
  const archived = await request(app).post(`/api/team/cafes/${first._id}/archive`)
    .set('Authorization', `Bearer ${owner.token}`);
  expect(archived.status).toBe(200);
  const cleared = await Cafe.findById(first._id).select('+yocoTokens.accessToken +yocoTokens.refreshToken').lean();
  expect(cleared.yocoConnected).toBe(false);
  for (const key of ['yocoBusinessId', 'yocoWebhookSubscriptionId']) expect(cleared[key]).toBeUndefined();
  expect(cleared.yocoTokens?.accessToken).toBeUndefined();
  expect(cleared.yocoTokens?.refreshToken).toBeUndefined();
  // Archiving revokes the old sessions; a new login selects the remaining cafe.
  const login = await request(app).post('/api/auth/login').send({ email: owner.user.email, password: 'password123' });
  expect(login.status).toBe(200);
  process.env.YOCO_IAM_URL = 'https://iam.yoco.invalid';
  process.env.YOCO_API_URL = 'https://api.yoco.invalid';
  axios.post.mockResolvedValue({ data: { access_token: 'new-access', refresh_token: 'new-refresh',
    expires_in: 3600, authorized_business_id: 'reconnected-business' } });
  const connected = await request(buildYocoApp()).post('/api/yoco/callback')
    .set('Authorization', `Bearer ${login.body.accessToken}`)
    .send({ code: 'new-code', state: createOAuthState(second._id) });
  expect(connected.status).toBe(200);
  axios.get.mockResolvedValue({ data: { id: 'new-order', created_at: '2026-04-01T08:00:00Z',
    line_items: [{ item_type: 'product', name: 'Latte', quantity: 1, unit_price: { amount: 3500 } }],
    amounts: { gross_amount: { amount: 3500 } } } });
  expect(await processWebhookEvent({ event_type: 'payment.created', business_id: 'reconnected-business', order_id: 'new-order' }))
    .toMatchObject({ status: 'synced', imported: 1 });
  expect(await Transaction.countDocuments({ cafeId: first._id })).toBe(0);
  expect(await Transaction.countDocuments({ cafeId: second._id })).toBe(1);
});
