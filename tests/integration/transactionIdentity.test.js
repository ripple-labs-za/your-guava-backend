const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const {
  resolveIdentities, contentSignature, contentKey, chunksOf,
} = require('../../src/services/transactionIdentity');
const { persistParsedRows } = require('../../src/services/ingestion.service');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const ZONE = 'Africa/Johannesburg';
// 23:30 UTC on 26 Sep is 01:30 on 27 Sep in Johannesburg.
const lateSale = {
  receiptId: '#0001',
  date: new Date('2026-09-26T23:30:00Z'),
  total: 38,
  items: [{ name: 'Flat White', quantity: 1 }],
};

describe('services/transactionIdentity, the one identity rule (BE-11-T05)', () => {
  it('scopes a receipt to the cafe-local trading day when the row has no dateKey', async () => {
    const result = await resolveIdentities([lateSale], { cafeId: new mongoose.Types.ObjectId(), timezone: ZONE });
    expect(result.importable).toEqual([
      { row: lateSale, identity: { type: 'receiptId', value: '#0001', dayKey: '2026-09-27' } },
    ]);
  });

  it('re-imports a pre-content-v1 receipt-less row without duplicating or rewriting it', async () => {
    const cafeId = new mongoose.Types.ObjectId();
    // Frozen SHA-256 of source-v1|fp|2, as persisted before content identity.
    const legacyKey = require('crypto').createHash('sha256').update('source-v1|fp|2').digest('hex');
    const row = { ...lateSale, receiptId: undefined, status: 'approved', hour: 1, dayOfWeek: 0 };
    await Transaction.create({ ...row, cafeId, dedupKey: legacyKey, source: 'csv' });
    const before = await Transaction.findOne({ cafeId }).lean();
    expect(legacyKey).not.toBe(contentKey(contentSignature(row, ZONE), 1));

    const result = await persistParsedRows({ rows: [row], errors: 0, totalRows: 1 }, {
      cafeId, timezone: ZONE,
    });
    expect(result).toMatchObject({ imported: 0, skipped: 1, errors: 0, skippedByReason: { duplicate: 1 } });
    expect(await Transaction.find({ cafeId }).lean()).toEqual([before]);
  });

  it('finds stored identities by trading day and can leave out the upload being remapped', async () => {
    const cafeId = new mongoose.Types.ObjectId();
    const uploadA = new mongoose.Types.ObjectId();
    const uploadB = new mongoose.Types.ObjectId();
    const base = { cafeId, date: lateSale.date, dayOfWeek: 0, hour: 1, total: 38, items: lateSale.items, status: 'approved', source: 'csv' };
    await Transaction.create([
      { ...base, uploadId: uploadA, receiptId: '#0001' },
      { ...base, uploadId: uploadB, dedupKey: 'abc' },
    ]);
    const wanted = [lateSale, { ...lateSale, receiptId: undefined }];
    const all = await resolveIdentities(wanted, { cafeId, timezone: ZONE });
    expect(all.importable).toEqual([]);
    expect(all.duplicates.map(({ uploadId }) => String(uploadId)).sort()).toEqual([String(uploadA), String(uploadB)].sort());
    const withoutA = await resolveIdentities(wanted, { cafeId, timezone: ZONE, excludeUploadId: uploadA });
    expect(withoutA.importable).toEqual([
      { row: lateSale, identity: { type: 'receiptId', value: '#0001', dayKey: '2026-09-27' } },
    ]);
    expect(withoutA.duplicates.map(({ uploadId }) => String(uploadId))).toEqual([String(uploadB)]);
  });

  it('queries in chunks of 500', () => {
    expect(chunksOf(Array.from({ length: 1001 }, (_, index) => index)).map((chunk) => chunk.length)).toEqual([500, 500, 1]);
  });
});
