const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  parseBuffer,
  zonedDayStart,
  assertSupportedFileBuffer,
} = require('../../src/services/parser.service');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));

const buildStoredZip = (entries) => {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name || '[Content_Types].xml');
    const data = Buffer.from(entry.data || 'x');
    const flags = entry.flags || 0;
    const compressionMethod = entry.compressionMethod || 0;
    const compressedSize = entry.compressedSize ?? data.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const crcData = Buffer.from(entry.crcData ?? data);
    const crc = zlib.crc32(crcData) >>> 0;
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.versionNeeded || 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    localChunks.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(entry.versionNeeded || 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(compressionMethod, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralChunks.push(central);
    localOffset += local.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localChunks, centralDirectory, end]);
};

describe('parser.service', () => {
  describe('refund and void lines', () => {
    // A till exports a refund as a negative line. The quantity regex matched digits
    // only, so the minus was stepped over and "-1 x Flat White" was read as a SALE of
    // one. Demand then moved two units the wrong way per refund, and the stored row
    // disagreed with itself: total -38 against quantity +1.
    const { parsePackedItems } = require('../../src/services/parser.service');

    it('reads a negative packed line as a refund, not a sale', () => {
      expect(parsePackedItems('-1 x Flat White (Blend)')).toEqual([
        { name: 'Flat White (Blend)', quantity: -1 },
      ]);
    });

    it('reads a fractional refund', () => {
      expect(parsePackedItems('-0.35 x Cheese Wheel')).toEqual([
        { name: 'Cheese Wheel', quantity: -0.35 },
      ]);
    });

    it('keeps sales and refunds apart in one receipt', () => {
      expect(parsePackedItems('2 x Flat White,-1 x Muffin')).toEqual([
        { name: 'Flat White', quantity: 2 },
        { name: 'Muffin', quantity: -1 },
      ]);
    });

    it('still rejects a zero quantity', () => {
      expect(parsePackedItems('0 x Flat White')).toEqual([]);
    });

    it('does not treat a hyphen inside a name as a sign', () => {
      expect(parsePackedItems('1 x Coca-Cola')).toEqual([{ name: 'Coca-Cola', quantity: 1 }]);
    });

    it('nets a refund against a sale in the same file', async () => {
      const csv = [
        'Receipt,Date,Items,Total',
        'R1,2026/03/02,"3 x Flat White",114.00',
        'R2,2026/03/02,"-1 x Flat White",-38.00',
      ].join('\n');
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: { receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      });
      const net = result.rows.flatMap((r) => r.items).reduce((sum, i) => sum + i.quantity, 0);
      expect(net).toBe(2);
    });

    it('prices a refund receipt as derived, never as a menu-price observation', async () => {
      const csv = 'Receipt,Date,Items,Total\nR1,2026/03/02,"-1 x Flat White",-38.00';
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: { receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      });
      expect(result.rows[0].items[0]).toMatchObject({ quantity: -1, priceSource: 'derived' });
      // The unit price stays the positive menu price; only the quantity carries the sign.
      expect(result.rows[0].items[0].unitPrice).toBe(38);
    });

    it('keeps a voided receipt as two lines that net to zero', async () => {
      // Before the fix the separator lookahead did not allow a sign, so the whole
      // string collapsed into ONE item literally named "Flat White,-1 x Flat White".
      const csv = 'Receipt,Date,Items,Total\nR1,2026/03/02,"1 x Flat White,-1 x Flat White",0.00';
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: { receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      });
      expect(result.rows[0].items).toEqual([
        { name: 'Flat White', quantity: 1, unitPrice: 0, priceSource: 'derived' },
        { name: 'Flat White', quantity: -1, unitPrice: 0, priceSource: 'derived' },
      ]);
    });
  });

  describe('packed itemsMode', () => {
    const mapping = {
      receiptId: 'Txn Number',
      date: 'Sale Date',
      time: 'Sale Time',
      items: 'Description',
      total: 'Amount',
    };

    it('parses generic POS CSV into normalised transaction rows', async () => {
      const buf = fixture('test-generic-pos.csv');
      const result = await parseBuffer(buf, { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]).toMatchObject({
        receiptId: 'A001',
        total: 75,
        items: [
          { name: 'Flat White', quantity: 2 },
          { name: 'Muffin', quantity: 1 },
        ],
      });
      expect(result.rows[0].date).toBeInstanceOf(Date);
    });

    it('returns dateRange spanning earliest to latest row', async () => {
      const buf = fixture('test-generic-pos.csv');
      const result = await parseBuffer(buf, { columnMapping: mapping, itemsMode: 'packed' });
      expect(result.dateRange.firstDate.toISOString().slice(0, 10)).toBe('2026-04-01');
      expect(result.dateRange.lastDate.toISOString().slice(0, 10)).toBe('2026-04-01');
    });

    it('parses South African day-first date strings explicitly', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA006,31/01/2026,10:15,Flat White,35.00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].date.getFullYear()).toBe(2026);
      expect(result.rows[0].date.getMonth()).toBe(0);
      expect(result.rows[0].date.getDate()).toBe(31);
      expect(result.rows[0].hour).toBe(10);
    });

    it('interprets wall-clock timestamps in the cafe timezone', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA009,2026-04-01,23:30,Flat White,35.00';
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'packed',
        timezone: 'Africa/Johannesburg',
      });

      expect(result.rows[0].date.toISOString()).toBe('2026-04-01T21:30:00.000Z');
      expect(result.rows[0].hour).toBe(23);
      expect(result.rows[0].dayOfWeek).toBe(3);
    });

    it('normalises BOM/whitespace headers and comma-decimal currency values', async () => {
      const csv = '\uFEFF Sale Date , Sale Time , Description , Amount \n2026-04-01,09:30,Flat White,"R 1 234,56"';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: {
        date: 'Sale Date',
        time: 'Sale Time',
        items: 'Description',
        total: 'Amount',
      }, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].total).toBe(1234.56);
      expect(result.rows[0].items[0].unitPrice).toBe(1234.56);
      expect(result.rows[0].hour).toBe(9);
    });

    it('detects semicolon-delimited CSV exports', async () => {
      const csv = 'Txn Number;Sale Date;Sale Time;Description;Amount\nA008;2026-04-01;09:30;Flat White;R 35,00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].receiptId).toBe('A008');
      expect(result.rows[0].total).toBe(35);
    });

    it('treats plain item descriptions as quantity-one items', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA004,2026/04/01,10:00,Flat White,35.00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].items).toEqual([
        { name: 'Flat White', quantity: 1, unitPrice: 35, priceSource: 'exact' },
      ]);
    });

    it('repairs unquoted comma-separated item cells before parsing later columns', async () => {
      const yocoMapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Items',
        total: 'Total (incl. tax)',
        tip: 'Tip',
        discount: 'Discount',
        paymentMethod: 'Payment Method',
        status: 'Status',
      };
      const buf = fixture('test-transactions.csv');
      const result = await parseBuffer(buf, { columnMapping: yocoMapping, itemsMode: 'packed' });

      const receipt = result.rows.find((row) => row.receiptId === '2026/01/000005');
      expect(receipt.total).toBe(159);
      // A packed receipt carries one total for the whole basket, so a
      // multi-item receipt can only yield a basket average per line. That
      // keeps per-item revenue summing to the receipt, but it is not a price:
      // it is flagged as derived so nothing downstream learns it as one.
      expect(receipt.items).toEqual([
        { name: 'Brownie', quantity: 3, unitPrice: 39.75, priceSource: 'derived' },
        { name: 'Espresso (Blend)', quantity: 1, unitPrice: 39.75, priceSource: 'derived' },
      ]);
    });

    it('marks a single-item packed receipt as an exact unit price', async () => {
      const yocoMapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Items',
        total: 'Total (incl. tax)',
      };
      const buf = fixture('test-transactions.csv');
      const result = await parseBuffer(buf, { columnMapping: yocoMapping, itemsMode: 'packed' });

      const receipt = result.rows.find((row) => row.receiptId === '2026/01/000001');
      // The Tip column is not mapped here, so the parser cannot know this row's
      // R48 includes a R5 tip and treats it as exact. With the tip mapped it is
      // derived -- see the tipped-receipt cases below.
      expect(receipt.items).toEqual([
        { name: 'Flat White (Blend)', quantity: 1, unitPrice: 48, priceSource: 'exact' },
      ]);
    });

    describe('tipped or discounted receipts are not exact price observations', () => {
      const header = 'Receipt,Date,Time,Items,Total,Tip,Discount';
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Items',
        total: 'Total',
        tip: 'Tip',
        discount: 'Discount',
      };
      const parse = (line) =>
        parseBuffer(Buffer.from(`${header}\n${line}\n`), { columnMapping: mapping, itemsMode: 'packed' });

      it('keeps a clean single-item receipt exact', async () => {
        const { rows } = await parse('R1,2026/03/02,09:00:00,1 x Flat White,38.0,0.0,0.0');
        expect(rows[0].items[0]).toMatchObject({ unitPrice: 38, priceSource: 'exact' });
      });

      it('marks a tipped single-item receipt derived', async () => {
        const { rows } = await parse('R2,2026/03/02,09:05:00,1 x Flat White,43.0,5.0,0.0');
        expect(rows[0].items[0]).toMatchObject({ unitPrice: 43, priceSource: 'derived' });
      });

      it('marks a discounted single-item receipt derived', async () => {
        const { rows } = await parse('R3,2026/03/02,09:10:00,2 x Flat White,66.0,0.0,10.0');
        expect(rows[0].items[0]).toMatchObject({ unitPrice: 33, priceSource: 'derived' });
      });
    });

    it('treats empty item descriptions as parse errors', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA005,2026/04/01,10:00,,35.00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Missing or invalid items',
          raw: expect.objectContaining({ Description: '' }),
        }),
      ]);
    });

    it('treats impossible times as parse errors', async () => {
      const csv = 'Txn Number,Sale Date,Sale Time,Description,Amount\nA007,2026/04/01,25:99,Flat White,35.00';
      const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Could not parse date or time',
          raw: expect.objectContaining({ 'Sale Time': '25:99' }),
        }),
      ]);
    });
  });

  describe('line-per-row itemsMode', () => {
    it('groups line items by receiptId into single transactions', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Total',
      };
      const buf = fixture('test-line-per-row.csv');
      const result = await parseBuffer(buf, {
        columnMapping: { ...mapping, quantity: 'Qty' },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(2);
      const r100 = result.rows.find((r) => r.receiptId === 'R100');
      // Both rows repeat the receipt total, so the per-line price can only be
      // a basket average and is flagged as derived.
      expect(r100.items).toEqual([
        { name: 'Flat White', quantity: 2, unitPrice: 25, priceSource: 'derived' },
        { name: 'Muffin', quantity: 1, unitPrice: 25, priceSource: 'derived' },
      ]);
      expect(r100.total).toBe(75);
    });

    it('requires a receipt ID mapping for line-per-row imports', async () => {
      const buf = fixture('test-line-per-row.csv');

      await expect(
        parseBuffer(buf, {
          columnMapping: {
            date: 'Date',
            time: 'Time',
            items: 'Item',
            total: 'Total',
            quantity: 'Qty',
          },
          itemsMode: 'line-per-row',
        })
      ).rejects.toThrow(/receiptId/i);
    });

    it('treats blank receipt IDs as row errors in line-per-row mode', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Line Total',
        quantity: 'Qty',
      };
      const csv = 'Receipt,Date,Time,Item,Qty,Line Total\n,2026-04-01,08:30,Flat White,1,35.00';

      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Missing receipt ID',
          raw: expect.objectContaining({ Receipt: '' }),
        }),
      ]);
    });

    it('sums line totals when rows provide item-level amounts', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Line Total',
        quantity: 'Qty',
      };
      const csv = [
        'Receipt,Date,Time,Item,Qty,Line Total',
        'R200,2026-04-01,08:30,Flat White,2,50.00',
        'R200,2026-04-01,08:30,Muffin,1,25.00',
      ].join('\n');

      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].total).toBe(75);
      expect(result.rows[0].items).toEqual([
        { name: 'Flat White', quantity: 2, unitPrice: 25, priceSource: 'exact' },
        { name: 'Muffin', quantity: 1, unitPrice: 25, priceSource: 'exact' },
      ]);
    });

    it('preserves item-level unit prices from line total columns', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Line Total',
        quantity: 'Qty',
      };
      const csv = [
        'Receipt,Date,Time,Item,Qty,Line Total',
        'R201,2026-04-01,08:30,Flat White,2,70.00',
        'R201,2026-04-01,08:30,Muffin,1,25.00',
      ].join('\n');

      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].total).toBe(95);
      expect(result.rows[0].items).toEqual([
        { name: 'Flat White', quantity: 2, unitPrice: 35, priceSource: 'exact' },
        { name: 'Muffin', quantity: 1, unitPrice: 25, priceSource: 'exact' },
      ]);
    });

    it('rejects non-positive line quantities', async () => {
      const mapping = {
        receiptId: 'Receipt',
        date: 'Date',
        time: 'Time',
        items: 'Item',
        total: 'Line Total',
        quantity: 'Qty',
      };
      const csv = 'Receipt,Date,Time,Item,Qty,Line Total\nR202,2026-04-01,08:30,Flat White,0,70.00';

      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: mapping,
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Invalid item quantity',
          raw: expect.objectContaining({ Qty: '0' }),
        }),
      ]);
    });
  });

  describe('error cases', () => {
    it('throws when required fields are unmapped', async () => {
      const buf = fixture('test-generic-pos.csv');
      await expect(
        parseBuffer(buf, { columnMapping: { date: 'Sale Date' }, itemsMode: 'packed' })
      ).rejects.toThrow(/required.*items|required.*total/i);
    });

    it('returns errors for unparseable date rows', async () => {
      const csv = 'Date,Items,Total\nnot-a-date,1 x Foo,10';
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      });
      expect(result.errors).toBeGreaterThanOrEqual(1);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          reason: 'Could not parse date or time',
        }),
      ]);
      expect(result.rows).toHaveLength(0);
    });

    it.each([
      {
        label: 'oversized quantities',
        csv: 'Date,Items,Total\n2026-04-01,10001 x Foo,10',
        reason: /quantity exceeds/i,
      },
      {
        label: 'oversized monetary values',
        csv: 'Date,Items,Total\n2026-04-01,1 x Foo,10000001',
        reason: /amount exceeds/i,
      },
      {
        label: 'missing monetary values',
        csv: 'Date,Items,Total\n2026-04-01,1 x Foo,',
        reason: /invalid transaction total/i,
      },
      {
        label: 'scientific-notation monetary values',
        csv: 'Date,Items,Total\n2026-04-01,1 x Foo,1e999',
        reason: /invalid transaction total/i,
      },
      {
        label: 'oversized canonical item names',
        csv: `Date,Items,Total\n2026-04-01,1 x ${'x'.repeat(201)},10`,
        reason: /item name exceeds/i,
      },
    ])('rejects $label before they can poison analytics', async ({ csv, reason }) => {
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(1);
      expect(result.rowErrors[0].reason).toMatch(reason);
    });

    it('rejects a grouped receipt whose line totals exceed the transaction amount bound', async () => {
      const csv = [
        'Receipt,Date,Item,Qty,Line Total',
        'R-LARGE,2026-04-01,Foo,1,6000000',
        'R-LARGE,2026-04-01,Bar,1,6000000',
      ].join('\n');
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: {
          receiptId: 'Receipt',
          date: 'Date',
          items: 'Item',
          quantity: 'Qty',
          total: 'Line Total',
        },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.rowErrors).toEqual([
        expect.objectContaining({ reason: expect.stringMatching(/transaction total exceeds/i) }),
      ]);
    });

    it('still rejects a receipt whose rows disagree on the total when the file repeats receipt totals', async () => {
      // Ten receipts repeat their total on every row, so the file reads in
      // receipt-total mode; the one receipt whose rows disagree cannot be a
      // pair of line amounts and is refused rather than guessed at.
      const lines = ['Receipt,Date,Time,Item,Qty,Total'];
      for (let index = 0; index < 10; index += 1) {
        lines.push(`R-ok-${index},2026-04-01,08:30,Flat White,1,60.00`);
        lines.push(`R-ok-${index},2026-04-01,08:30,Muffin,1,60.00`);
      }
      lines.push('R-conflict,2026-04-01,08:30,Flat White,1,35.00');
      lines.push('R-conflict,2026-04-01,08:30,Muffin,1,25.00');
      const result = await parseBuffer(Buffer.from(lines.join('\n')), {
        columnMapping: {
          receiptId: 'Receipt',
          date: 'Date',
          time: 'Time',
          items: 'Item',
          quantity: 'Qty',
          total: 'Total',
        },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(10);
      expect(result.rows.every((row) => row.total === 60)).toBe(true);
      expect(result.rowErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringMatching(/conflicting receipt totals/i) }),
      ]));
    });

    // This case used two different DATES and expected rejection, on the model
    // that a receipt ID identifies one sale globally. That holds for exports
    // with globally unique references (Yoco numbers receipts year/month/
    // sequence), but line-per-row exists for arbitrary tills and plenty restart
    // their order numbers each morning -- rejecting those blocked the cafe from
    // importing at all. A reused number on a different day is now read as a
    // different sale. The protection this test exists for is unchanged, and is
    // asserted here with a contradiction inside a single day.
    it('rejects rows that reuse a receipt ID with conflicting transaction metadata', async () => {
      const csv = [
        'Receipt,Date,Time,Item,Qty,Line Total',
        'R-reused,2026-04-01,08:30,Flat White,1,35.00',
        'R-reused,2026-04-01,14:45,Muffin,1,25.00',
      ].join('\n');
      const result = await parseBuffer(Buffer.from(csv), {
        columnMapping: {
          receiptId: 'Receipt',
          date: 'Date',
          time: 'Time',
          items: 'Item',
          quantity: 'Qty',
          total: 'Line Total',
        },
        itemsMode: 'line-per-row',
      });

      expect(result.rows).toHaveLength(0);
      expect(result.rowErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringMatching(/conflicting date/i) }),
      ]));
    });

    it('stops parsing when the configured row bound is exceeded', async () => {
      const previous = process.env.UPLOAD_MAX_ROWS;
      process.env.UPLOAD_MAX_ROWS = '1';
      const csv = 'Date,Items,Total\n2026-04-01,1 x Foo,10\n2026-04-02,1 x Bar,12';
      try {
        await expect(parseBuffer(Buffer.from(csv), {
          columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
          itemsMode: 'packed',
        })).rejects.toThrow(/row limit/i);
      } finally {
        if (previous == null) delete process.env.UPLOAD_MAX_ROWS;
        else process.env.UPLOAD_MAX_ROWS = previous;
      }
    });

    it('rejects uploads whose calendar span exceeds the configured bound', async () => {
      const previous = process.env.UPLOAD_MAX_DATE_RANGE_DAYS;
      process.env.UPLOAD_MAX_DATE_RANGE_DAYS = '1';
      const csv = 'Date,Items,Total\n2026-04-01,1 x Foo,10\n2026-04-02,1 x Bar,12';
      try {
        await expect(parseBuffer(Buffer.from(csv), {
          columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
          itemsMode: 'packed',
        })).rejects.toThrow(/date range/i);
      } finally {
        if (previous == null) delete process.env.UPLOAD_MAX_DATE_RANGE_DAYS;
        else process.env.UPLOAD_MAX_DATE_RANGE_DAYS = previous;
      }
    });

    it('rejects binary content presented as CSV', async () => {
      await expect(parseBuffer(Buffer.from([0x50, 0x4b, 0x00, 0x01]), {
        columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
      })).rejects.toThrow(/binary data/i);
    });

    it('does not normalize impossible date-only boundaries', () => {
      expect(zonedDayStart('2026-02-30', 'Africa/Johannesburg')).toBeNull();
    });
  });

  describe('XLSX archive preflight', () => {
    it('accepts a small, well-formed ZIP archive', () => {
      const archive = buildStoredZip([{ name: '[Content_Types].xml', data: '<Types />' }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).not.toThrow();
    });

    it('rejects suspicious compression ratios before decompression', () => {
      const archive = buildStoredZip([{
        name: 'xl/worksheets/sheet1.xml',
        data: 'x',
        compressedSize: 1,
        uncompressedSize: 500000,
      }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/compression-ratio/i);
    });

    it('rejects deflate streams that lie about their expanded size', () => {
      const compressed = zlib.deflateRawSync(Buffer.from('x'.repeat(5000)));
      const archive = buildStoredZip([{
        name: 'xl/worksheets/sheet1.xml',
        data: compressed,
        compressionMethod: 8,
        uncompressedSize: 1,
        crcData: Buffer.from('x'.repeat(5000)),
      }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/safely decompressed/i);
    });

    it('rejects entries whose content does not match the declared CRC', () => {
      const archive = buildStoredZip([{
        name: 'xl/workbook.xml',
        data: 'actual',
        crcData: Buffer.from('different'),
      }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/CRC checksum/i);
    });

    it('rejects encrypted archive entries', () => {
      const archive = buildStoredZip([{
        name: 'xl/workbook.xml',
        data: 'x',
        flags: 0x0001,
      }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/unsafe ZIP features/i);
    });

    it('rejects ZIP64 end records', () => {
      const archive = buildStoredZip([{ name: 'xl/workbook.xml', data: 'x' }]);
      archive.writeUInt16LE(0xffff, archive.length - 12);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/ZIP64/i);
    });

    it('enforces the configured archive entry bound', () => {
      const previous = process.env.XLSX_MAX_ENTRIES;
      process.env.XLSX_MAX_ENTRIES = '1';
      const archive = buildStoredZip([
        { name: '[Content_Types].xml', data: 'x' },
        { name: 'xl/workbook.xml', data: 'x' },
      ]);
      try {
        expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/entry limit/i);
      } finally {
        if (previous == null) delete process.env.XLSX_MAX_ENTRIES;
        else process.env.XLSX_MAX_ENTRIES = previous;
      }
    });

    it('rejects traversal entry names even in otherwise valid archives', () => {
      const archive = buildStoredZip([{ name: '../outside.xml', data: 'x' }]);

      expect(() => assertSupportedFileBuffer(archive, 'xlsx')).toThrow(/unsafe entry name/i);
    });
  });
});

describe('parsePackedItems fractional quantities', () => {
  const { parsePackedItems } = require('../../src/services/parser.service');

  // Cafes that sell by weight -- deli counters, bakeries, beans by the kilo --
  // export rows like "0.35 x Cheese Wheel". The quantity pattern used to match
  // only digits, so the engine skipped past "0." and read the decimal part as
  // the whole quantity: 0.35 became 35, a hundredfold overstatement that then
  // flowed into forecasts, revenue and the learning calibration.
  it('reads a sub-unit weight as a fraction, not as its decimal digits', () => {
    expect(parsePackedItems('0.35 x Cheese Wheel')).toEqual([
      { name: 'Cheese Wheel', quantity: 0.35 },
    ]);
  });

  it('keeps the whole part of a quantity greater than one', () => {
    expect(parsePackedItems('1.5 x Biltong')).toEqual([{ name: 'Biltong', quantity: 1.5 }]);
    expect(parsePackedItems('2.25 x Coffee Beans')).toEqual([
      { name: 'Coffee Beans', quantity: 2.25 },
    ]);
  });

  it('still parses ordinary whole quantities', () => {
    expect(parsePackedItems('1 x Flat White')).toEqual([{ name: 'Flat White', quantity: 1 }]);
    expect(parsePackedItems('2 x Brownie,1 x Muffin')).toEqual([
      { name: 'Brownie', quantity: 2 },
      { name: 'Muffin', quantity: 1 },
    ]);
  });

  it('splits a mixed row of whole and fractional lines', () => {
    expect(parsePackedItems('2 x Flat White,0.5 x Carrot Cake')).toEqual([
      { name: 'Flat White', quantity: 2 },
      { name: 'Carrot Cake', quantity: 0.5 },
    ]);
  });

  it('does not mistake a decimal point inside an item name for a quantity', () => {
    expect(parsePackedItems('1 x Still Water 1.5L')).toEqual([
      { name: 'Still Water 1.5L', quantity: 1 },
    ]);
  });

  it('ignores a zero quantity rather than importing it', () => {
    expect(parsePackedItems('0 x Refunded Item')).toEqual([]);
    expect(parsePackedItems('0.0 x Voided Item')).toEqual([]);
  });
});

describe('line-per-row receipt grouping across days', () => {
  const { groupLinePerRow } = require('../../src/services/parser.service');
  const mapping = {
    receiptId: 'Receipt', date: 'Date', time: 'Time',
    items: 'Item', total: 'Total', quantity: 'Qty',
  };
  const row = (receipt, date, item) => ({
    Receipt: receipt, Date: date, Time: '09:00:00', Item: item, Qty: '1', Total: '50.00',
  });

  it('keeps the same receipt number on different days as separate sales', () => {
    // Most tills restart order numbers each morning, so "#0001" recurs daily.
    // Keyed on the receipt alone those rows collided, the differing dates were
    // reported as conflicting, and the whole import was rejected.
    const { rows, errors } = groupLinePerRow(
      [
        row('#0001', '2026-08-22', 'Flat White'),
        row('#0001', '2026-08-23', 'Flat White'),
        row('#0001', '2026-08-24', 'Muffin'),
      ],
      mapping,
      'Africa/Johannesburg'
    );

    expect(rows).toHaveLength(3);
    expect(errors).toBe(0);
  });

  it('still groups the lines of one receipt within a single day', () => {
    const { rows } = groupLinePerRow(
      [row('#0007', '2026-08-22', 'Flat White'), row('#0007', '2026-08-22', 'Croissant')],
      mapping,
      'Africa/Johannesburg'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].items).toHaveLength(2);
  });

  it('still rejects a receipt whose rows contradict each other within one day', () => {
    // The protection that matters is preserved: genuinely contradictory rows
    // for one sale are still refused rather than merged.
    const conflicting = [
      { ...row('#0009', '2026-08-22', 'Flat White'), Time: '09:00:00' },
      { ...row('#0009', '2026-08-22', 'Croissant'), Time: '14:30:00' },
    ];
    const { errors, rowErrors } = groupLinePerRow(conflicting, mapping, 'Africa/Johannesburg');
    expect(errors).toBeGreaterThan(0);
    expect(rowErrors.some((e) => /conflicting/i.test(e.reason))).toBe(true);
  });
});

