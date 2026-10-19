const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');
const storage = require('../../src/services/r2.service');

// Loading every model makes this fail when a future tenant model lacks a policy.
for (const file of fs.readdirSync(path.join(__dirname, '../../src/models'))) {
  if (file.endsWith('.model.js')) require(`../../src/models/${file}`);
}
const erasure = () => require('../../src/migrations/erase-organization');
const oid = () => new mongoose.Types.ObjectId();
let orgId; let cafeId; let userId; let foreignOrg; let foreignCafe; let foreignUser;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => { jest.restoreAllMocks(); await clearDB(); });

async function fixture() {
  orgId = oid(); cafeId = oid(); userId = oid();
  foreignOrg = oid(); foreignCafe = oid(); foreignUser = oid();
  await mongoose.model('Organization').collection.insertMany([
    { _id: orgId, ownerId: userId, name: 'Erase me' },
    { _id: foreignOrg, ownerId: foreignUser, name: 'Keep me' },
  ]);
  await mongoose.model('Cafe').collection.insertMany([
    { _id: cafeId, orgId, archivedAt: new Date() },
    { _id: foreignCafe, orgId: foreignOrg },
  ]);
  await mongoose.model('User').collection.insertMany([
    { _id: userId, orgId, email: 'erase@example.test' },
    { _id: foreignUser, orgId: foreignOrg, email: 'keep@example.test' },
  ]);
}

test('every current tenant model has an explicit erasure policy; a future model fails closed', () => {
  const { assertModelCoverage, POLICIES } = erasure();
  expect(() => assertModelCoverage()).not.toThrow();
  const future = { modelName: 'ForgottenTenant', schema: new mongoose.Schema({ cafeId: mongoose.Schema.Types.ObjectId }) };
  expect(() => assertModelCoverage([...Object.values(mongoose.models), future])).toThrow('ForgottenTenant');
  expect(POLICIES.PaymentSession.action).toBe('anonymize');
});

test('dry run counts archived cafes, every cascade collection and files without modifying anything', async () => {
  await fixture();
  await mongoose.model('Upload').collection.insertOne({ cafeId, r2Key: 'erasure/test.csv' });
  const deleteFile = jest.spyOn(storage, 'deleteFile').mockResolvedValue();
  const before = await mongoose.model('Upload').find({}).lean();
  const report = await erasure().eraseOrganization({ orgId: String(orgId) });
  expect(report.apply).toBe(false);
  expect(report.counts.Cafe).toEqual({ action: 'delete', documents: 1, files: 0 });
  expect(report.counts.Upload).toEqual({ action: 'delete', documents: 1, files: 1 });
  expect(await mongoose.model('Upload').find({}).lean()).toEqual(before);
  expect(await mongoose.model('Organization').countDocuments()).toBe(2);
  expect(await mongoose.connection.collection('erasureRegisters').countDocuments()).toBe(0);
  expect(deleteFile).not.toHaveBeenCalled();
});

