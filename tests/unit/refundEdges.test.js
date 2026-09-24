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
      'Receipt R51 is marked Partially Refunded, but the file has no refund row for it, so its full R100.00 was imported.',
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

  it('nets a refund larger than the sale but says so, never silently', async () => {
    const result = await packed([
      'R53,2026-09-14,09:00,Partially Refunded,"1 x Latte, 1 x Muffin",68.00',
      'R53,2026-09-14,09:40,Refunded,"-1 x Latte, -1 x Muffin, -1 x Scone",-80.00',
    ]);
    expect(result.rows[0].total).toBe(-12);
    expect(result.rowErrors.map((error) => error.reason)).toEqual([
      'Receipt R53 refunds R80.00, more than its sale of R68.00, so it was imported at -R12.00. Check the till for a refund '
      + 'recorded against the wrong receipt.',
    ]);
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