describe('xlsx workbook reading', () => {
  const { readWorkbook, readWorkbookRows } = require('../../src/services/parser.service');

  // A minimal but genuinely valid .xlsx. read-excel-file is a hard dependency of
  // every spreadsheet import, and its v8 release renamed the matrix-returning
  // function to `readSheet` and repurposed the default export to return every
  // sheet as [{ sheet, data }]. Nothing here parsed a real workbook, so the
  // upgrade to ^9 broke every .xlsx import silently: the parser destructured a
  // sheet object as a header row and threw "headerRow.map is not a function".
  const xlsxWith = (rows, { dimension, extraRowsXml = '', secondSheetXml } = {}) => {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const colName = (i) => {
      let s = '';
      let n = i;
      do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
      return s;
    };
    const sheetRows = rows.map((row, r) => {
      const cells = row.map((v, c) =>
        `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
      ).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('') + extraRowsXml;
    const dimensionTag = dimension ? `<dimension ref="${dimension}"/>` : '';
    const WORKSHEET = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const second = secondSheetXml
      ? { sheet: '<sheet name="Notes" sheetId="2" r:id="rId2"/>',
        rel: '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>',
        entry: [{ name: 'xl/worksheets/sheet2.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${WORKSHEET}>${secondSheetXml}</worksheet>` }] }
      : { sheet: '', rel: '', entry: [] };

    return buildStoredZip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/>${second.sheet}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${second.rel}</Relationships>` },
      { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimensionTag}<sheetData>${sheetRows}</sheetData></worksheet>` },
      ...second.entry,
    ]);
  };

  describe('a sheet that declares itself enormous', () => {
    // read-excel-file allocates rows x columns from what a sheet declares - its
    // <dimension ref>, or its furthest cell - before any row limit applies, so
    // a 2.6 KB file declaring A1:XFD1048576 asks for about 17 billion slots and
    // took the API down for every cafe. A guard that imitated the reader with
    // regexes was bypassed by r="XFD 1048576" (the reader trims the letters),
    // and a worker with a memory cap still handed a sparse 1,048,576-row matrix
    // back to the API. So the size comes from the reader's own steps, and the
    // matrix is only built when that size is safe.
    const SALES = [['Receipt', 'Date', 'Total'], ['R1', '2026-04-01', '35.00']];
    const mainHeapGrowthMb = async (run) => {
      // Warm the reader first: its first use loads modules and JIT code, which
      // CI counted as 27 MB of "growth" that has nothing to do with the file.
      await readWorkbook(xlsxWith(SALES));
      const before = process.memoryUsage().heapUsed;
      await run();
      return (process.memoryUsage().heapUsed - before) / (1024 * 1024);
    };

    it.each([
      ['a declared A1:XFD1048576', { dimension: 'A1:XFD1048576' }],
      ['a cell at "XFD 1048576", which the reader trims to XFD1048576', {
        extraRowsXml: '<row r="1048576"><c r="XFD 1048576" t="inlineStr"><is><t>x</t></is></c></row>',
      }],
      ['one real cell at Z1048576, which sizes a sparse 27-million-slot matrix', {
        extraRowsXml: '<row r="1048576"><c r="Z1048576" t="inlineStr"><is><t>x</t></is></c></row>',
      }],
      ['a declared size with no column letters (A1:1000000000)', { dimension: 'A1:1000000000' }],
      // The reader builds one array per row, so a thin sheet costs by its rows:
      // ten million rows of one column is ~640 MB, though only 10M "cells".
      ['a declared ten million rows of one column (A1:A10000000)', { dimension: 'A1:A10000000' }],
      ['one real cell at A10000000 and no declared size', {
        extraRowsXml: '<row r="10000000"><c r="A10000000" t="inlineStr"><is><t>x</t></is></c></row>',
      }],
    ])('refuses %s with a 400, and the API keeps its memory', async (_label, options) => {
      const bomb = xlsxWith(SALES, options);
      expect(bomb.length).toBeLessThan(4096);
      let thrown;
      const growth = await mainHeapGrowthMb(async () => {
        try { await readWorkbook(bomb); } catch (error) { thrown = error; }
      });

      expect(thrown && thrown.statusCode).toBe(400);
      expect(thrown && thrown.message).toMatch(/too large to read safely/i);
      expect(growth).toBeLessThan(20);
    }, 60_000);

    it('reads the first sheet when a second tab is enormous', async () => {
      // The reader parses sheet 1 only; a big notes tab is not a reason to refuse.
      const workbook = xlsxWith(SALES, {
        secondSheetXml: '<dimension ref="A1:XFD1048576"/><sheetData><row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>note</t></is></c></row></sheetData>',
      });
      expect(await readWorkbookRows(workbook)).toHaveLength(1);
    });

    it("borrows the reader's internal steps from the version they were taken from", () => {
      // readFirstSheet calls read-excel-file 9.2.0's own internal modules. 9.3
      // moved them (it parses with saxen), and package.json allows ^9.2.0 - so a
      // lockfile refresh must fail here, loudly, before it reaches production.
      const root = path.join(path.dirname(require.resolve('read-excel-file/node')), '..');
      const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      expect(version).toBe('9.2.0');
    });

    it('still reads a workbook whose declared size overshoots its data', async () => {
      // Real exports overstate their size (A1:Z65536 over a few rows); the
      // reader trims the empty space, and this imported before the check.
      const workbook = xlsxWith(SALES, { dimension: 'A1:Z65536' });
      expect(await readWorkbookRows(workbook)).toHaveLength(1);
    });

    it('still tells an owner their file has too many rows', async () => {
      // The portal turns "row limit" into its split-by-date-range advice, so an
      // over-limit export must keep hearing it, not a size refusal.
      const rows = [['Receipt', 'Date', 'Total']];
      for (let i = 0; i < 10001; i += 1) rows.push([`R${i}`, '2026-04-01', '1.00']);
      await expect(readWorkbook(xlsxWith(rows))).rejects.toThrow(/row limit/);
    }, 60_000);
  });

  it('reads a spreadsheet into header-keyed rows', async () => {
    const rows = await readWorkbookRows(xlsxWith([
      ['Receipt', 'Date', 'Items', 'Total'],
      ['R1', '2026-04-01', '1 x Flat White', '35.00'],
      ['R2', '2026-04-01', '2 x Muffin', '50.00'],
    ]));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Receipt: 'R1', Date: '2026-04-01', Items: '1 x Flat White', Total: '35.00' });
    expect(rows[1]).toMatchObject({ Receipt: 'R2', Total: '50.00' });
  });

  it('returns nothing for a workbook with only a header', async () => {
    expect(await readWorkbookRows(xlsxWith([['Receipt', 'Date']]))).toEqual([]);
  });

  it('skips blank rows rather than importing them', async () => {
    const rows = await readWorkbookRows(xlsxWith([
      ['Receipt', 'Total'],
      ['R1', '35.00'],
      ['', ''],
      ['R2', '50.00'],
    ]));
    expect(rows.map((r) => r.Receipt)).toEqual(['R1', 'R2']);
  });

  it('reports the header row even when the sheet has no data rows', async () => {
    // CSV keeps its headers for an empty export, XLSX did not: previewWorkbook
    // derived them from the first data row, so a cafe exporting a quiet period
    // was told "Could not parse file headers" when the headers were fine and it
    // was the sales that were missing.
    const { readWorkbook } = require('../../src/services/parser.service');
    const { headers, rows } = await readWorkbook(xlsxWith([['Receipt', 'Date', 'Total']]));

    expect(headers).toEqual(['Receipt', 'Date', 'Total']);
    expect(rows).toEqual([]);
  });

  it('reports headers alongside rows for a populated sheet', async () => {
    const { readWorkbook } = require('../../src/services/parser.service');
    const { headers, rows } = await readWorkbook(xlsxWith([
      ['Receipt', 'Total'],
      ['R1', '35.00'],
    ]));
    expect(headers).toEqual(['Receipt', 'Total']);
    expect(rows).toHaveLength(1);
  });

  it('de-duplicates repeated workbook headers the same way for preview and parse (BE-03-T01, WS-08-T08)', async () => {
    const { previewBuffer } = require('../../src/services/ingestion.service');
    const workbook = xlsxWith([['Date', 'Total', 'Total'], ['2026-09-14', '100.00', '86.96']]);
    const read = await readWorkbook(workbook);
    const preview = await previewBuffer(workbook, 'xlsx');
    expect(read.headers).toEqual(['Date', 'Total', 'Total (2)']);
    expect(preview.headers).toEqual(read.headers);
    expect(preview.sampleRows[0]).toMatchObject({ Total: '100.00', 'Total (2)': '86.96' });
  });
});