test('apply erases every scoped model, deletes stored files, anonymizes invoices and is idempotent', async () => {
  await fixture();
  const { POLICIES, eraseOrganization } = erasure();
  const direct = new Set(['Organization', 'Cafe', 'User', 'Counter', 'PendingRegistration', 'AuthThrottle']);
  for (const [name, policy] of Object.entries(POLICIES)) {
    if (policy.action === 'keep' || direct.has(name)) continue;
    await mongoose.model(name).collection.insertMany([
      { orgId, cafeId, userId, staffId: userId, tokenHash: `erase-${name}`, stateHash: `erase-${name}`,
        familyId: `erase-${name}`, reference: `erase-${name}`, r2Key: 'erasure/test.csv',
        amount: 100, currency: 'ZAR', provider: 'mock', kind: 'plan', status: 'paid',
        providerPayload: { email: 'erase@example.test' }, card: { last4: '1234' },
        checkoutUrl: 'https://private.example', futurePersonalField: 'private' },
      { orgId: foreignOrg, cafeId: foreignCafe, userId: foreignUser, staffId: foreignUser,
        tokenHash: `keep-${name}`, stateHash: `keep-${name}`, familyId: `keep-${name}`, reference: `keep-${name}` },
    ]);
  }
  await mongoose.model('Counter').collection.insertMany([
    { _id: `improvementTicket:${orgId}`, seq: 5 }, { _id: `improvementTicket:${foreignOrg}`, seq: 6 },
  ]);
  await mongoose.model('PendingRegistration').collection.insertMany([
    { email: 'erase@example.test', tokenHash: 'erase' }, { email: 'keep@example.test', tokenHash: 'keep' },
  ]);
  const foreignPayment = await mongoose.model('PaymentSession').collection.findOne({ orgId: foreignOrg });
  const deleteFile = jest.spyOn(storage, 'deleteFile').mockResolvedValue();
  const report = await eraseOrganization({ orgId: String(orgId), apply: true, requesterNote: 'case-105' });
  expect(report.apply).toBe(true);
  expect(deleteFile).toHaveBeenCalledWith('erasure/test.csv');
  for (const [name, policy] of Object.entries(POLICIES)) {
    if (policy.action !== 'delete') continue;
    expect([name, await mongoose.model(name).countDocuments()]).toEqual([name, name === 'AuthThrottle' ? 0 : 1]);
  }
  const payment = await mongoose.model('PaymentSession').collection.findOne({ orgId });
  expect(payment).toEqual({
    _id: expect.any(mongoose.Types.ObjectId), orgId, reference: 'erase-PaymentSession',
    amount: 100, currency: 'ZAR', provider: 'mock', kind: 'plan', status: 'paid', anonymizedAt: expect.any(Date),
  });
  expect(await mongoose.model('PaymentSession').collection.findOne({ orgId: foreignOrg })).toEqual(foreignPayment);
  const register = await mongoose.connection.collection('erasureRegisters').findOne({ _id: orgId });
  expect(Object.keys(register).sort()).toEqual(['_id', 'counts', 'erasedAt', 'requesterNote']);
  expect(register.requesterNote).toBe('case-105');
  expect(JSON.stringify(register)).not.toMatch(/erase@example|private|test.csv|1234/);
  const again = await eraseOrganization({ orgId: String(orgId), apply: true, requesterNote: 'case-105' });
  expect(again.alreadyErased).toBe(true);
  expect(deleteFile).toHaveBeenCalledTimes(1);
  expect(await mongoose.connection.collection('erasureRegisters').countDocuments()).toBe(1);
});

test('local upload bytes are actually removed and a failed database transaction can retry them', async () => {
  await fixture();
  const key = `erasure/${orgId}/test.csv`;
  await storage.uploadFile(Buffer.from('private,receipt'), key, 'text/csv');
  await mongoose.model('Upload').collection.insertOne({ cafeId, r2Key: key });
  const register = mongoose.connection.collection('erasureRegisters');
  const insert = jest.spyOn(register, 'insertOne').mockRejectedValueOnce(new Error('receipt unavailable'));
  const options = { orgId: String(orgId), apply: true, requesterNote: 'case-105' };
  await expect(erasure().eraseOrganization(options)).rejects.toThrow('receipt unavailable');
  await expect(storage.downloadFile(key)).rejects.toThrow(/ENOENT/);
  expect(await mongoose.model('Organization').countDocuments({ _id: orgId })).toBe(1);
  expect(await mongoose.model('Upload').countDocuments({ cafeId })).toBe(1);
  expect(await register.countDocuments()).toBe(0);
  insert.mockRestore();
  await erasure().eraseOrganization(options);
  expect(await mongoose.model('Organization').countDocuments({ _id: orgId })).toBe(0);
  expect(await mongoose.model('Upload').countDocuments({ cafeId })).toBe(0);
  expect(await register.countDocuments()).toBe(1);
});

test('a failed stored-file deletion retains metadata for retry and writes no completed register', async () => {
  await fixture();
  await mongoose.model('Upload').collection.insertOne({ cafeId, r2Key: 'erasure/test.csv' });
  jest.spyOn(storage, 'deleteFile').mockRejectedValue(new Error('storage unavailable'));
  await expect(erasure().eraseOrganization({ orgId: String(orgId), apply: true, requesterNote: 'case-105' }))
    .rejects.toThrow('storage unavailable');
  expect(await mongoose.model('Organization').countDocuments({ _id: orgId })).toBe(1);
  expect(await mongoose.model('Upload').countDocuments({ cafeId })).toBe(1);
  expect(await mongoose.connection.collection('erasureRegisters').countDocuments()).toBe(0);
});

test('refuses missing, malformed and nonexistent ids and a personal requester note', async () => {
  const { eraseOrganization } = erasure();
  await expect(eraseOrganization({})).rejects.toThrow('--org');
  await expect(eraseOrganization({ orgId: 'bad' })).rejects.toThrow('--org');
  await expect(eraseOrganization({ orgId: String(oid()) })).rejects.toThrow('not found');
  await expect(eraseOrganization({ orgId: String(oid()), apply: true, requesterNote: 'owner@example.test' }))
    .rejects.toThrow('case reference');
});
