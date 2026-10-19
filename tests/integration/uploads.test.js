const mockR2Files = new Map();
let mockR2DeleteError = null;
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => {
    if (mockR2DeleteError) throw mockR2DeleteError;
    mockR2Files.delete(key);
  },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const path = require('path');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2DeleteError = null;
  mockR2Files.clear();
  await clearDB();
});

const yocoFixture = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

describe('Uploads API', () => {
  let token;

  beforeEach(async () => {
    const u = await createTestUser();
    token = u.token;
  });

  describe('POST /api/uploads/:id/confirm', () => {
    it('parses transactions and marks upload completed', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const uploadId = stage.body.uploadId;

      const confirm = await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(confirm.status).toBe(200);
      expect(confirm.body.success).toBe(true);
      expect(confirm.body.stats.imported).toBe(4);

      const txns = await Transaction.find({ uploadId }).lean();
      expect(txns).toHaveLength(4);
      expect(txns[0].uploadId.toString()).toBe(uploadId);
    });

    it('imports a till that writes Completed instead of Approved', async () => {
      // Yoco writes "Approved"; nothing guarantees the next vendor does. This file
      // used to import 0 of 3 rows and report "0 errors", which reads as a broken
      // importer rather than a vocabulary mismatch.
      const csv = Buffer.from([
        'Receipt,Date,Time,Status,Items,Total (incl. tax)',
        '2026/04/000001,2026/04/01,09:30:00,Completed,1 x Flat White,38.00',
        '2026/04/000002,2026/04/01,10:15:00,Paid,2 x Latte,80.00',
        '2026/04/000003,2026/04/01,11:00:00,Successful,1 x Croissant,32.00',
      ].join(String.fromCharCode(10)));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'completed-status.csv');

      const confirm = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(confirm.status).toBe(200);
      expect(confirm.body.stats.imported).toBe(3);
      expect(confirm.body.stats.skipped).toBe(0);
    });

    it('names the word it did not recognise instead of silently skipping the row', async () => {
      const csv = Buffer.from([
        'Receipt,Date,Time,Status,Items,Total (incl. tax)',
        '2026/04/000001,2026/04/01,09:30:00,Approved,1 x Flat White,38.00',
        '2026/04/000002,2026/04/01,10:15:00,Banana,2 x Latte,80.00',
        '2026/04/000003,2026/04/01,11:00:00,Declined,1 x Croissant,32.00',
      ].join(String.fromCharCode(10)));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'unknown-status.csv');

      const confirm = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(confirm.status).toBe(200);
      expect(confirm.body.stats.imported).toBe(1);
      expect(confirm.body.stats.skipped).toBe(2);
      // The breakdown says why, and the unknown word is named. "Declined" is
      // understood, so it needs no row error - only the word we did not know does.
      expect(confirm.body.stats.skippedByReason).toEqual(
        expect.objectContaining({ status_not_approved: 2 })
      );
      // confirmationResponse() returns rowErrors at the top level, not inside stats
      const reasons = (confirm.body.rowErrors || []).map((e) => e.reason);
      expect(reasons).toEqual(
        expect.arrayContaining([expect.stringMatching(/"Banana" is not a recognised/)])
      );
      expect(reasons.join(' ')).not.toMatch(/Declined/);
    });

    it('stages and confirms semicolon CSVs with normalised headers', async () => {
      const csv = Buffer.from([
        '\uFEFF Sale Date ; Sale Time ; Description ; Amount ',
        '2026-04-01;09:30;Flat White;R 35,00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'semicolon.csv');

      expect(stage.status).toBe(200);
      expect(stage.body.headers).toEqual(['Sale Date', 'Sale Time', 'Description', 'Amount']);

      const confirm = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            date: 'Sale Date',
            time: 'Sale Time',
            items: 'Description',
            total: 'Amount',
          },
          itemsMode: 'packed',
        });

      expect(confirm.status).toBe(200);
      expect(confirm.body.stats.imported).toBe(1);

      const tx = await Transaction.findOne({ uploadId: stage.body.uploadId }).lean();
      expect(tx.total).toBe(35);
      expect(tx.hour).toBe(9);
    });

    it('persists row-level errors for partially valid uploads', async () => {
      const csv = Buffer.from([
        'Receipt,Date,Time,Items,Total',
        'R500,2026-04-01,08:30,1 x Flat White,35.00',
        'R501,not-a-date,08:45,1 x Muffin,25.00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'partial-errors.csv');

      const confirm = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            receiptId: 'Receipt',
            date: 'Date',
            time: 'Time',
            items: 'Items',
            total: 'Total',
          },
          itemsMode: 'packed',
        });

      expect(confirm.status).toBe(200);
      expect(confirm.body.stats).toMatchObject({ imported: 1, errors: 1, totalRows: 2 });
      expect(confirm.body.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 3,
          reason: 'Could not parse date or time',
        }),
      ]);
      expect(confirm.body.rowErrors[0]).not.toHaveProperty('raw');

      const detail = await request
        .get(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(detail.body.upload.rowErrors).toHaveLength(1);
      expect(detail.body.upload.rowErrors[0]).toMatchObject({
        rowNumber: 3,
        reason: 'Could not parse date or time',
      });
    });

    it('replays a completed confirmation without importing duplicate transactions', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const uploadId = stage.body.uploadId;
      await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      const second = await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.stats.imported).toBe(4);
      expect(await Transaction.countDocuments({ uploadId })).toBe(4);
    });

    it('returns 400 when required fields are missing from mapping', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: { date: 'Date' }, itemsMode: 'packed' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when line-per-row mapping has no receipt ID', async () => {
      const csv = Buffer.from([
        'Date,Time,Item,Qty,Line Total',
        '2026-04-01,08:30,Flat White,1,35.00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'line-without-receipt.csv');

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            date: 'Date',
            time: 'Time',
            items: 'Item',
            quantity: 'Qty',
            total: 'Line Total',
          },
          itemsMode: 'line-per-row',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/receiptId/i);
    });

    it('returns 400 when a mapped column is not present in the staged file', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            ...stage.body.columnMapping,
            total: 'Definitely Not A Column',
          },
          itemsMode: 'packed',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not in this file/i);
    });

    it('returns 400 when the file has headers but no transaction rows', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('Date,Items,Total\n'), 'empty.csv');

      expect(stage.status).toBe(200);

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
          itemsMode: 'packed',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no transaction rows/i);
    });

    it('returns 400 when no approved transaction rows are present', async () => {
      const csv = Buffer.from([
        'Receipt,Date,Time,Status,Items,Total',
        'D1,2026-04-01,08:30,declined,1 x Flat White,35.00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'declined-only.csv');

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            receiptId: 'Receipt',
            date: 'Date',
            time: 'Time',
            status: 'Status',
            items: 'Items',
            total: 'Total',
          },
          itemsMode: 'packed',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no approved transaction rows/i);

      const txns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(txns).toHaveLength(0);
    });

    it('does not mark duplicate-only uploads as successful imports', async () => {
      const firstStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const firstConfirm = await request
        .post(`/api/uploads/${firstStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: firstStage.body.columnMapping, itemsMode: firstStage.body.itemsMode });
      expect(firstConfirm.status).toBe(200);

      const secondStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const secondConfirm = await request
        .post(`/api/uploads/${secondStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: secondStage.body.columnMapping, itemsMode: secondStage.body.itemsMode });

      expect(secondConfirm.status).toBe(409);
      expect(secondConfirm.body.message).toMatch(/already exists/i);

      const secondTxns = await Transaction.find({ uploadId: secondStage.body.uploadId }).lean();
      expect(secondTxns).toHaveLength(0);

      const upload = await Upload.findById(secondStage.body.uploadId).lean();
      expect(upload.status).toBe('failed');
      expect(upload.errorMessage).toMatch(/already exists/i);
      expect(await Transaction.countDocuments({})).toBe(4);
    });

    it('does not allow a deleted upload to be confirmed', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);

      await Upload.updateOne({ _id: stage.body.uploadId }, { $set: { status: 'deleted' } });

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(res.status).toBe(404);
    });
  });

  describe('post-import maintenance recovery', () => {
    it('retries a due partial failure and records the bounded attempt', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      await Upload.updateOne(
        { _id: stage.body.uploadId },
        {
          $set: {
            'maintenance.status': 'partial_failure',
            'maintenance.attempts': 1,
            'maintenance.nextRetryAt': new Date(Date.now() - 1000),
            'maintenance.errors': ['weather provider unavailable'],
          },
          $unset: {
            'maintenance.retryExhaustedAt': '',
          },
        }
      );

      const { recoverPendingUploadMaintenance } = require('../../src/controllers/uploads.controller');
      const summary = await recoverPendingUploadMaintenance({ limit: 1 });
      const upload = await Upload.findById(stage.body.uploadId).lean();

      expect(summary).toMatchObject({ scanned: 1, completed: 1, failed: 0 });
      expect(upload.maintenance.status).toBe('completed');
      expect(upload.maintenance.attempts).toBe(2);
      expect(upload.maintenance.nextRetryAt).toBeUndefined();
    });
  });

  describe('GET /api/uploads', () => {
    it('returns uploads for the current cafe in reverse chronological order', async () => {
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);

      const res = await request.get('/api/uploads').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.uploads).toHaveLength(2);
      expect(new Date(res.body.uploads[0].createdAt).getTime())
        .toBeGreaterThanOrEqual(new Date(res.body.uploads[1].createdAt).getTime());
    });

    it('does not leak uploads across cafes', async () => {
      const other = await createTestUser({ email: 'b@yourguava.com', cafeName: 'Cafe B', orgName: 'Org B' });
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${other.token}`)
        .attach('file', yocoFixture);
      const res = await request.get('/api/uploads').set('Authorization', `Bearer ${token}`);
      expect(res.body.uploads).toHaveLength(0);
    });
  });

  describe('GET /api/uploads/:id', () => {
    it('returns the upload record with a signed download URL', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const res = await request
        .get(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.upload._id).toBe(stage.body.uploadId);
      expect(res.body.upload.status).toBe('completed');
      expect(res.body.downloadUrl).toMatch(/^https:\/\//);
    });

    it("returns 404 for another cafe's upload", async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const other = await createTestUser({ email: 'c@yourguava.com', cafeName: 'Cafe C', orgName: 'Org C' });
      const res = await request
        .get(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${other.token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/uploads/:id/rows', () => {
    it('returns paginated transactions linked to this upload', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const res = await request
        .get(`/api/uploads/${stage.body.uploadId}/rows`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(4);
      expect(res.body.transactions[0].uploadId).toBe(stage.body.uploadId);
    });
  });

  describe('PATCH /api/uploads/:id/mapping', () => {
    it('re-parses with new mapping, replacing transactions', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const before = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(before).toHaveLength(4);

      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(res.status).toBe(200);
      expect(res.body.stats.imported).toBe(4);
      const after = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(after).toHaveLength(4);
    });

    it('preserves transactions when re-parse fails (atomicity)', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const beforeTxns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(beforeTxns).toHaveLength(4);

      // Inject a parse failure via spy so we bypass the 400 guard
      const parserService = require('../../src/services/parser.service');
      const spy = jest.spyOn(parserService, 'parseBuffer').mockRejectedValueOnce(
        new Error('injected parse failure')
      );

      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      spy.mockRestore();

      // The request should have failed
      expect(res.status).toBeGreaterThanOrEqual(500);

      // Original transactions must still exist — atomicity preserved
      const afterTxns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(afterTxns).toHaveLength(4);
    });

    it('rolls back the replacement when persistence fails after transactional deletion', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const Item = require('../../src/models/Item.model');
      const itemsBefore = await Item.find({}).sort({ _id: 1 }).lean();
      const ingestionService = require('../../src/services/ingestion.service');
      const persistSpy = jest.spyOn(ingestionService, 'persistParsedRows')
        .mockRejectedValueOnce(new Error('injected persistence failure'));

      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: { ...stage.body.columnMapping, items: 'Payment Method' },
          itemsMode: stage.body.itemsMode,
        });
      persistSpy.mockRestore();

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await Transaction.countDocuments({ uploadId: stage.body.uploadId })).toBe(4);
      const upload = await Upload.findById(stage.body.uploadId).lean();
      expect(upload.status).toBe('completed');
      expect(upload.stats.imported).toBe(4);
      expect(await Item.find({}).sort({ _id: 1 }).lean()).toEqual(itemsBefore);
    });

    it('preserves transactions when re-map parses no valid rows', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const beforeTxns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(beforeTxns).toHaveLength(4);

      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            ...stage.body.columnMapping,
            date: 'Payment Method',
          },
          itemsMode: stage.body.itemsMode,
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no valid transaction rows/i);

      const afterTxns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(afterTxns).toHaveLength(4);
    });

    it('preserves transactions when re-map would duplicate another upload', async () => {
      const csv = Buffer.from([
        'Receipt,Date,Time,Items,Total',
        'R900,2026-04-01,08:30,1 x Flat White,35.00',
      ].join('\n'));
      const mappingWithoutReceipt = {
        date: 'Date',
        time: 'Time',
        items: 'Items',
        total: 'Total',
      };
      const mappingWithReceipt = {
        receiptId: 'Receipt',
        ...mappingWithoutReceipt,
      };

      const firstStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'receiptless.csv');
      await request
        .post(`/api/uploads/${firstStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mappingWithoutReceipt, itemsMode: 'packed' });

      const secondStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'receipted.csv');
      await request
        .post(`/api/uploads/${secondStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mappingWithReceipt, itemsMode: 'packed' });

      const beforeTxns = await Transaction.find({ uploadId: firstStage.body.uploadId }).lean();
      expect(beforeTxns).toHaveLength(1);

      const res = await request
        .patch(`/api/uploads/${firstStage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mappingWithReceipt, itemsMode: 'packed' });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/leave this upload empty/i);

      const afterTxns = await Transaction.find({ uploadId: firstStage.body.uploadId }).lean();
      expect(afterTxns).toHaveLength(1);

      const Upload = require('../../src/models/Upload.model');
      const upload = await Upload.findById(firstStage.body.uploadId).lean();
      expect(upload.status).toBe('completed');
      expect(upload.columnMapping.receiptId).toBeUndefined();
    });

    it('counts a receipt number reused on other days as importable when remapping', async () => {
      // Tills that restart numbering each morning reuse "#0001" daily. The
      // write path scopes a receipt by its cafe-local trading day, but the
      // remap pre-check keyed on the number alone and refused the remap as
      // if every row were already held by the earlier upload.
      const mapping = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
      const earlier = Buffer.from([
        'Receipt,Date,Time,Items,Total',
        '#0001,2026-04-03,08:30,1 x Flat White,35.00',
      ].join('\n'));
      const firstStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', earlier, 'day-three.csv');
      const firstConfirm = await request
        .post(`/api/uploads/${firstStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mapping, itemsMode: 'packed' });
      expect(firstConfirm.status).toBe(200);

      const reused = Buffer.from([
        'Receipt,Date,Time,Items,Total',
        '#0001,2026-04-01,08:30,1 x Flat White,35.00',
        '#0001,2026-04-02,08:30,1 x Muffin,25.00',
      ].join('\n'));
      const secondStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', reused, 'reused-numbers.csv');
      const secondConfirm = await request
        .post(`/api/uploads/${secondStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mapping, itemsMode: 'packed' });
      expect(secondConfirm.status).toBe(200);
      expect(secondConfirm.body.stats.imported).toBe(2);

      const res = await request
        .patch(`/api/uploads/${secondStage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mapping, itemsMode: 'packed' });

      expect(res.status).toBe(200);
      expect(res.body.stats.imported).toBe(2);
      expect(await Transaction.countDocuments({ uploadId: secondStage.body.uploadId })).toBe(2);
      expect(await Transaction.countDocuments({ receiptId: '#0001' })).toBe(3);
    });

    it('returns 409 when status is parsing', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const Upload = require('../../src/models/Upload.model');
      await Upload.updateOne({ _id: stage.body.uploadId }, { $set: { status: 'parsing' } });
      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      expect(res.status).toBe(409);
    });

    it('recovers a stale parsing lease and allows retry', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await Upload.collection.updateOne(
        { _id: new (require('mongoose').Types.ObjectId)(stage.body.uploadId) },
        {
          $set: {
            status: 'parsing',
            updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        }
      );

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(res.status).toBe(200);
      expect(await Transaction.countDocuments({ uploadId: stage.body.uploadId })).toBe(4);
    });
  });

  describe('abandoned pending upload cleanup', () => {
    it('removes storage and soft-deletes expired unconfirmed uploads', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const staged = await Upload.findById(stage.body.uploadId).lean();
      await Upload.collection.updateOne(
        { _id: staged._id },
        { $set: { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }
      );

      const { cleanupAbandonedPendingUploads } = require('../../src/controllers/uploads.controller');
      const summary = await cleanupAbandonedPendingUploads({ olderThanMs: 60 * 60 * 1000 });

      expect(summary).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
      expect(mockR2Files.has(staged.r2Key)).toBe(false);
      const deleted = await Upload.findById(staged._id).lean();
      expect(deleted).toEqual(expect.objectContaining({
        status: 'deleted',
        r2Key: `deleted/${staged._id}`,
        fileName: 'deleted-upload',
        fileSize: 0,
        headers: [],
        sampleRows: [],
        rowErrors: [],
        columnMapping: {},
      }));
      expect(deleted.fileFingerprint).toBeUndefined();
      expect(deleted.confirmation).toBeUndefined();
      expect(deleted.dateRange).toBeUndefined();
    });
  });

  describe('DELETE /api/uploads/:id', () => {
    it('owner soft-deletes upload, removing transactions and R2 object', async () => {
      const Item = require('../../src/models/Item.model');
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const brownieBefore = await Item.findOne({ name: 'Brownie' }).lean();
      expect(brownieBefore.totalSold).toBe(4);

      const res = await request
        .delete(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const txns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(txns).toHaveLength(0);

      const Upload = require('../../src/models/Upload.model');
      const u = await Upload.findById(stage.body.uploadId).lean();
      expect(u.status).toBe('deleted');

      // BE-03-T10 (gap-4): an imported item nobody touched, left with no sales, is removed rather than kept at 0 in the
      // review queue; an item the owner edited survives (menuCorrections.test.js).
      const brownieAfter = await Item.findOne({ name: 'Brownie' }).lean();
      expect(brownieAfter).toBeNull();
    });

    it('rolls back transaction deletion when the item rebuild fails', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      const staged = await Upload.findById(stage.body.uploadId).lean();
      const Item = require('../../src/models/Item.model');
      const brownieBefore = await Item.findOne({ name: 'Brownie' }).lean();
      expect(brownieBefore.totalSold).toBe(4);
      const ingestionService = require('../../src/services/ingestion.service');
      const rebuildItemsForCafe = ingestionService.rebuildItemsForCafe;
      const rebuildSpy = jest.spyOn(ingestionService, 'rebuildItemsForCafe')
        .mockImplementationOnce(async (...args) => {
          await rebuildItemsForCafe(...args);
          throw new Error('injected item rebuild failure');
        });

      const res = await request
        .delete(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);
      rebuildSpy.mockRestore();

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await Transaction.countDocuments({ uploadId: stage.body.uploadId })).toBe(4);
      expect((await Upload.findById(stage.body.uploadId).lean()).status).toBe('completed');
      expect(mockR2Files.has(staged.r2Key)).toBe(true);
      expect((await Item.findOne({ name: 'Brownie' }).lean()).totalSold).toBe(4);
    });

    it('marks failed storage deletion for bounded background retry', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      const staged = await Upload.findById(stage.body.uploadId).lean();
      mockR2DeleteError = new Error('temporary storage outage');

      const res = await request
        .delete(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const pendingCleanup = await Upload.findById(stage.body.uploadId).lean();
      expect(pendingCleanup.status).toBe('deleted');
      expect(pendingCleanup.errorMessage).toMatch(/background cleanup/i);
      expect(mockR2Files.has(staged.r2Key)).toBe(true);

      mockR2DeleteError = null;
      const { cleanupAbandonedPendingUploads } = require('../../src/controllers/uploads.controller');
      const summary = await cleanupAbandonedPendingUploads({ limit: 10 });

      expect(summary.storageRetried).toBe(1);
      expect(mockR2Files.has(staged.r2Key)).toBe(false);
      expect((await Upload.findById(stage.body.uploadId).lean()).errorMessage).toBeUndefined();
    });
  });

  describe('Upload triggers actuals back-fill', () => {
    // The fixture's approved sales are on 15 and 16 January 2026 (the 15th's third row is Declined).
    it('after confirm, fills actuals for each day in the upload range and no other', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const { zonedDateTimeToUtc } = require('../../src/utils/timezone');
      const me = await request.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      const cafeId = me.body.activeCafeId;
      expect(cafeId).toBeTruthy();
      const day = (d) => zonedDateTimeToUtc({ year: 2026, month: 1, day: d }, 'Africa/Johannesburg');
      for (const d of [14, 15, 16]) {
        await Forecast.create({ cafeId, date: day(d), generatedAt: new Date(), items: [], totalPredictedRevenue: 100 });
      }

      const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', yocoFixture);
      const confirm = await request.post(`/api/uploads/${stage.body.uploadId}/confirm`).set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      expect(confirm.status).toBe(200);

      const [d14, d15, d16] = await Promise.all([14, 15, 16].map((d) => Forecast.findOne({ cafeId, date: day(d) }).lean()));
      expect(d15.actualsUpdatedAt).toBeTruthy();
      expect(d15.actualRevenue).toBeGreaterThan(0);
      expect(d16.actualsUpdatedAt).toBeTruthy();
      expect(d16.actualRevenue).toBeGreaterThan(0);
      expect(d14.actualsUpdatedAt).toBeUndefined();
    });
  });

  describe('Deleting an upload that imported nothing', () => {
    it('leaves the forecast horizon and dataUploaded alone', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const Cafe = require('../../src/models/Cafe.model');
      const mongoose = require('mongoose');

      const u = await createTestUser({ email: 'zero@yourguava.com', cafeName: 'Cafe Zero', orgName: 'Org Zero' });
      const cafeId = u.user?.cafeIds?.[0];
      if (!cafeId) throw new Error('test user did not expose a cafeId');

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      await Forecast.create({
        cafeId, date: tomorrow, generatedAt: new Date(), items: [], predictedRevenue: 1234,
      });
      await Cafe.updateOne({ _id: cafeId }, { $set: { dataUploaded: true } });

      // An upload that was staged and abandoned: no transactions ever linked to it.
      const stranded = await Upload.create({
        cafeId,
        uploadedBy: new mongoose.Types.ObjectId(u.user.id || u.user._id),
        fileName: 'abandoned.csv',
        fileSize: 10,
        posType: 'wizard',
        r2Key: 'uploads/test/abandoned.csv',
        status: 'pending_mapping',
        stats: { imported: 0, skipped: 0, errors: 0, totalRows: 0 },
      });

      const res = await request
        .delete(`/api/uploads/${stranded._id}`)
        .set('Authorization', `Bearer ${u.token}`);

      expect(res.status).toBe(200);
      // The forecast horizon must survive: this upload contributed no data, so
      // nothing about the model's inputs changed.
      expect(await Forecast.countDocuments({ cafeId })).toBe(1);
      expect((await Cafe.findById(cafeId).lean()).dataUploaded).toBe(true);
      expect((await Upload.findById(stranded._id).lean()).status).toBe('deleted');
    });

    it('still clears the horizon when the upload did import rows', async () => {
      const Forecast = require('../../src/models/Forecast.model');

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const upload = await Upload.findById(stage.body.uploadId).lean();
      const cafeId = upload.cafeId;
      expect(await Transaction.countDocuments({ cafeId, uploadId: upload._id })).toBeGreaterThan(0);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      await Forecast.deleteMany({ cafeId });
      await Forecast.create({
        cafeId, date: tomorrow, generatedAt: new Date(), items: [], predictedRevenue: 99,
      });

      await request
        .delete(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Its rows are gone, so every forecast built on them is stale and must go.
      expect(await Forecast.countDocuments({ cafeId, date: { $gte: tomorrow } })).toBe(0);
      expect(await Transaction.countDocuments({ cafeId, uploadId: upload._id })).toBe(0);
    });
  });

  describe('Mapping source', () => {
    it('records a Yoco preset as yoco', async () => {
      const stage = await request.post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`).attach('file', yocoFixture);
      expect(stage.body.mappingSource).toBe('yoco');
      expect((await Upload.findById(stage.body.uploadId).lean()).mappingSource).toBe('yoco');
    });

    it('records an unknown shape with no AI as none, then manual once the wizard answers', async () => {
      const csv = Buffer.from([
        'Whenever,Whatever,Howmuch',
        '2026/08/01,1 x Flat White,38.00',
      ].join(String.fromCharCode(10)));

      const stage = await request.post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`).attach('file', csv, 'unknown-shape.csv');
      expect(stage.body.mappingSource).toBe('none');
      expect(stage.body.needsConfirmation).toBe(true);

      await request.post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: { date: 'Whenever', items: 'Whatever', total: 'Howmuch' },
          itemsMode: 'packed',
        })
        .expect(200);

      expect((await Upload.findById(stage.body.uploadId).lean()).mappingSource).toBe('manual');
    });
  });

  describe('Idempotency-Key on confirm and remap', () => {
    const stageGeneric = async (name) => {
      const csv = Buffer.from([
        'Whenever,Whatever,Howmuch',
        '2026/09/01,1 x Flat White,38.00',
        '2026/09/02,2 x Latte,80.00',
      ].join(String.fromCharCode(10)));
      return request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, name);
    };
    const MAP_A = { date: 'Whenever', items: 'Whatever', total: 'Howmuch' };

    it('replays a confirm sent twice with the same key, importing once', async () => {
      const stage = await stageGeneric('idem-a.csv');
      const send = () => request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-alpha')
        .send({ columnMapping: MAP_A, itemsMode: 'packed' });

      const first = await send();
      expect(first.status).toBe(200);
      expect(first.body.stats.imported).toBe(2);

      const before = await Transaction.countDocuments({ uploadId: stage.body.uploadId });
      const second = await send();
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(await Transaction.countDocuments({ uploadId: stage.body.uploadId })).toBe(before);
    });

    it('refuses the same key carrying a different mapping, and says which problem it is', async () => {
      const stage = await stageGeneric('idem-b.csv');
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-beta')
        .send({ columnMapping: MAP_A, itemsMode: 'packed' })
        .expect(200);

      const reused = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-beta')
        .send({
          columnMapping: { date: 'Whenever', items: 'Whatever', total: 'Whatever' },
          itemsMode: 'packed',
        });

      expect(reused.status).toBe(409);
      // A reused key is a client bug, not an owner asking to change the mapping:
      // the two need different codes so the portal can tell them apart.
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('still treats a different key with a different mapping as a remap request', async () => {
      const stage = await stageGeneric('idem-c.csv');
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-gamma')
        .send({ columnMapping: MAP_A, itemsMode: 'packed' })
        .expect(200);

      const other = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-delta')
        .send({
          columnMapping: { date: 'Whenever', items: 'Whatever', total: 'Whatever' },
          itemsMode: 'packed',
        });

      expect(other.status).toBe(409);
      expect(other.body.code).not.toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('records the key a remap was sent with, instead of discarding it', async () => {
      const stage = await stageGeneric('idem-d.csv');
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-eps')
        .send({ columnMapping: MAP_A, itemsMode: 'packed' })
        .expect(200);

      await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'key-remap')
        .send({ columnMapping: MAP_A, itemsMode: 'packed' })
        .expect(200);

      const after = await Upload.findById(stage.body.uploadId).lean();
      expect(after.confirmation.idempotencyKeyHash).toBeTruthy();
    });
  });

  describe('Forecast invalidation', () => {
    it('preserves historical forecasts and refreshes planning forecasts on successful confirm', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      // Get cafeId from the registered user
      const u = await createTestUser({ email: 'd@yourguava.com', cafeName: 'Cafe D', orgName: 'Org D' });
      const cafeId = u.user.activeCafeId;
      expect(cafeId).toBeTruthy();

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      // Historical forecasts are needed for predicted-vs-actual review.
      await Forecast.create({
        cafeId,
        date: yesterday,
        generatedAt: new Date(),
        items: [],
        signals: {
          weather: { temp: 20, condition: 'clear', humidity: 60 },
          loadSheddingStage: 0,
          isPublicHoliday: false,
          isSchoolHoliday: false,
          isPayday: false,
          dayOfWeek: 0,
          events: [],
        },
        totalPredictedRevenue: 123,
      });

      await Forecast.create({
        cafeId,
        date: tomorrow,
        generatedAt: new Date(),
        items: [],
        signals: {
          weather: { temp: 20, condition: 'clear', humidity: 60 },
          loadSheddingStage: 0,
          isPublicHoliday: false,
          isSchoolHoliday: false,
          isPayday: false,
          dayOfWeek: 0,
          events: [],
        },
        totalPredictedRevenue: 999999,
      });

      const stale = await Forecast.find({ cafeId }).lean();
      expect(stale.length).toBe(2);

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${u.token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${u.token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const after = await Forecast.find({ cafeId }).lean();
      expect(after.some((forecast) => forecast.date.getTime() === yesterday.getTime())).toBe(true);
      expect(after.some((forecast) => forecast.totalPredictedRevenue === 999999)).toBe(false);
      expect(after.length).toBeGreaterThanOrEqual(7);
    });
  });
});