describe('fractional quantities survive validation', () => {
  const mapping = {
    receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total',
  };

  // parsePackedItems was taught to read "0.35 x Cheese Wheel" as 0.35, but two
  // downstream checks still assumed whole numbers: the packed validator required
  // a safe integer (and blamed the 10000 limit for a quantity of 0.35), while
  // parseQuantity truncated the Qty column to zero and called it invalid. A
  // deli selling by weight could not import either way.
  it('accepts a sub-unit packed quantity', async () => {
    const csv = 'Receipt,Date,Items,Total\nF1,2026-04-01,0.35 x Cheese Wheel,52.50';
    const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].items[0]).toMatchObject({ name: 'Cheese Wheel', quantity: 0.35 });
  });

  it('accepts a fractional Qty column', async () => {
    const csv = 'Receipt,Date,Item,Qty,Total\nF2,2026-04-01,Gouda,0.75,60.00';
    const result = await parseBuffer(Buffer.from(csv), {
      columnMapping: { receiptId: 'Receipt', date: 'Date', items: 'Item', quantity: 'Qty', total: 'Total' },
      itemsMode: 'line-per-row',
    });

    expect(result.rowErrors).toEqual([]);
    expect(result.rows[0].items[0]).toMatchObject({ name: 'Gouda', quantity: 0.75 });
  });

  it('still refuses a quantity of zero or below', async () => {
    const csv = 'Receipt,Date,Items,Total\nF3,2026-04-01,0 x Ghost,10';
    const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });
    expect(result.rows).toHaveLength(0);
  });

  it('still refuses a quantity beyond the limit, and says so accurately', async () => {
    const csv = 'Receipt,Date,Items,Total\nF4,2026-04-01,10001 x Foo,10';
    const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });
    expect(result.rowErrors[0].reason).toMatch(/quantity exceeds/i);
  });
});

