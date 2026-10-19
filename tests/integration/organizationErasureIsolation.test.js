// Permanent regression from reviewer-b90-2, FB-001: the other organisation is byte-identical after one is erased, a dry run changes nothing anywhere, --apply
// twice is idempotent, a real planted tenant model fails closed, and every hostile Mongo target is refused before connecting.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { setup, teardown, createTestUser } = require('../setup');
const storage = require('../../src/services/r2.service');

for (const file of fs.readdirSync(path.join(__dirname, '../../src/models'))) if (file.endsWith('.model.js')) require(`../../src/models/${file}`);
const erasure = require('../../src/migrations/erase-organization');
const { seedTransactions } = require('../helpers/perf');

jest.setTimeout(300_000);
const storedKeys = [];
beforeAll(setup);
afterAll(async () => {
  try { for (const key of storedKeys) await storage.deleteFile(key); }
  finally { await teardown(); }
});

const ORG_ID = '507f1f77bcf86cd799439011';
const HOSTILE = [
  ['mongodb://localhost.evil.example/guava', 'development'],
  ['mongodb://user:localhost@db.example.com/guava', 'development'],
  ['mongodb://localhost:password@db.example.com/guava', 'development'],
  ['mongodb://db.example.com/localhost', 'development'],
  ['mongodb://db.example.com/guava?target=localhost', 'development'],
  ['mongodb://db.example.com/guava?target=127.0.0.1', 'development'],
  ['mongodb://localhost:27017,db.example.com:27017/guava', 'development'],
  ['mongodb://localhost:27017,127.0.0.1:27018/guava', 'development'],
  ['mongodb+srv://localhost/guava', 'development'],
  ['mongodb://localhost:27017/guava', 'production'],
  ['mongodb://127.0.0.1:27017/guava', ' Production '],
];

test.each(HOSTILE)('refuses %s (NODE_ENV %s) without the override, and before connecting', async (uri, nodeEnv) => {
  expect(() => erasure.assertSafeTarget({ mongoUri: uri, nodeEnv, orgId: ORG_ID })).toThrow('Refusing');
  expect(() => erasure.assertSafeTarget({ mongoUri: uri, nodeEnv, orgId: ORG_ID, confirmation: `ERASE ${ORG_ID}` })).toThrow('Refusing');
  const connect = jest.spyOn(mongoose, 'connect');
  try {
    await expect(erasure.main(['--org', ORG_ID, '--apply', '--requester-note', 'case-1'], { MONGODB_URI: uri, NODE_ENV: nodeEnv })).rejects.toThrow('Refusing');
    expect(connect).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); }
});

// Everything in every collection, keyed by collection then _id, in canonical JSON.
const snapshot = async () => {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    const docs = await mongoose.connection.db.collection(name).find({}).toArray();
    out[name] = new Map(docs.map((doc) => [String(doc._id), JSON.stringify(doc)]));
  }
  return out;
};

const seedOrg = async (label) => {
  const { user, token } = await createTestUser({ email: `${label}-owner@example.test` });
  const orgId = new mongoose.Types.ObjectId(String(user.orgId));
  const cafeId = new mongoose.Types.ObjectId(String(user.activeCafeId));
  const userId = new mongoose.Types.ObjectId(String(user._id || user.id));
  const archived = new mongoose.Types.ObjectId();
  await mongoose.model('Cafe').collection.insertOne({ _id: archived, orgId, name: `${label} archived`, archivedAt: new Date() });
  await seedTransactions(cafeId, { days: 10, perDay: 3, prefix: label });
  await seedTransactions(archived, { days: 5, perDay: 2, prefix: `${label}A` });
  const keys = [`erasure-isolation/${orgId}/live.csv`, `erasure-isolation/${orgId}/archived.csv`];
  storedKeys.push(...keys);
  await storage.uploadFile(Buffer.from(`${label} private receipts`), keys[0], 'text/csv');
  await storage.uploadFile(Buffer.from(`${label} archived receipts`), keys[1], 'text/csv');
  await mongoose.model('Upload').collection.insertMany([{ cafeId, r2Key: keys[0] }, { cafeId: archived, r2Key: keys[1] }]);
  const tag = { orgId, userId, cafeId, email: `${label}-owner@example.test` };
  const row = (extra) => ({ ...extra });
  await mongoose.model('InsightChat').collection.insertMany([row({ orgId, cafeId, userId, title: `${label} chat` }), row({ cafeId: archived, userId, title: `${label} legacy chat` })]);
  await mongoose.model('Improvement').collection.insertOne({ orgId, cafeId, createdBy: { userId, name: `${label} Owner`, email: tag.email }, title: `${label} idea` });
  await mongoose.model('UsageLedger').collection.insertOne({ orgId, cafeId, userId, featureKey: 'chat', credits: 3 });
  await mongoose.model('AccessAuditEvent').collection.insertOne({ orgId, actorUserId: userId, targetUserId: userId, action: `${label} audit` });
  await mongoose.model('TeamInvitation').collection.insertOne({ orgId, email: `${label}-invitee@example.test`, name: `${label} Invitee`, tokenHash: `${label}-invite` });
  await mongoose.model('Staff').collection.insertOne({ cafeId, name: `${label} Barista`, email: `${label}-staff@example.test`, phone: '0820000000' });
  await mongoose.model('PasswordResetToken').collection.insertOne({ userId, tokenHash: `${label}-reset` });
  await mongoose.model('IntegrationOAuthState').collection.insertOne({ cafeId, userId, stateHash: `${label}-state` });
  await mongoose.model('Counter').collection.insertOne({ _id: `improvementTicket:${orgId}`, seq: 4 });
  await mongoose.model('PendingRegistration').collection.insertOne({ email: tag.email, name: `${label} Owner`, tokenHash: `${label}-pending` });
  await mongoose.model('PaymentSession').collection.insertOne({ orgId, userId, reference: `${label}-ref`, amount: 100, currency: 'ZAR', provider: 'mock',
    kind: 'plan', status: 'paid', providerPayload: { email: tag.email }, card: { last4: '1234' }, checkoutUrl: 'https://private.example' });
  return { ...tag, token, cafeIds: [cafeId, archived], keys, markers: [String(orgId), String(userId), String(cafeId), String(archived), tag.email, label,
    require('crypto').createHash('sha256').update(tag.email).digest('hex')] };
};

