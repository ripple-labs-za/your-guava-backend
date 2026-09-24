const { parseBuffer } = require('../../src/services/parser.service');
const { inferDecimalMark } = require('../../src/services/parser/numbers');

const ZONE = 'Africa/Johannesburg';
const LF = String.fromCharCode(10);
const PACKED = { receiptId: 'Receipt', date: 'Date', time: 'Time', status: 'Status', items: 'Items', total: 'Total' };
const packed = (lines) => parseBuffer(
  Buffer.from(['Receipt,Date,Time,Status,Items,Total', ...lines].join(LF)),
  { columnMapping: PACKED, itemsMode: 'packed', timezone: ZONE }
);

describe('refund edges the plan names (BE-03-T07 review focus)', () => {
  it('keeps a fully refunded line-per-row receipt at total 0 with neither line exact', async () => {
    const result = await parseBuffer(
      Buffer.from(['Receipt,Date,Item,Qty,Line Total', 'R40,2026-09-14,Latte,1,38.00', 'R40,2026-09-14,Latte,-1,-38.00'].join(LF)),
      {
        columnMapping: { receiptId: 'Receipt', date: 'Date', items: 'Item', quantity: 'Qty', total: 'Line Total' },
        itemsMode: 'line-per-row',
        timezone: ZONE,
      }
    );
    const [r40] = result.rows;
    expect(r40.total).toBe(0);
    expect(r40.items.map((item) => [item.quantity, item.unitPrice, item.priceSource]))
      .toEqual([[1, 38, 'exact'], [-1, 38, 'derived']]);
  });

  it('nets two refund rows into one partially refunded sale', async () => {
    const result = await packed([
      'R50,2026-09-14,09:00,Partially Refunded,"1 x Latte, 2 x Muffin",98.00',
      'R50,2026-09-14,09:30,Refunded,-1 x Muffin,-30.00',
      'R50,2026-09-14,10:00,Refunded,-1 x Muffin,-30.00',
    ]);
    expect(result.nettedRefundRows).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].total).toBe(38);
    expect(result.rowErrors).toEqual([]);
  });

  it('leaves a refund row on the next day alone, and says the sale had no refund row that day', async () => {
    const result = await packed([
      'R51,2026-09-14,09:00,Partially Refunded,1 x Cake,100.00',
      'R51,2026-09-15,09:00,Refunded,-1 x Cake,-20.00',
    ]);
    expect(result.nettedRefundRows).toBe(0);
    expect(result.rows.map((row) => [row.total, row.status])).toEqual([[100, 'partially refunded'], [-20, 'refunded']]);
    expect(result.rowErrors.map((error) => error.reason)).toEqual([
      'Receipt R51 is marked Partially Refunded, but its refund row is dated another day, so it was not netted and its full '
      + 'R100.00 was imported.',
    ]);
  });

  it('leaves a refund row with no receipt number alone', async () => {
    const result = await packed([
      'R52,2026-09-14,09:00,Partially Refunded,1 x Cake,100.00',
      ',2026-09-14,09:30,Refunded,-1 x Cake,-20.00',
    ]);
    expect(result.nettedRefundRows).toBe(0);
    expect(result.rows).toHaveLength(2);
  });

  it('does not net a refund larger than its sale: the sale imports in full and the notice names both amounts', async () => {
    const result = await packed([
      'R53,2026-09-14,09:00,Partially Refunded,"1 x Latte, 1 x Muffin",68.00',
      'R53,2026-09-14,09:40,Refunded,"-1 x Latte, -1 x Muffin, -1 x Scone",-80.00',
    ]);
    expect(result.nettedRefundRows).toBe(0);
    expect(result.rows.map((row) => row.total)).toEqual([68, -80]); // the refund row is skipped later by its status
    expect(result.rowErrors.map((error) => error.reason)).toEqual([
      'Receipt R53 refunds R80.00, more than its sale of R68.00, so the two were not netted and the sale was imported at its '
      + 'full R68.00. Check the till for a refund recorded against the wrong receipt.',
    ]);
  });
});

