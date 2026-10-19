const path = require('path');
const fs = require('fs');
const os = require('os');
const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const Transaction = require('../../src/models/Transaction.model');
const Item = require('../../src/models/Item.model');
const {
  ingestParsedRows,
  ingestFile,
  persistParsedRows,
} = require('../../src/services/ingestion.service');
const { parseBuffer } = require('../../src/services/parser.service');

describe('ingestion service', () => {
  describe('ingestFile', () => {
    it('parses a valid CSV file and imports approved transactions', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
      const result = await ingestFile(csvPath, cafeId);

      // 5 rows: 4 approved, 1 declined
      expect(result.imported).toBe(4);
      expect(result.skipped).toBe(1); // declined row
      expect(result.errors).toBe(0);

      // Verify transactions in database
      const transactions = await Transaction.find({ cafeId });
      expect(transactions.length).toBe(4);
    });

    it('skips duplicate receipts on re-import', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

      // First import
      const first = await ingestFile(csvPath, cafeId);
      expect(first.imported).toBe(4);

      // Second import — all should be skipped
      const second = await ingestFile(csvPath, cafeId);
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(5); // 4 already exist + 1 declined

      // Total in DB should still be 4
      const count = await Transaction.countDocuments({ cafeId });
      expect(count).toBe(4);
    });

    it('keeps receipt-less ingestFile replay idempotent across byte-different exports of the same sale', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b90-receiptless-'));
      const file = path.join(dir, 'sales.csv');
      const headers = 'Receipt,Date,Time,Status,Items,Note,Total (incl. tax)';
      const original = Buffer.from(`${headers}\n,2026/01/15,09:30:00,Approved,1 x Latte,first export,38.00\n`);
      const changed = Buffer.from(`${headers}\n,2026/01/15,09:30:00,Approved,1 x Latte,second export,38.00\n`);
      try {
        fs.writeFileSync(file, original);
        const first = await ingestFile(file, cafeId, { timezone: 'Africa/Johannesburg' });
        expect(first).toMatchObject({ imported: 1, errors: 0 });
        const held = await Transaction.findOne({ cafeId }).lean();
        expect(held.receiptId).toBeUndefined();
        expect(held.dedupKey).toMatch(/^[a-f0-9]{64}$/);

        const second = await ingestFile(file, cafeId, { timezone: 'Africa/Johannesburg' });
        expect(second).toMatchObject({ imported: 0, skipped: 1, errors: 0, skippedByReason: { duplicate: 1 } });

        expect(changed.equals(original)).toBe(false);
        fs.writeFileSync(file, changed);
        const third = await ingestFile(file, cafeId, { timezone: 'Africa/Johannesburg' });
        // BE-03-T03 superseded file-scoped identity: changing a file's fingerprint
        // must not count the same receipt-less sale twice through the seed path.
        expect(third).toMatchObject({ imported: 0, skipped: 1, errors: 0, skippedByReason: { duplicate: 1 } });
        expect(await Transaction.find({ cafeId }).lean()).toEqual([held]);
      } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(dir);
      }
    });

    // BE-03-T09: the row-at-a-time path keeps skipped equal to the sum of its reasons, as the upload path does.
    it('gives every row skipped on re-import a reason', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
      await ingestFile(csvPath, cafeId);

      const second = await ingestFile(csvPath, cafeId);

      expect(second.skippedByReason).toEqual({ duplicate: 4, status_not_approved: 1 });
      expect(second.skipped).toBe(5);
    });

    it('names a sale repeated inside one file apart from one imported earlier', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const columnMapping = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
      const file = (lines) => Buffer.from(['Receipt,Date,Time,Items,Total', ...lines].join(String.fromCharCode(10)));
      await ingestParsedRows(file(['E1,2026-09-01,09:00,1 x Latte,38.00']), { cafeId, columnMapping, itemsMode: 'packed' });

      const result = await ingestParsedRows(file([
        'E1,2026-09-01,09:00,1 x Latte,38.00', 'E2,2026-09-01,09:05,1 x Tea,25.00', 'E2,2026-09-01,09:05,1 x Tea,25.00',
      ]), { cafeId, columnMapping, itemsMode: 'packed' });

      expect(result).toMatchObject({ imported: 1, skipped: 2, skippedByReason: { duplicate: 1, in_file_duplicate: 1 } });
    });

    it('creates Item records for unique item names', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

      await ingestFile(csvPath, cafeId);

      const items = await Item.find({ cafeId });
      const itemNames = items.map((i) => i.name).sort();

      // Expected items from approved rows:
      // "Flat White (Blend)", "Long White (Blend)", "Iced Coffee (None)", "Brownie", "Espresso (Blend)"
      expect(itemNames).toContain('Flat White (Blend)');
      expect(itemNames).toContain('Brownie');
      expect(itemNames).toContain('Espresso (Blend)');
      expect(itemNames).toContain('Iced Coffee (None)');
      expect(items.length).toBeGreaterThanOrEqual(5);

      const byName = new Map(items.map((item) => [item.name, item]));
      expect(byName.get('Flat White (Blend)').category).toBe('coffee');
      expect(byName.get('Iced Coffee (None)').category).toBe('cold_drink');
      expect(byName.get('Brownie').category).toBe('food');
    });

    it('reuses an existing exact-name Item even if legacy normalised metadata is missing', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const existing = await Item.create({
        cafeId,
        name: 'Black Coffee (Small)',
        category: 'coffee',
        expectedPrice: 36,
        reviewStatus: 'matched',
      });
      const csv = Buffer.from([
        'Receipt,Date,Time,Items,Total',
        'R1,2026-04-01,08:30,1 x Black Coffee (Small),36',
      ].join('\n'));

      const result = await ingestParsedRows(csv, {
        cafeId,
        uploadId: null,
        columnMapping: {
          receiptId: 'Receipt',
          date: 'Date',
          time: 'Time',
          items: 'Items',
          total: 'Total',
        },
        itemsMode: 'packed',
        fileExt: 'csv',
      });

      expect(result.imported).toBe(1);
      expect(await Item.countDocuments({ cafeId, name: 'Black Coffee (Small)' })).toBe(1);
      const tx = await Transaction.findOne({ cafeId, receiptId: 'R1' }).lean();
      expect(String(tx.items[0].salesItemId)).toBe(String(existing._id));
    });

    it('correctly parses items with quantities from CSV', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

      await ingestFile(csvPath, cafeId);

      // Row 2: "2 x Long White (Blend)" in Items column
      const tx = await Transaction.findOne({ cafeId, receiptId: '2026/01/000002' });
      expect(tx).not.toBeNull();
      expect(tx.items.length).toBeGreaterThanOrEqual(1);
      // Verify the quantity was parsed correctly
      const longWhite = tx.items.find((i) => i.name === 'Long White (Blend)');
      expect(longWhite).toEqual(expect.objectContaining({ quantity: 2 }));
      const brownie = tx.items.find((i) => i.name === 'Brownie');
      expect(brownie.quantity).toBe(1);
      expect(tx.total).toBe(143);
    });
  });

  describe('unit price provenance', () => {
    const mapping = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
    const ingest = (cafeId, lines) => ingestParsedRows(
      Buffer.from(['Receipt,Date,Time,Items,Total', ...lines].join('\n')),
      { cafeId, uploadId: null, columnMapping: mapping, itemsMode: 'packed', fileExt: 'csv' }
    );
    const menuItem = (cafeId, name, expectedPrice) => Item.create({
      cafeId, name, expectedPrice, priceTolerancePct: 10, reviewStatus: 'matched',
    });

    // A packed multi-item receipt only carries the basket total, so each line
    // gets a basket average: 2 x Flat White (38) + 1 x Coca Cola (24) = 100
    // averages to 33.33 per unit. That is not a price change on either item.
    it('does not raise a price mismatch from a multi-item receipt', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      await menuItem(cafeId, 'Flat White', 38);
      await menuItem(cafeId, 'Coca Cola 330ml', 24);

      const result = await ingest(cafeId, ['R1,2026-04-01,08:30,"2 x Flat White,1 x Coca Cola 330ml",100.00']);

      expect(result.imported).toBe(1);
      const tx = await Transaction.findOne({ cafeId, receiptId: 'R1' }).lean();
      expect(tx.items.map((item) => item.priceSource)).toEqual(['derived', 'derived']);
      expect(tx.items.map((item) => item.menuItemStatus)).toEqual(['matched', 'matched']);
      expect(tx.items.every((item) => item.priceVariancePct === undefined)).toBe(true);
      const flatWhite = await Item.findOne({ cafeId, name: 'Flat White' }).lean();
      expect(flatWhite.priceMismatchCount).toBe(0);
      expect(flatWhite.expectedPrice).toBe(38);
    });

    it('raises a price mismatch from a single-item receipt whose price moved', async () => {
      const cafeId = new mongoose.Types.ObjectId();
      await menuItem(cafeId, 'Flat White', 38);

      await ingest(cafeId, ['R2,2026-04-01,08:30,1 x Flat White,50.00']);

      const tx = await Transaction.findOne({ cafeId, receiptId: 'R2' }).lean();
      expect(tx.items[0]).toMatchObject({
        priceSource: 'exact',
        unitPrice: 50,
        menuItemStatus: 'price_mismatch',
      });
      expect(tx.items[0].priceVariancePct).toBeCloseTo(31.58, 2);
      const flatWhite = await Item.findOne({ cafeId, name: 'Flat White' }).lean();
      expect(flatWhite.priceMismatchCount).toBe(1);
    });

    it('learns the expected price from exact lines only', async () => {
      const cafeId = new mongoose.Types.ObjectId();

      await ingest(cafeId, [
        'R3,2026-04-01,08:30,"2 x Flat White,1 x Coca Cola 330ml",100.00',
        'R4,2026-04-01,09:00,1 x Flat White,38.00',
      ]);

      const flatWhite = await Item.findOne({ cafeId, name: 'Flat White' }).lean();
      expect(flatWhite.expectedPrice).toBe(38);
      expect(flatWhite.lastObservedPrice).toBe(38);
      const cocaCola = await Item.findOne({ cafeId, name: 'Coca Cola 330ml' }).lean();
      expect(cocaCola.expectedPrice).toBeUndefined();
      expect(cocaCola.lastObservedPrice ?? null).toBeNull();
    });

    it('takes the latest exact price by date rather than by insertion order', async () => {
      const cafeId = new mongoose.Types.ObjectId();

      await ingest(cafeId, [
        'R-later,2026-04-02,08:30,1 x Flat White,40.00',
        'R-earlier,2026-04-01,08:30,1 x Flat White,38.00',
      ]);

      const flatWhite = await Item.findOne({ cafeId, name: 'Flat White' }).lean();
      expect(flatWhite.lastObservedPrice).toBe(40);
      expect(flatWhite.expectedPrice).toBe(40);
    });

    it('breaks a same-instant tie by insertion order so rebuilds are repeatable', async () => {
      // Date-only exports put every sale of a day at midnight, so a date sort
      // alone leaves "last" to chance and a rebuild could flip the price.
      const cafeId = new mongoose.Types.ObjectId();

      await ingest(cafeId, [
        'R-first,2026-04-01,08:30,1 x Flat White,38.00',
        'R-second,2026-04-01,08:30,1 x Flat White,40.00',
      ]);

      const flatWhite = await Item.findOne({ cafeId, name: 'Flat White' }).lean();
      expect(flatWhite.lastObservedPrice).toBe(40);
    });
  });
});