describe('packed unit price provenance', () => {
  const mapping = { receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total' };
  const parse = (line) => parseBuffer(
    Buffer.from(`Receipt,Date,Items,Total\n${line}`),
    { columnMapping: mapping, itemsMode: 'packed' }
  );

  // A packed row carries one total for the basket. Stamping total / quantity
  // on every line made a Flat White and a Coca Cola on one receipt both cost
  // 33.33, and the menu learned those averages as expected prices: nearly
  // every item then showed a false "price differs" warning.
  it('flags the basket average of a multi-item receipt as derived', async () => {
    const result = await parse('P1,2026-04-01,"2 x Flat White,1 x Coca Cola 330ml",100.00');

    expect(result.rows[0].items).toEqual([
      { name: 'Flat White', quantity: 2, unitPrice: 33.33, priceSource: 'derived' },
      { name: 'Coca Cola 330ml', quantity: 1, unitPrice: 33.33, priceSource: 'derived' },
    ]);
    const revenue = result.rows[0].items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    expect(revenue).toBeCloseTo(100, 1);
  });

  it('divides a single-item receipt total by its quantity as an exact price', async () => {
    const result = await parse('P2,2026-04-01,3 x Flat White,114.00');

    expect(result.rows[0].items).toEqual([
      { name: 'Flat White', quantity: 3, unitPrice: 38, priceSource: 'exact' },
    ]);
  });

  it('treats a receipt that repeats one item name as a single-item receipt', async () => {
    const result = await parse('P3,2026-04-01,"1 x Flat White,1 x Flat White",76.00');

    expect(result.rows[0].items).toEqual([
      { name: 'Flat White', quantity: 1, unitPrice: 38, priceSource: 'exact' },
      { name: 'Flat White', quantity: 1, unitPrice: 38, priceSource: 'exact' },
    ]);
  });
});

describe('line-per-row totals mode is inferred from the data', () => {
  const { groupLinePerRow } = require('../../src/services/parser.service');
  const base = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Item', quantity: 'Qty' };
  const parseWith = (totalHeader, lines) => parseBuffer(
    Buffer.from([`Receipt,Date,Time,Item,Qty,${totalHeader}`, ...lines].join('\n')),
    { columnMapping: { ...base, total: totalHeader }, itemsMode: 'line-per-row' }
  );

  // Receipts whose two rows both carry the receipt total (60, 61, 62, ...).
  const repeatedTotalReceipts = (count) => Array.from({ length: count }, (_, index) => [
    `R${index},2026-04-01,08:30,Flat White,2,${(60 + index).toFixed(2)}`,
    `R${index},2026-04-01,08:30,Muffin,1,${(60 + index).toFixed(2)}`,
  ]).flat();
  // Receipts whose rows carry genuine line amounts (70 + 25, 70 + 26, ...).
  const lineAmountReceipts = (count) => Array.from({ length: count }, (_, index) => [
    `L${index},2026-04-01,09:00,Flat White,2,70.00`,
    `L${index},2026-04-01,09:00,Muffin,1,${(25 + index).toFixed(2)}`,
  ]).flat();

  // Whether row totals were summed used to be decided by the mapped column's
  // NAME: anything containing "line" or "item" was summed. A till that repeats
  // the order total on every line under "Item Total" had every receipt
  // multiplied by its line count, and revenue inflated silently.
  it('does not sum an order total repeated per line just because the header says "Item Total"', async () => {
    const result = await parseWith('Item Total', repeatedTotalReceipts(5));

    expect(result.rowErrors).toEqual([]);
    expect(result.rows.map((row) => row.total)).toEqual([60, 61, 62, 63, 64]);
  });

  it('sums genuine line amounts even when the header is just "Total"', async () => {
    const result = await parseWith('Total', lineAmountReceipts(5));

    expect(result.rowErrors).toEqual([]);
    expect(result.rows.map((row) => row.total)).toEqual([95, 96, 97, 98, 99]);
    expect(result.rows[0].items).toEqual([
      { name: 'Flat White', quantity: 2, unitPrice: 35, priceSource: 'exact' },
      { name: 'Muffin', quantity: 1, unitPrice: 25, priceSource: 'exact' },
    ]);
  });

  it('keeps the header reading for a lone receipt whose line amounts happen to match', async () => {
    // One receipt is no evidence: two items at the same price is an everyday
    // coincidence, and reading it as a repeated receipt total would halve the
    // sale and mark two exact line prices as derived.
    const result = await parseWith('Line Total', [
      'R1,2026-04-01,08:30,Flat White,1,35.00',
      'R1,2026-04-01,08:30,Cappuccino,1,35.00',
    ]);

    expect(result.rowErrors).toEqual([]);
    expect(result.rows[0].total).toBe(70);
    expect(result.rows[0].items.map((item) => item.priceSource)).toEqual(['exact', 'exact']);
  });

  it('falls back to the header heuristic when no receipt has more than one row', () => {
    const rowsUnder = (header) => [
      { Receipt: 'S1', Date: '2026-04-01', Time: '08:30', Item: 'Flat White', Qty: '1', [header]: '35.00' },
      { Receipt: 'S2', Date: '2026-04-01', Time: '09:00', Item: 'Muffin', Qty: '1', [header]: '25.00' },
    ];

    const plain = groupLinePerRow(rowsUnder('Total'), { ...base, total: 'Total' }, 'Africa/Johannesburg');
    const line = groupLinePerRow(rowsUnder('Line Total'), { ...base, total: 'Line Total' }, 'Africa/Johannesburg');

    expect(plain.rows).toHaveLength(2);
    expect(plain.totalsAreLineAmounts).toBe(false);
    expect(line.rows).toHaveLength(2);
    expect(line.totalsAreLineAmounts).toBe(true);
  });

  it('falls back to the header heuristic when the data is ambiguous', async () => {
    // Half the multi-row receipts repeat a total, half differ: neither
    // reading reaches consensus, so the header decides as before.
    const lines = [...repeatedTotalReceipts(3), ...lineAmountReceipts(3)];

    const plain = await parseWith('Total', lines);
    expect(plain.rows.map((row) => row.total)).toEqual([60, 61, 62]);
    expect(plain.rowErrors).toHaveLength(3);
    expect(plain.rowErrors.every((error) => /conflicting receipt totals/i.test(error.reason))).toBe(true);

    const line = await parseWith('Line Total', lines);
    expect(line.rowErrors).toEqual([]);
    expect(line.rows.map((row) => row.total)).toEqual([120, 122, 124, 95, 96, 97]);
  });
});

describe('optional tip and discount columns', () => {
  const header = 'Receipt,Date,Time,Items,Total,Tip,Discount';
  const mapping = {
    receiptId: 'Receipt', date: 'Date', time: 'Time',
    items: 'Items', total: 'Total', tip: 'Tip', discount: 'Discount',
  };
  const parse = (line) =>
    parseBuffer(Buffer.from(`${header}\n${line}\n`), { columnMapping: mapping, itemsMode: 'packed' });

  // Tills leave Tip and Discount empty on a cash sale rather than writing 0.0.
  // A blank cell was read as an unparseable amount and the whole row was
  // discarded -- so a till with that habit lost every cash transaction, and was
  // told its amount had exceeded ten million.
  it('reads a blank tip or discount as no tip, not as an unreadable amount', async () => {
    const result = await parse('R1,2026-09-01,09:00,1 x Latte,35.00,,');

    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ total: 35, tip: 0, discount: 0 });
  });

  it('still rejects a tip cell that genuinely cannot be read, and names it', async () => {
    const result = await parse('R2,2026-09-01,09:00,1 x Latte,35.00,abc,0.0');

    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors[0]).toMatchObject({ rowNumber: 2, reason: 'Tip is not a valid amount' });
  });

  it('names the discount when it is the column that exceeds the amount limit', async () => {
    const result = await parse('R3,2026-09-01,09:00,1 x Latte,35.00,0.0,10000001');

    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors[0].reason).toMatch(/^Discount exceeds the \d+ amount limit$/);
  });

  it('reads a blank tip in line-per-row mode too', async () => {
    const csv = [
      'Receipt,Date,Time,Item,Qty,Total,Tip,Discount',
      'R4,2026-09-01,09:00,Latte,1,35.00,,',
    ].join('\n');
    const result = await parseBuffer(Buffer.from(csv), {
      columnMapping: {
        receiptId: 'Receipt', date: 'Date', time: 'Time',
        items: 'Item', quantity: 'Qty', total: 'Total', tip: 'Tip', discount: 'Discount',
      },
      itemsMode: 'line-per-row',
    });

    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ tip: 0, discount: 0 });
  });
});