describe('second review of BE-03-T07', () => {
  const linePerRow = (lines, header = 'Receipt,Date,Item,Qty,Line Total,Status') => parseBuffer(
    Buffer.from([header, ...lines].join(LF)),
    {
      columnMapping: { receiptId: 'Receipt', date: 'Date', items: 'Item', quantity: 'Qty', total: 'Line Total', status: 'Status' },
      itemsMode: 'line-per-row',
      timezone: ZONE,
    }
  );

  it('keeps a discount line negative, so item revenue still adds up to the receipt', async () => {
    const result = await linePerRow(['R60,2026-09-14,Latte,1,38.00,Completed', 'R60,2026-09-14,Discount,1,-10.00,Completed']);
    const [r60] = result.rows;
    expect(r60.total).toBe(28);
    expect(r60.items.map((item) => [item.name, item.quantity, item.unitPrice, item.priceSource]))
      .toEqual([['Latte', 1, 38, 'exact'], ['Discount', 1, -10, 'derived']]);
    expect(r60.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)).toBe(28);
  });

  it('never learns a comped R0.00 line as a price', async () => {
    const result = await linePerRow(['R61,2026-09-14,Latte,1,38.00,Completed', 'R61,2026-09-14,Staff Coffee,1,0.00,Completed']);
    expect(result.rows[0].items.find((item) => item.name === 'Staff Coffee').priceSource).toBe('derived');
  });

  it('says so when a line-per-row receipt is marked partially refunded but carries no refund line', async () => {
    const result = await linePerRow(['O1,2026-09-14,Cake,1,100.00,Partially refunded']);
    expect(result.rows[0].total).toBe(100);
    expect(result.rowErrors.map((error) => error.reason)).toEqual([
      'Receipt O1 is marked Partially Refunded, but the file has no refund line for it, so its full R100.00 was imported.',
    ]);
  });

  it('says so when a partially refunded sale has no receipt number to match a refund to', async () => {
    const result = await packed([',2026-09-14,09:00,Partially Refunded,1 x Cake,100.00']);
    expect(result.rows[0].total).toBe(100);
    expect(result.rowErrors.map((error) => error.reason)).toEqual([
      'Row 2 is marked Partially Refunded but has no receipt number to match a refund row to, so its full R100.00 was imported.',
    ]);
  });

  it('does not net refunds when one receipt number carries two partially refunded sales that day', async () => {
    const result = await packed([
      '0001,2026-09-14,09:00,Partially Refunded,1 x Cake,100.00',
      '0001,2026-09-14,09:10,Refunded,-1 x Cake,-20.00',
      '0001,2026-09-14,14:00,Partially Refunded,1 x Pie,60.00',
      '0001,2026-09-14,14:10,Refunded,-1 x Pie,-10.00',
    ]);
    expect(result.nettedRefundRows).toBe(0);
    expect(result.rows.map((row) => row.total)).toEqual([100, -20, 60, -10]);
    const reason = 'Receipt 0001 is marked Partially Refunded on more than one sale that day, so its refund rows could not be '
      + 'matched to one sale; each was imported at its full amount.';
    expect(result.rowErrors.map((error) => error.reason)).toEqual([reason, reason]);
  });
});

describe('inferDecimalMark on awkward columns', () => {
  it('reads a column mixing whole numbers and 0,5 as decimal commas', () => {
    expect(inferDecimalMark(['2', '0,5', '3'])).toBe(',');
  });

  it('has no opinion on spreadsheet numbers', () => {
    expect(inferDecimalMark([0.35, 2, 1250])).toBeNull();
  });

  it('gives up on a contradictory column without throwing', () => {
    expect(inferDecimalMark(['0,350', '0.350'])).toBeNull();
    expect(inferDecimalMark(['1,250', '1.250'])).toBeNull();
  });

  it('settles an undecided column by the file separator', () => {
    expect(inferDecimalMark(['1,250'], { csvSeparator: ';' })).toBe(',');
    expect(inferDecimalMark(['1,250'], { csvSeparator: ',' })).toBeNull();
  });
});
