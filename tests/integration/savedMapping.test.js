const mockR2Files = new Map();
const mockPropose = jest.fn(async () => ({ mapping: {}, itemsMode: 'packed' }));
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: (...args) => mockPropose(...args),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');

const request = supertest(app);
const LF = String.fromCharCode(10);
const HEADERS = ['Txn', 'Sale Date', 'Sale Time', 'Description', 'Subtotal', 'Total', 'Status'];
const ROWS = [
  'A1,2026-09-14,09:00,1 x Latte,33.04,38.00,Completed',
  'A2,2026-09-14,09:30,1 x Muffin,26.09,30.00,Refunded',
];
const WRONG = { receiptId: 'Txn', date: 'Sale Date', time: 'Sale Time', items: 'Description', total: 'Subtotal' };
const FIXED = { ...WRONG, total: 'Total', status: 'Status' };

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockPropose.mockReset();
  mockPropose.mockImplementation(async () => ({ mapping: {}, itemsMode: 'packed' }));
  mockR2Files.clear();
  await clearDB();
});

const csv = (headers, rows = ROWS) => [headers.join(','), ...rows].join(LF);
const stage = (token, text, name) => request
  .post('/api/transactions/upload')
  .set('Authorization', `Bearer ${token}`)
  .attach('file', Buffer.from(text), name);
const confirm = (token, uploadId, columnMapping) => request
  .post(`/api/uploads/${uploadId}/confirm`)
  .set('Authorization', `Bearer ${token}`)
  .send({ columnMapping, itemsMode: 'packed' });
const savedFor = async (cafeId) => (await Cafe.findById(cafeId).lean()).savedColumnMapping;