describe('two-digit years are day-first, like every other date on an SA till', () => {
  const mapping = { date: 'Date', items: 'Items', total: 'Total' };
  const parse = (date) =>
    parseBuffer(Buffer.from(`Date,Items,Total\n${date},1 x Latte,35.00\n`), {
      columnMapping: mapping, itemsMode: 'packed', timezone: 'Africa/Johannesburg',
    });

  // Nothing matched a two-digit year, so the cell fell through to V8's
  // month-first reading: 03/09/26 landed on 9 March instead of 3 September, and
  // 13/09/26 was rejected outright. Days 1-12 moved month silently; days 13-31
  // vanished.
  it('reads 03/09/26 as 3 September, not 9 March', async () => {
    const result = await parse('03/09/26');
    expect(result.rows[0].dateKey).toBe('2026-09-03');
  });

  it('accepts a day above 12 instead of discarding the row', async () => {
    const result = await parse('13/09/26');
    expect(result.rowErrors).toEqual([]);
    expect(result.rows[0].dateKey).toBe('2026-09-13');
  });

  it('accepts dot separators, which SA tills also print', async () => {
    expect((await parse('26.09.2026')).rows[0].dateKey).toBe('2026-09-26');
    expect((await parse('26.09.26')).rows[0].dateKey).toBe('2026-09-26');
  });

  it('puts 70-99 in the 1900s and 00-69 in the 2000s', async () => {
    // Pins the pivot from both sides: a 1998 export is history the row bounds
    // refuse, and a 2069 one has not happened yet.
    expect((await parse('03/09/98')).rowErrors[0].reason).toMatch(/before 2000/i);
    expect((await parse('03/09/69')).rowErrors[0].reason).toMatch(/in the future/i);
  });
});