test('erasing A leaves B byte-identical, a dry run changes nothing, and a second apply is a no-op', async () => {
  const a = await seedOrg('alpha');
  const b = await seedOrg('bravo');
  const before = await snapshot();

  const dry = await erasure.eraseOrganization({ orgId: String(a.orgId) });
  expect(dry.apply).toBe(false);
  const afterDry = await snapshot();
  for (const [name, docs] of Object.entries(before)) expect([name, [...afterDry[name].entries()]]).toEqual([name, [...docs.entries()]]);
  for (const key of [...a.keys, ...b.keys]) await expect(storage.downloadFile(key)).resolves.toBeTruthy();

  await erasure.eraseOrganization({ orgId: String(a.orgId), apply: true, requesterNote: 'case-review-1' });
  const after = await snapshot();
  const touchesA = (json) => a.markers.some((marker) => json.includes(marker));
  let kept = 0;
  for (const [name, docs] of Object.entries(before)) {
    for (const [id, json] of docs) {
      if (touchesA(json)) continue;
      kept += 1;
      expect([name, id, after[name]?.get(id)]).toEqual([name, id, json]); // not A's: byte-identical
    }
  }
  const leftovers = [];
  for (const [name, docs] of Object.entries(after)) {
    for (const [id, json] of docs) if (touchesA(json) && name !== 'erasureRegisters' && name !== 'paymentsessions') leftovers.push(`${name}/${id}`);
  }
  expect(leftovers).toEqual([]);
  const payment = await mongoose.model('PaymentSession').collection.findOne({ orgId: a.orgId });
  expect(Object.keys(payment).sort()).toEqual(['_id', 'amount', 'anonymizedAt', 'currency', 'kind', 'orgId', 'provider', 'reference', 'status']);
  const register = await mongoose.connection.collection('erasureRegisters').findOne({ _id: a.orgId });
  expect(JSON.stringify(register)).not.toMatch(/alpha|example\.test|\.csv/);
  for (const key of a.keys) await expect(storage.downloadFile(key)).rejects.toThrow();
  for (const key of b.keys) await expect(storage.downloadFile(key)).resolves.toBeTruthy();
  expect(kept).toBeGreaterThan(50);

  const afterOnce = await snapshot();
  const again = await erasure.eraseOrganization({ orgId: String(a.orgId), apply: true, requesterNote: 'case-review-1' });
  expect(again.alreadyErased).toBe(true);
  const afterTwice = await snapshot();
  for (const [name, docs] of Object.entries(afterOnce)) expect([name, [...afterTwice[name].entries()]]).toEqual([name, [...docs.entries()]]);
});

test('a real tenant model added without a policy fails closed before anything is counted or changed', async () => {
  const { user } = await createTestUser({ email: 'plant-owner@example.test' });
  mongoose.model('ReviewPlantedTenant', new mongoose.Schema({ orgId: mongoose.Schema.Types.ObjectId, secret: String }));
  try {
    await expect(erasure.eraseOrganization({ orgId: String(user.orgId), apply: true, requesterNote: 'case-plant' })).rejects.toThrow('ReviewPlantedTenant');
    expect(await mongoose.model('Organization').countDocuments({ _id: user.orgId })).toBe(1);
  } finally { mongoose.deleteModel('ReviewPlantedTenant'); }
});
