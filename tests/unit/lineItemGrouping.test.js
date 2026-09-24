const { groupLinePerRow, parseBuffer } = require('../../src/services/parser.service');

const ZONE = 'Africa/Johannesburg';
const LF = String.fromCharCode(10);
const MAPPING = {
  receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Item', quantity: 'Qty', total: 'Total',
  tip: 'Tip', discount: 'Discount', paymentMethod: 'Payment', status: 'Status',
};
const line = (receipt, time, item, total, extra = {}) => ({
  Receipt: receipt, Date: '2026-09-01', Time: time, Item: item, Qty: '1', Total: total,
  Tip: '', Discount: '', Payment: '', Status: '', ...extra,
});

describe('receipts whose later lines leave receipt-level cells blank', () => {
  it('inherits payment, status and tip from the first line instead of dropping the receipt', () => {
    const result = groupLinePerRow([
      line('R1', '09:30', 'Flat White', '38.00', { Payment: 'Card', Status: 'Approved', Tip: '5.00' }),
      line('R1', '09:30', 'Muffin', '30.00'),
      line('R1', '09:30', 'Water', '20.00'),
    ], MAPPING, ZONE);
    expect(result.errors).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ paymentMethod: 'Card', status: 'approved', tip: 5 });
    expect(result.rows[0].items.map((item) => item.name)).toEqual(['Flat White', 'Muffin', 'Water']);
  });

  it('takes a payment method that only a later line states', () => {
    const result = groupLinePerRow([
      line('R2', '10:00', 'Latte', '38.00'),
      line('R2', '10:00', 'Scone', '28.00', { Payment: 'Cash' }),
    ], MAPPING, ZONE);
    expect(result.rows[0].paymentMethod).toBe('Cash');
  });

  it('groups lines stamped seconds apart and dates the sale at its first line', () => {
    const result = groupLinePerRow([
      line('R3', '09:30:01', 'Flat White', '38.00'),
      line('R3', '09:30:05', 'Muffin', '30.00'),
      line('R3', '09:31:40', 'Water', '20.00'),
    ], MAPPING, ZONE);
    expect(result.errors).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].date.toISOString()).toBe('2026-09-01T07:30:01.000Z');
  });

  it('sums a discount given on individual lines', () => {
    const result = groupLinePerRow([
      line('R4', '11:00', 'Muffin', '30.00', { Discount: '5.00' }),
      line('R4', '11:00', 'Latte', '38.00', { Discount: '3.00' }),
      line('R4', '11:00', 'Water', '20.00'),
    ], MAPPING, ZONE);
    expect(result.rows[0].discount).toBe(8);
  });

  it('still refuses two different stated payment methods on one receipt', () => {
    const result = groupLinePerRow([
      line('R5', '12:00', 'Latte', '38.00', { Payment: 'Card' }),
      line('R5', '12:00', 'Muffin', '30.00', { Payment: 'Cash' }),
    ], MAPPING, ZONE);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toBe(2);
  });
});

describe('every row of a dropped receipt is counted', () => {
  it('counts a row that arrives after its receipt was already dropped', () => {
    const result = groupLinePerRow([
      line('R6', '12:00', 'A', '10.00', { Payment: 'Card' }),
      line('R6', '12:00', 'B', '10.00', { Payment: 'Cash' }),
      line('R6', '12:00', 'C', '10.00', { Payment: 'Card' }),
    ], MAPPING, ZONE);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toBe(3);
    expect(result.rowErrors.map((error) => error.rowNumber)).toEqual(expect.arrayContaining([4]));
  });
});

describe('line amounts versus a repeated receipt total', () => {
  const PLAIN = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Item', quantity: 'Qty', total: 'Amount' };
  const parseLines = (lines) => parseBuffer(Buffer.from(['Receipt,Date,Time,Item,Qty,Amount', ...lines].join(LF)), {
    columnMapping: PLAIN, itemsMode: 'line-per-row',
  });
  const sameTwice = (i) => [`S${i},2026-09-01,09:00,Flat White,1,38.00`, `S${i},2026-09-01,09:00,Cappuccino,1,38.00`];
  const different = (i) => [`D${i},2026-09-01,10:00,Flat White,1,38.00`, `D${i},2026-09-01,10:00,Muffin,1,${(25 + i).toFixed(2)}`];

  it('reads a file where 70% of receipts differ as line amounts even under a plain "Amount" header', async () => {
    const lines = [...[0, 1, 2].flatMap(sameTwice), ...[0, 1, 2, 3, 4, 5, 6].flatMap(different)];
    const result = await parseLines(lines);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(10);
    expect(result.rows.find((row) => row.receiptId === 'S0').total).toBe(76);
  });

  it('accepts a blank amount on a continuation line of a receipt-total file', async () => {
    const lines = [0, 1, 2, 3, 4].flatMap((i) => [`T${i},2026-09-01,09:00,Flat White,1,${(60 + i).toFixed(2)}`, `T${i},2026-09-01,09:00,Muffin,1,`]);
    const result = await parseLines(lines);
    expect(result.errors).toBe(0);
    expect(result.rows.map((row) => row.total)).toEqual([60, 61, 62, 63, 64]);
  });
});

describe('dates far outside the rest of the file', () => {
  const PACKED = { date: 'Date', items: 'Items', total: 'Total' };
  const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')},1 x Latte,38.00`);

  it('makes one till-reset date a row error instead of refusing the file', async () => {
    const lines = [...days.slice(0, 10), '2000-01-01,1 x Latte,38.00', ...days.slice(10)];
    const result = await parseBuffer(Buffer.from(['Date,Items,Total', ...lines].join(LF)), { columnMapping: PACKED, itemsMode: 'packed' });
    expect(result.rows).toHaveLength(30);
    expect(result.errors).toBe(1);
    expect(result.rowErrors).toEqual([expect.objectContaining({
      rowNumber: 12,
      reason: expect.stringMatching(/^Date 2000-01-01 is far outside the rest of this file \(2026-09-01 to 2026-09-30\)/),
    })]);
    expect(result.dateRange.firstDate.toISOString().slice(0, 10)).toBe('2026-08-31');
  });

  it('still refuses a file that genuinely spans more than the limit', async () => {
    const previous = process.env.UPLOAD_MAX_DATE_RANGE_DAYS;
    process.env.UPLOAD_MAX_DATE_RANGE_DAYS = '10';
    try {
      await expect(parseBuffer(Buffer.from(['Date,Items,Total', ...days].join(LF)), { columnMapping: PACKED, itemsMode: 'packed' }))
        .rejects.toThrow(/date range exceeds the 10 day limit/i);
    } finally {
      if (previous == null) delete process.env.UPLOAD_MAX_DATE_RANGE_DAYS; else process.env.UPLOAD_MAX_DATE_RANGE_DAYS = previous;
    }
  });
});