describe('a date cell carrying its own time is read in the cafe timezone', () => {
  const mapping = { date: 'Date', items: 'Items', total: 'Total' };
  const parseIn = (cell, timezone) =>
    parseBuffer(Buffer.from(`Date,Items,Total\n"${cell}",1 x Latte,35.00\n`), {
      columnMapping: mapping, itemsMode: 'packed', timezone,
    });

  // A combined cell reached `new Date`, which resolves a naive local string in
  // the NODE process timezone and not the cafe's, and applyTimeParts then only
  // re-read the resulting instant. On a UTC host every sale after 22:00 SAST
  // was stamped with the next trading day and every hour shifted by two. The
  // two zones below make that visible on any host: before the fix both gave the
  // same instant, because both were really the process timezone.
  it.each([
    ['2026-09-03 23:30'],
    ['2026-09-03T23:30:00'],
  ])('resolves %s against the cafe zone, not the host zone', async (cell) => {
    const za = await parseIn(cell, 'Africa/Johannesburg');
    const nz = await parseIn(cell, 'Pacific/Auckland');

    expect(za.rows[0].date.toISOString()).toBe('2026-09-03T21:30:00.000Z');
    expect(za.rows[0]).toMatchObject({ dateKey: '2026-09-03', hour: 23 });
    expect(nz.rows[0].date.toISOString()).toBe('2026-09-03T11:30:00.000Z');
    expect(nz.rows[0]).toMatchObject({ dateKey: '2026-09-03', hour: 23 });
  });

  it('reads a day-first combined cell day-first', async () => {
    const result = await parseIn('03/09/2026 14:30', 'Africa/Johannesburg');
    expect(result.rows[0].date.toISOString()).toBe('2026-09-03T12:30:00.000Z');
    expect(result.rows[0]).toMatchObject({ dateKey: '2026-09-03', hour: 14 });
  });

  it('leaves a timestamp that carries its own offset alone', async () => {
    // An explicit Z is already unambiguous: 23:30 UTC really is 01:30 the next
    // morning in Johannesburg, and re-reading it as wall-clock would move it.
    const result = await parseIn('2026-09-03T23:30:00Z', 'Africa/Johannesburg');
    expect(result.rows[0].date.toISOString()).toBe('2026-09-03T23:30:00.000Z');
    expect(result.rows[0]).toMatchObject({ dateKey: '2026-09-04', hour: 1 });
  });

  it('still lets a mapped Time column win over a time inside the date cell', async () => {
    const result = await parseBuffer(
      Buffer.from('Date,Time,Items,Total\n"2026-09-03 23:30",08:15,1 x Latte,35.00\n'),
      {
        columnMapping: { date: 'Date', time: 'Time', items: 'Items', total: 'Total' },
        itemsMode: 'packed',
        timezone: 'Africa/Johannesburg',
      }
    );
    expect(result.rows[0].hour).toBe(8);
  });
});

describe('packed item strings a till actually prints', () => {
  const { parsePackedItems } = require('../../src/services/parser.service');

  // A till that separates basket lines with newlines inside a quoted cell only
  // ever had its LAST line read: the pattern's `.` cannot cross a newline and
  // its `$` is end-of-string. One item vanished from demand history with no
  // error, and the survivor absorbed the whole basket total as an "exact" price.
  it('splits basket lines separated by newlines', () => {
    expect(parsePackedItems('1 x Flat White\n2 x Muffin')).toEqual([
      { name: 'Flat White', quantity: 1 },
      { name: 'Muffin', quantity: 2 },
    ]);
  });

  // Plenty of tills print the multiplication sign rather than an ASCII x. The
  // sign stayed glued to the name, so "Flat White" and "x Flat White" became
  // two products and the history split in half.
  it.each([['×'], ['x'], ['X']])('accepts %s as the multiplication marker', (marker) => {
    expect(parsePackedItems(`2 ${marker} Flat White`)).toEqual([
      { name: 'Flat White', quantity: 2 },
    ]);
  });

  it('splits a cell that mixes the two markers', () => {
    expect(parsePackedItems('2 x Flat White,1 × Muffin')).toEqual([
      { name: 'Flat White', quantity: 2 },
      { name: 'Muffin', quantity: 1 },
    ]);
  });

  // South Africa writes one-and-a-half as 1,5. The quantity pattern took a dot
  // only, so the engine stepped over "1," and read the fraction as a whole
  // number: 1,5 kg of biltong was recorded as 5 units.
  it('reads a comma-decimal quantity as a fraction', () => {
    expect(parsePackedItems('1,5 x Biltong')).toEqual([{ name: 'Biltong', quantity: 1.5 }]);
    expect(parsePackedItems('2 x Flat White,0,5 x Carrot Cake')).toEqual([
      { name: 'Flat White', quantity: 2 },
      { name: 'Carrot Cake', quantity: 0.5 },
    ]);
  });

  // Real menu names start with numbers. With the marker optional, "500 Still
  // Water" became 500 units of "Still Water" -- phantom demand for a product
  // that no longer matched its own menu entry.
  it.each([
    ['330 Coke'],
    ['500 Still Water'],
    ['2 Minute Noodles'],
    ['6 Pack Castle Lite'],
  ])('treats %s as one product whose name begins with a number', (description) => {
    expect(parsePackedItems(description)).toEqual([{ name: description, quantity: 1 }]);
  });

  it('drops a part that is only a number rather than inventing a product named "2"', () => {
    expect(parsePackedItems('2')).toEqual([]);
    expect(parsePackedItems('Latte,2')).toEqual([{ name: 'Latte', quantity: 1 }]);
  });
});

describe('column and delimiter identification', () => {
  const { detectCsvSeparator } = require('../../src/services/parser.service');

  // "Text (Tab delimited)" is a standard Excel save-as and several tills use a
  // .csv extension for it. Only ';' was ever weighed against ',', so the whole
  // header row collapsed into one column and the mapping step was impossible.
  it.each([
    ['tab', 'a\tb\tc\n1\t2\t3', '\t'],
    ['pipe', 'a|b|c\n1|2|3', '|'],
    ['semicolon', 'a;b;c\n1;2;3', ';'],
    ['comma', 'a,b,c\n1,2,3', ','],
  ])('detects a %s-delimited export', (_label, content, expected) => {
    expect(detectCsvSeparator(Buffer.from(content))).toBe(expected);
  });

  it('is not fooled by a comma inside one quoted cell of a semicolon file', () => {
    expect(detectCsvSeparator(Buffer.from('a;b;c\n1;2;"R 1 234,56"'))).toBe(';');
  });

  // POS exports repeat column names -- "Amount" for gross and net, "Total" for
  // the line and the receipt. Collapsed into one key the last column silently
  // won, so the operator mapped a column they had never seen and the money came
  // out wrong with no warning anywhere.
  it('keeps a repeated column name addressable instead of letting the last one win', async () => {
    const csv = 'Date,Items,Total,Total\n2026-09-03,1 x Foo,10,999\n';

    const first = await parseBuffer(Buffer.from(csv), {
      itemsMode: 'packed', columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
    });
    const second = await parseBuffer(Buffer.from(csv), {
      itemsMode: 'packed', columnMapping: { date: 'Date', items: 'Items', total: 'Total (2)' },
    });

    expect(first.rows[0].total).toBe(10);
    expect(second.rows[0].total).toBe(999);
  });
});