describe('receipt identity is scoped to the trading day on both persistence paths', () => {
  const mapping = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
  // A till that restarts its order numbers each morning writes "#0001" every
  // day. The bulk path scopes a receipt to its trading day; the row-by-row path
  // filtered on the receipt alone, so day two's "#0001" was recognised as day
  // one's and silently counted a duplicate. A month of history collapsed to the
  // first day's receipts, and seed.js takes exactly that path.
  const twoDays = Buffer.from([
    'Receipt,Date,Time,Items,Total',
    '#0001,2026-04-01,08:30,1 x Flat White,38.00',
    '#0001,2026-04-02,08:30,1 x Flat White,38.00',
  ].join('\n'));

  const ingestBoth = async (bulk) => {
    const cafeId = new mongoose.Types.ObjectId();
    const parsed = await parseBuffer(twoDays, {
      columnMapping: mapping, itemsMode: 'packed', timezone: 'Africa/Johannesburg',
    });
    const result = await persistParsedRows(parsed, {
      cafeId, uploadId: null, bulk, timezone: 'Africa/Johannesburg',
    });
    return { cafeId, result };
  };

  it.each([[true], [false]])('imports both days with bulk=%s', async (bulk) => {
    const { cafeId, result } = await ingestBoth(bulk);

    expect(result.imported).toBe(2);
    expect(result.duplicateRows).toBe(0);
    expect(await Transaction.countDocuments({ cafeId })).toBe(2);
  });

  it('still recognises a genuine re-import of the same day as a duplicate', async () => {
    const cafeId = new mongoose.Types.ObjectId();
    const opts = { cafeId, uploadId: null, bulk: false, timezone: 'Africa/Johannesburg' };
    const parseOnce = () => parseBuffer(twoDays, {
      columnMapping: mapping, itemsMode: 'packed', timezone: 'Africa/Johannesburg',
    });

    expect((await persistParsedRows(await parseOnce(), opts)).imported).toBe(2);
    const second = await persistParsedRows(await parseOnce(), opts);

    expect(second.imported).toBe(0);
    expect(second.duplicateRows).toBe(2);
    expect(await Transaction.countDocuments({ cafeId })).toBe(2);
  });
});