describe('the saved column mapping', () => {
  it('becomes the corrected mapping when a wizard upload is remapped', async () => {
    const { token, user } = await createTestUser();
    const first = await stage(token, csv(HEADERS), 'week-1.csv');
    expect((await confirm(token, first.body.uploadId, WRONG)).status).toBe(200);
    expect((await savedFor(user.activeCafeId)).total).toBe('Subtotal');

    const remap = await request
      .patch(`/api/uploads/${first.body.uploadId}/mapping`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: FIXED, itemsMode: 'packed' });
    expect(remap.status).toBe(200);
    expect(await savedFor(user.activeCafeId)).toMatchObject({
      total: 'Total', status: 'Status', sourceFileName: 'week-1.csv', sourceHeaders: HEADERS,
    });

    const next = await stage(token, csv(HEADERS), 'week-2.csv');
    expect(next.body).toMatchObject({
      needsConfirmation: false,
      mappingSource: 'saved',
      columnMapping: FIXED,
      savedMapping: { status: 'applied', missingColumns: [] },
    });
  });

  it('opens the wizard, prefilled, when the file lacks a column the saved mapping names', async () => {
    const { token } = await createTestUser();
    const first = await stage(token, csv(HEADERS), 'week-1.csv');
    await confirm(token, first.body.uploadId, FIXED);

    mockPropose.mockClear(); // the first stage, with no saved mapping yet, asked the AI once
    const withoutStatus = csv(HEADERS.slice(0, 6), ROWS.map((row) => row.split(',').slice(0, 6).join(',')));
    const next = await stage(token, withoutStatus, 'no-status.csv');

    expect(next.body.needsConfirmation).toBe(true);
    expect(next.body.savedMapping).toEqual({ status: 'did_not_fit', reason: 'missing_columns', missingColumns: ['Status'] });
    // Prefilled with the saved mapping minus the column this file lacks.
    expect(next.body.columnMapping).toEqual({
      receiptId: 'Txn', date: 'Sale Date', time: 'Sale Time', items: 'Description', total: 'Total',
    });
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it('opens the wizard when the header row changed, even though every saved column is present', async () => {
    const { token } = await createTestUser();
    const first = await stage(token, csv(HEADERS), 'week-1.csv');
    await confirm(token, first.body.uploadId, FIXED);

    const withLoyalty = csv([...HEADERS, 'Loyalty'], ROWS.map((row) => `${row},Yes`));
    const next = await stage(token, withLoyalty, 'new-column.csv');

    expect(next.body.needsConfirmation).toBe(true);
    expect(next.body.savedMapping).toEqual({ status: 'did_not_fit', reason: 'headers_changed', missingColumns: [] });
    expect(next.body.columnMapping).toEqual(FIXED);
  });

  it('asks the AI mapper when the saved mapping cannot cover the new file', async () => {
    const { token } = await createTestUser();
    const first = await stage(token, csv(HEADERS), 'week-1.csv');
    await confirm(token, first.body.uploadId, FIXED);
    mockPropose.mockClear();
    mockPropose.mockImplementation(async () => ({
      mapping: { date: 'Date', items: 'Item', total: 'Amount' }, itemsMode: 'packed', aiCreditsCharged: 0,
    }));

    const other = [ 'Date,Item,Amount', '2026-09-15,1 x Latte,38.00' ].join(LF);
    const next = await stage(token, other, 'other-till.csv');

    expect(mockPropose).toHaveBeenCalledTimes(1);
    expect(next.body).toMatchObject({
      needsConfirmation: true,
      mappingSource: 'ai',
      columnMapping: { date: 'Date', items: 'Item', total: 'Amount' },
      savedMapping: { status: 'did_not_fit', reason: 'missing_columns' },
    });
  });

  it('shows the saved mapping and lets the owner, not a manager, clear it', async () => {
    const { token, user } = await createTestUser();
    const first = await stage(token, csv(HEADERS), 'week-1.csv');
    await confirm(token, first.body.uploadId, FIXED);

    const shown = await request.get('/api/cafe/me/column-mapping').set('Authorization', `Bearer ${token}`);
    expect(shown.status).toBe(200);
    expect(shown.body.savedColumnMapping).toMatchObject({
      mapping: FIXED, itemsMode: 'packed', sourceHeaders: HEADERS, sourceFileName: 'week-1.csv',
    });

    const manager = await createTestManager(token, [user.activeCafeId]);
    const refused = await request.delete('/api/cafe/me/column-mapping').set('Authorization', `Bearer ${manager.token}`);
    expect(refused.status).toBe(403);

    const cleared = await request.delete('/api/cafe/me/column-mapping').set('Authorization', `Bearer ${token}`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.savedColumnMapping).toBeNull();
    const after = await request.get('/api/cafe/me/column-mapping').set('Authorization', `Bearer ${token}`);
    expect(after.body.savedColumnMapping).toBeNull();

    mockPropose.mockClear();
    const next = await stage(token, csv(HEADERS), 'week-2.csv');
    expect(next.body.needsConfirmation).toBe(true);
    expect(next.body.savedMapping).toEqual({ status: 'none', missingColumns: [] });
    expect(mockPropose).toHaveBeenCalledTimes(1);
  });

  it('keeps the saved mapping when a Yoco upload is remapped', async () => {
    const { token, user } = await createTestUser();
    const first = await stage(token, csv(HEADERS), 'week-1.csv');
    await confirm(token, first.body.uploadId, FIXED);
    const yoco = [
      'Receipt,Date,Time,Status,Payment Method,Items,Total (incl. tax)',
      '2026/09/000001,2026/09/15,09:00:00,Approved,Card,1 x Latte,38.00',
    ].join(LF);
    const staged = await stage(token, yoco, 'yoco.csv');
    await confirm(token, staged.body.uploadId, staged.body.columnMapping);

    const remap = await request
      .patch(`/api/uploads/${staged.body.uploadId}/mapping`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: { ...staged.body.columnMapping, paymentMethod: undefined }, itemsMode: staged.body.itemsMode });
    expect(remap.status).toBe(200);
    expect(await savedFor(user.activeCafeId)).toMatchObject({ total: 'Total', sourceFileName: 'week-1.csv' });
  });

  it('leaves the saved mapping alone when a manager tries to remap (remap is owner-only, security-4)', async () => {
    const { token, user } = await createTestUser();
    const first = await stage(token, csv(HEADERS), 'week-1.csv');
    await confirm(token, first.body.uploadId, WRONG);
    const manager = await createTestManager(token, [user.activeCafeId]);

    const remap = await request
      .patch(`/api/uploads/${first.body.uploadId}/mapping`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ columnMapping: FIXED, itemsMode: 'packed' });
    expect(remap.status).toBe(403);
    expect(await savedFor(user.activeCafeId)).toMatchObject({ total: 'Subtotal', sourceFileName: 'week-1.csv' });
  });

  it('applies a saved mapping to a file with duplicate header names, as the reader names them', async () => {
    const { token } = await createTestUser();
    const dupHeaders = ['Txn', 'Sale Date', 'Description', 'Total', 'Total'];
    const dupRows = ['A1,2026-09-14,1 x Latte,33.04,38.00'];
    const first = await stage(token, csv(dupHeaders, dupRows), 'dup-1.csv');
    const named = first.body.headers;
    expect(named).toEqual(['Txn', 'Sale Date', 'Description', 'Total', 'Total (2)']);
    await confirm(token, first.body.uploadId, { receiptId: 'Txn', date: 'Sale Date', items: 'Description', total: 'Total (2)' });

    const next = await stage(token, csv(dupHeaders, dupRows), 'dup-2.csv');
    expect(next.body).toMatchObject({
      needsConfirmation: false,
      savedMapping: { status: 'applied', missingColumns: [] },
      columnMapping: { total: 'Total (2)' },
    });
  });

  it("cannot clear another organisation's cafe mapping: the cafe comes from the caller's own session", async () => {
    const a = await createTestUser({ email: 'owner-a@yourguava.com' });
    const b = await createTestUser({ email: 'owner-b@yourguava.com' });
    const first = await stage(b.token, csv(HEADERS), 'week-1.csv');
    await confirm(b.token, first.body.uploadId, FIXED);

    const cleared = await request.delete('/api/cafe/me/column-mapping').set('Authorization', `Bearer ${a.token}`);
    expect(cleared.status).toBe(200); // A clears A's own (empty) mapping
    expect(await savedFor(b.user.activeCafeId)).toMatchObject({ total: 'Total', sourceFileName: 'week-1.csv' });
  });

  it('never saves a Yoco preset import as the cafe mapping', async () => {
    const { token, user } = await createTestUser();
    const yoco = [
      'Receipt,Date,Time,Status,Payment Method,Items,Total (incl. tax)',
      '2026/09/000001,2026/09/14,09:00:00,Approved,Card,1 x Latte,38.00',
    ].join(LF);
    const staged = await stage(token, yoco, 'yoco.csv');
    expect(staged.body.posType).toBe('yoco');
    await confirm(token, staged.body.uploadId, staged.body.columnMapping);
    expect(await savedFor(user.activeCafeId)).toBeUndefined();
  });
});