describe('one bad cell is a row problem, not a file problem', () => {
  const mapping = { date: 'Date', items: 'Items', total: 'Total' };

  // A single runaway cell -- a pasted note, an escaped-quote bug in the till's
  // own export -- threw out of the parser and killed a 10,000-row import, with
  // an error naming neither the row nor the column. The cell was not even in a
  // mapped column.
  it('keeps importing when an unmapped cell runs past the cell length limit', async () => {
    const note = 'a'.repeat(10001);
    const csv = `Date,Items,Total,Note\n2026-09-01,1 x Foo,10,"${note}"\n2026-09-02,1 x Bar,12,ok\n`;
    const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

    expect(result.rows).toHaveLength(2);
    expect(result.errors).toBe(0);
  });

  // A numeric junk date reached `new Date('0')`, which V8 reads as the year
  // 2000. That passed the minimum-year floor, widened the file's span to
  // twenty-six years, and the whole upload was refused for a date range the
  // operator's three-day file never had.
  it('treats a bare number in the date column as a row error, not a date', async () => {
    const csv = 'Date,Items,Total\n2026-09-01,1 x Foo,10\n2026-09-02,1 x Foo,10\n0,1 x Foo,10';
    const result = await parseBuffer(Buffer.from(csv), { columnMapping: mapping, itemsMode: 'packed' });

    expect(result.rows).toHaveLength(2);
    expect(result.rowErrors).toEqual([
      expect.objectContaining({ rowNumber: 4, reason: 'Could not parse date or time' }),
    ]);
  });

  it('tells an owner with a legacy .xls export what to do about it', async () => {
    await expect(parseBuffer(Buffer.from('Date,Items,Total\n2026-09-01,1 x Foo,10\n'), {
      columnMapping: mapping, itemsMode: 'packed', fileExt: 'xls',
    })).rejects.toThrow(/CSV UTF-8/i);
  });

  it('names the format so the owner knows what they have', async () => {
    const csv = ['Date,Items,Total', '2026-09-01,1 x Foo,10', ''].join(String.fromCharCode(10));
    await expect(parseBuffer(Buffer.from(csv), {
      columnMapping: mapping, itemsMode: 'packed', fileExt: 'xls',
    })).rejects.toThrow(/legacy [.]xls/i);
  });
});

describe('signed money on accounting-style exports', () => {
  const mapping = { date: 'Date', items: 'Items', total: 'Total' };
  const totalOf = async (cell) => {
    const result = await parseBuffer(
      Buffer.from(`Date,Items,Total\n2026-09-01,1 x Foo,${JSON.stringify(cell)}\n`),
      { columnMapping: mapping, itemsMode: 'packed' }
    );
    return result.rows[0]?.total;
  };

  // Every minus after the first character was stripped, so the trailing-minus
  // convention lost its sign entirely, and the parenthesis test ran on the raw
  // string so a currency symbol in front of it hid the brackets. Either way a
  // refund was booked as revenue and the day's takings overstated by twice it.
  it.each([
    ['45.00-', -45],
    ['R(150.00)', -150],
    ['(150.00)', -150],
    ['-45.00', -45],
  ])('reads %s as %s', async (cell, expected) => {
    expect(await totalOf(cell)).toBe(expected);
  });

  it('still reads South African comma decimals and spaced thousands', async () => {
    expect(await totalOf('12,50')).toBe(12.5);
    expect(await totalOf('R 1 234,56')).toBe(1234.56);
    expect(await totalOf('R12.50')).toBe(12.5);
    expect(await totalOf('1,234')).toBe(1234);
  });
});

describe('a discarded receipt is counted in full', () => {
  const { groupLinePerRow } = require('../../src/services/parser.service');
  const mapping = {
    receiptId: 'Receipt', date: 'Date', time: 'Time',
    items: 'Item', quantity: 'Qty', total: 'Total',
  };

  // Invalidating a receipt threw away the rows already accepted into it while
  // counting one error, so the summary under-reported the damage: the operator
  // reconciled against the till report, found revenue missing, and the error
  // list gave them no row number to look at.
  it('counts every row it drops when a receipt contradicts itself', () => {
    const result = groupLinePerRow([
      { Receipt: 'R1', Date: '2026-09-01', Time: '08:00', Item: 'A', Qty: '1', Total: '10' },
      { Receipt: 'R1', Date: '2026-09-01', Time: '08:00', Item: 'B', Qty: '1', Total: '10' },
      { Receipt: 'R1', Date: '2026-09-01', Time: '09:00', Item: 'C', Qty: '1', Total: '10' },
    ], mapping, 'Africa/Johannesburg');

    expect(result.rows).toHaveLength(0);
    expect(result.errors).toBe(3);
    expect(result.rowErrors[0].reason).toMatch(/rows 2, 3/);
  });

  it('counts every row of a receipt whose totals cannot be reconciled', async () => {
    const lines = ['Receipt,Date,Time,Item,Qty,Total'];
    for (let index = 0; index < 5; index += 1) {
      lines.push(`R-ok-${index},2026-04-01,08:30,Flat White,1,60.00`);
      lines.push(`R-ok-${index},2026-04-01,08:30,Muffin,1,60.00`);
    }
    lines.push('R-conflict,2026-04-01,08:30,Flat White,1,35.00');
    lines.push('R-conflict,2026-04-01,08:30,Muffin,1,25.00');
    const result = await parseBuffer(Buffer.from(lines.join('\n')), {
      columnMapping: mapping, itemsMode: 'line-per-row',
    });

    expect(result.rows).toHaveLength(5);
    expect(result.errors).toBe(2);
  });
});

describe('legacy .xls detection', () => {
  const parser = require('../../src/services/parser.service');
  const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const ole2File = Buffer.concat([OLE2, Buffer.alloc(512)]);

  it('names legacy .xls by its bytes, whatever the extension claims', () => {
    // An owner whose till writes .xls often renames it to .xlsx and tries again.
    // Before this, that produced "XLSX file signature is invalid" - true, and
    // useless: it does not say what the file actually is or what to do.
    expect(() => parser.assertSupportedFileBuffer(ole2File, 'xlsx')).toThrow(/legacy \.xls/i);
    expect(() => parser.assertSupportedFileBuffer(ole2File, 'csv')).toThrow(/legacy \.xls/i);
    expect(() => parser.assertSupportedFileBuffer(ole2File, 'xls')).toThrow(/legacy \.xls/i);
  });

  it('tells the owner what to export instead', () => {
    expect(() => parser.assertSupportedFileBuffer(ole2File, 'xls')).toThrow(/CSV UTF-8/i);
  });

  it('is a client input error, not a 500', () => {
    try {
      parser.assertSupportedFileBuffer(ole2File, 'xls');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('LEGACY_XLS');
    }
  });

  it('still rejects a genuinely corrupt xlsx as a signature problem', () => {
    const notZip = Buffer.concat([Buffer.from('not a zip at all'), Buffer.alloc(64)]);
    expect(() => parser.assertSupportedFileBuffer(notZip, 'xlsx')).toThrow(/signature is invalid/i);
  });
});

describe('Excel "sep=" preamble', () => {
  const {
    csvSeparatorDirective,
    detectCsvSeparator,
    parseBuffer,
  } = require('../../src/services/parser.service');
  const LF = String.fromCharCode(10);
  const MAPPING = {
    receiptId: 'Receipt',
    date: 'Date',
    time: 'Time',
    status: 'Status',
    items: 'Items',
    total: 'Total (incl. tax)',
  };
  const parse = (text) =>
    parseBuffer(Buffer.isBuffer(text) ? text : Buffer.from(text), {
      columnMapping: MAPPING,
      fileExt: 'csv',
    });

  // Excel writes `sep=;` as the first line whenever the machine's list
  // separator is not a comma, which is the default on South African and most
  // European Windows installs. Production upload 6a3289a4 is stuck on exactly
  // this: its headers read ["sep=", ""] and it imported nothing.
  //
  // It matters beyond that one file. The fix we hand someone with a legacy
  // .xls is "Save As CSV UTF-8", so this is the very next thing that same
  // owner produces.
  it('imports a semicolon export instead of reading the directive as headers', async () => {
    const result = await parse([
      'sep=;',
      'Receipt;Date;Time;Status;Items;Total (incl. tax)',
      '1001;2026/09/14;09:00:00;Approved;1 x Flat White;38.00',
    ].join(LF));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].receiptId).toBe('1001');
    expect(result.rows[0].total).toBe(38);
    expect(result.errors).toBe(0);
  });

  it('believes the file about its separator, over its own guess', () => {
    // One column per row gives the detector nothing to score, so the
    // declaration is the only reliable signal.
    const declared = Buffer.from(['sep=;', 'Receipt', '1001'].join(LF));
    expect(detectCsvSeparator(declared)).toBe(';');
  });

  it('accepts a tab declaration behind a BOM', async () => {
    const TAB = String.fromCharCode(9);
    const body = [
      'sep=\\t',
      ['Receipt', 'Date', 'Time', 'Status', 'Items', 'Total (incl. tax)'].join(TAB),
      ['1001', '2026/09/14', '09:00:00', 'Approved', '1 x Flat White', '38.00'].join(TAB),
    ].join(LF);
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]);

    const result = await parse(withBom);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].total).toBe(38);
  });

  it('leaves an ordinary comma export exactly as it was', async () => {
    const plain = [
      'Receipt,Date,Time,Status,Items,Total (incl. tax)',
      '1001,2026/09/14,09:00:00,Approved,1 x Flat White,38.00',
    ].join(LF);

    expect(detectCsvSeparator(Buffer.from(plain))).toBe(',');
    const result = await parse(plain);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].receiptId).toBe('1001');
  });

  it('does not mistake a genuine column named sep= for a directive', () => {
    // The directive only counts on the first line, alone on it.
    expect(csvSeparatorDirective(Buffer.from('Receipt,sep=x' + LF + '1001,yes'))).toBeNull();
    expect(csvSeparatorDirective(Buffer.from('Receipt,Total' + LF + 'sep=;'))).toBeNull();
  });
});

describe('one CSV reader for preview and parse', () => {
  const LF = String.fromCharCode(10);
  const { readCsv } = require('../../src/services/parser.service');
  const { previewBuffer } = require('../../src/services/ingestion.service');
  const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total (2)' };
  const DUPLICATE_TOTALS = [
    'Receipt,Date,Time,Items,Total,Total',
    'D1,2026-09-14,09:00,1 x Latte,100.00,86.96',
    'D2,2026-09-14,10:00,2 x Muffin,60.00,52.17',
  ].join(LF);

  afterEach(() => { delete process.env.UPLOAD_MAX_COLUMNS; });

  it('is the reader behind both preview and parse, so they see the same columns', async () => {
    const buffer = Buffer.from(DUPLICATE_TOTALS);
    const read = await readCsv(buffer);
    const preview = await previewBuffer(buffer, 'csv');

    expect(read.headers).toEqual(['Receipt', 'Date', 'Time', 'Items', 'Total', 'Total (2)']);
    expect(preview.headers).toEqual(read.headers);
    expect(preview.sampleRows[0]).toEqual(read.rows[0]);
    expect(read.rows[0]).toMatchObject({ Total: '100.00', 'Total (2)': '86.96' });
    expect(read.rows[0].__sourceRowNumbers).toEqual([2]);
  });

  it('imports the column the preview showed under the name the preview gave it', async () => {
    const parsed = await parseBuffer(Buffer.from(DUPLICATE_TOTALS), { columnMapping: MAPPING, fileExt: 'csv' });
    expect(parsed.rows.map((row) => row.total)).toEqual([86.96, 52.17]);
  });

  it('strips an Excel sep= line in preview exactly as in parse', async () => {
    const buffer = Buffer.from(['sep=;', 'Sale Date;Description;Amount', '2026-09-14;1 x Latte;R 35,00'].join(LF));
    const preview = await previewBuffer(buffer, 'csv');
    expect(preview.headers).toEqual(['Sale Date', 'Description', 'Amount']);
    expect(preview.sampleRows[0]).toMatchObject({ Amount: 'R 35,00' });
    expect((await readCsv(buffer)).headers).toEqual(preview.headers);
  });

  it('applies the same column limit to a wide data row in preview and in parse', async () => {
    process.env.UPLOAD_MAX_COLUMNS = '3';
    const buffer = Buffer.from(['Date,Items,Total', '2026-09-14,1 x Latte,38.00,extra,cells'].join(LF));
    const expected = { statusCode: 400, message: 'File exceeds the 3 column limit' };
    await expect(previewBuffer(buffer, 'csv')).rejects.toMatchObject(expected);
    await expect(parseBuffer(buffer, {
      columnMapping: { date: 'Date', items: 'Items', total: 'Total' }, fileExt: 'csv',
    })).rejects.toMatchObject(expected);
  });
});

describe('Excel scientific notation in receipt numbers', () => {
  const LF = String.fromCharCode(10);
  const packed = { receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total' };

  it('makes a mangled receipt number a row error that says what happened', async () => {
    const result = await parseBuffer(
      Buffer.from(['Receipt,Date,Items,Total', '2.02609E+16,2026-09-14,1 x Latte,38.00'].join(LF)),
      { columnMapping: packed, itemsMode: 'packed', timezone: 'Africa/Johannesburg' }
    );
    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors[0].reason).toMatch(/Excel into scientific notation/);
  });

  it('does the same in line-per-row mode and leaves ordinary numbers alone', async () => {
    const result = await parseBuffer(
      Buffer.from(['Receipt,Date,Item,Line Total', '2.02609e16,2026-09-14,Latte,38.00', 'E-1001,2026-09-14,Muffin,30.00'].join(LF)),
      {
        columnMapping: { receiptId: 'Receipt', date: 'Date', items: 'Item', total: 'Line Total' },
        itemsMode: 'line-per-row',
        timezone: 'Africa/Johannesburg',
      }
    );
    expect(result.rows.map((row) => row.receiptId)).toEqual(['E-1001']);
    expect(result.rowErrors[0].reason).toMatch(/scientific notation/);
  });
});

describe('dates and times as tills write them', () => {
  const fs = require('fs');
  const path = require('path');
  const LF = String.fromCharCode(10);
  const ZONE = 'Africa/Johannesburg';
  const WITH_TIME = { date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
  const DATE_ONLY = { date: 'Date', items: 'Items', total: 'Total' };
  const parse = (lines, mapping, timezone = ZONE) =>
    parseBuffer(Buffer.from(lines.join(LF)), { columnMapping: mapping, itemsMode: 'packed', timezone });

  it.each([
    ['2:15 PM', 14, 15],
    ['2:15:30 pm', 14, 15],
    ['12:05 AM', 0, 5],
    ['12:30 PM', 12, 30],
    ['11:59 p.m.', 23, 59],
    ['09:45', 9, 45],
    ['09:45:12.500', 9, 45],
  ])('reads %s as %i:%i in the cafe zone', async (time, hour, minute) => {
    const result = await parse(['Date,Time,Items,Total', `2026-09-14,${time},1 x Latte,38.00`], WITH_TIME);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ hour, hourKnown: true, dateKey: '2026-09-14' });
    expect(result.rows[0].date.getUTCMinutes()).toBe(minute);
  });

  it('refuses an hour above 12 written with AM or PM', async () => {
    const result = await parse(['Date,Time,Items,Total', '2026-09-14,13:00 PM,1 x Latte,38.00'], WITH_TIME);
    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors[0].reason).toBe('Could not parse date or time');
  });

  it.each([
    ['2026-09-14 2:15 PM', '2026-09-14T12:15:00.000Z'],
    ['2026-09-14 23:30:00.000', '2026-09-14T21:30:00.000Z'],
    ['14 Sep 2026 23:30', '2026-09-14T21:30:00.000Z'],
    ['14-Sep-2026 23:30', '2026-09-14T21:30:00.000Z'],
    ['Sep 14, 2026 11:30 PM', '2026-09-14T21:30:00.000Z'],
    ['Mon, 14 September 2026 23:30', '2026-09-14T21:30:00.000Z'],
  ])('builds %s from its parts in the cafe zone', async (cell, iso) => {
    const za = await parse(['Date,Items,Total', `"${cell}",1 x Latte,38.00`], DATE_ONLY);
    expect(za.rows[0].date.toISOString()).toBe(iso);
    expect(za.rows[0].hourKnown).toBe(true);
    const nz = await parse(['Date,Items,Total', `"${cell}",1 x Latte,38.00`], DATE_ONLY, 'Pacific/Auckland');
    expect(nz.rows[0].dateKey).toBe('2026-09-14'); // the same wall-clock day in the other zone, not the host's
  });

  it('reads a month-first file month-first, from its own values', async () => {
    // UAT-00 F06 month-first-dates.csv: a day above 12 in the second position settles the order.
    const result = await parse(['Date,Items,Total', '09/13/2026,1 x Latte,38.00', '09/03/2026,1 x Muffin,30.00'], DATE_ONLY);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows.map((row) => row.dateKey)).toEqual(['2026-09-13', '2026-09-03']);
  });

  it('keeps an undecidable file day-first, the South African default', async () => {
    const result = await parse(['Date,Items,Total', '03/09/2026,1 x Latte,38.00', '04/09/2026,1 x Muffin,30.00'], DATE_ONLY);
    expect(result.rows.map((row) => row.dateKey)).toEqual(['2026-09-03', '2026-09-04']);
  });

  it('refuses a file that mixes both orders, naming the rows', async () => {
    await expect(parse(['Date,Items,Total', '13/09/2026,1 x Latte,38.00', '09/14/2026,1 x Muffin,30.00'], DATE_ONLY))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/row 2 reads 13\/09\/2026 and row 3 reads 09\/14\/2026/) });
  });

  it('marks a date-only export as having no time of day', async () => {
    // UAT-00 F28 date-only.csv
    const result = await parse(['Date,Items,Total', '2026-09-14,1 x Latte,38.00'], DATE_ONLY);
    expect(result.rows[0]).toMatchObject({ hourKnown: false, hour: null, dateKey: '2026-09-14' });
  });

  it('never builds a date from a string with new Date', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'parser', 'dates.js'), 'utf8');
    expect(source).not.toMatch(/new Date\((value|dateStr|dateValue|datePart|timeStr|timeValue|String\()/);
  });
});
