// BE-03-T09 review focus: the edges of receipt line grouping and of the outlier-date window.
const { groupLinePerRow, parseBuffer } = require('../../src/services/parser.service');

const ZONE = 'Africa/Johannesburg';
const LF = String.fromCharCode(10);
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Item', quantity: 'Qty', total: 'Total' };
const line = (receipt, date, time, item, total) => ({ Receipt: receipt, Date: date, Time: time, Item: item, Qty: '1', Total: total });

describe('how far apart the lines of one receipt may be', () => {
  it('groups lines 4 minutes 59 seconds apart', () => {
    const result = groupLinePerRow([
      line('R1', '2026-09-01', '09:00:00', 'Latte', '38.00'),
      line('R1', '2026-09-01', '09:04:59', 'Muffin', '30.00'),
    ], MAPPING, ZONE);
    expect(result.errors).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].total).toBe(68);
  });

  it('refuses lines 5 minutes 1 second apart as two sales under one number', () => {
    const result = groupLinePerRow([
      line('R1', '2026-09-01', '09:00:00', 'Latte', '38.00'),
      line('R1', '2026-09-01', '09:05:01', 'Muffin', '30.00'),
    ], MAPPING, ZONE);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toBe(2);
    expect(result.rowErrors[0].reason).toMatch(/conflicting date/i);
  });

  it('holds the whole receipt to five minutes whatever order its lines arrive in', () => {
    const at = (time, item) => line('R2', '2026-09-01', time, item, '10.00');
    const orders = [
      [at('09:04', 'A'), at('09:00', 'B'), at('09:08', 'C')],
      [at('09:08', 'C'), at('09:04', 'A'), at('09:00', 'B')],
      [at('09:04', 'A'), at('09:08', 'C'), at('09:00', 'B')],
    ];
    for (const rows of orders) {
      const result = groupLinePerRow(rows, MAPPING, ZONE);
      expect(result.rows).toHaveLength(0);
      expect(result.errors).toBe(3);
    }
  });

  it('keeps a receipt that crosses cafe-local midnight as one sale per trading day', () => {
    const result = groupLinePerRow([
      line('R3', '2026-09-01', '23:59:58', 'Latte', '38.00'),
      line('R3', '2026-09-02', '00:00:03', 'Muffin', '30.00'),
    ], MAPPING, ZONE);
    expect(result.errors).toBe(0);
    expect(result.rows.map((row) => row.dateKey)).toEqual(['2026-09-01', '2026-09-02']);
  });
});

describe('which evidence settled the totals mode', () => {
  it('reports that the data decided when a receipt has differing line amounts', () => {
    const result = groupLinePerRow([
      line('R4', '2026-09-01', '09:00', 'Latte', '38.00'),
      line('R4', '2026-09-01', '09:00', 'Muffin', '30.00'),
    ], MAPPING, ZONE);
    expect(result.totalsAreLineAmounts).toBe(true);
    expect(result.totalsEvidence).toEqual({ identical: 0, differing: 1, decidedBy: 'data' });
  });

  it('reports that the header decided when no receipt has two lines', () => {
    const result = groupLinePerRow([line('R5', '2026-09-01', '09:00', 'Latte', '38.00')], MAPPING, ZONE);
    expect(result.totalsEvidence).toEqual({ identical: 0, differing: 0, decidedBy: 'header' });
  });

  it('refuses a receipt in a line-amount file that leaves a line without an amount, counting all its rows', () => {
    const differing = [1, 2, 3, 4, 5].flatMap((i) => [
      line(`D${i}`, '2026-09-01', `09:0${i}`, 'Latte', '38.00'), line(`D${i}`, '2026-09-01', `09:0${i}`, 'Muffin', `${20 + i}.00`),
    ]);
    const result = groupLinePerRow([
      ...differing,
      line('B1', '2026-09-01', '09:20', 'Latte', '38.00'), line('B1', '2026-09-01', '09:20', 'Muffin', ''),
    ], MAPPING, ZONE);
    expect(result.totalsAreLineAmounts).toBe(true);
    expect(result.rows.map((row) => row.receiptId)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    expect(result.errors).toBe(2);
    expect(result.rowErrors).toEqual([expect.objectContaining({
      rowNumber: 13,
      reason: 'Receipt B1 has a line with no amount (row 13). In a file of line amounts every line needs one.',
    })]);
  });

  // Review of BE-03-T09: one mistyped receipt among a few repeated totals is not line evidence. Read as line amounts,
  // the good receipts were summed to double their sale with no row error; left to the header, only the mistyped one
  // is refused, visibly.
  it('does not let one mistyped receipt turn a small receipt-total file into line amounts', () => {
    const result = groupLinePerRow([
      line('R1', '2026-09-01', '09:00', 'Latte', '68.00'), line('R1', '2026-09-01', '09:00', 'Muffin', '68.00'),
      line('R2', '2026-09-01', '09:10', 'Latte', '68.00'), line('R2', '2026-09-01', '09:10', 'Muffin', '68.00'),
      line('R3', '2026-09-01', '09:20', 'Latte', '45.00'), line('R3', '2026-09-01', '09:20', 'Muffin', '45.50'),
    ], MAPPING, ZONE);
    expect(result.totalsEvidence).toEqual({ identical: 2, differing: 1, decidedBy: 'header' });
    expect(result.rows.map((row) => row.total)).toEqual([68, 68]);
    expect(result.errors).toBe(2);
  });

  it('keeps a small receipt-total file whose continuation lines leave the amount blank', () => {
    const result = groupLinePerRow([
      line('T0', '2026-09-01', '09:00', 'Latte', '68.00'), line('T0', '2026-09-01', '09:00', 'Muffin', ''),
      line('T1', '2026-09-01', '09:10', 'Latte', '70.00'), line('T1', '2026-09-01', '09:10', 'Muffin', ''),
      line('X', '2026-09-01', '09:20', 'Latte', '45.00'), line('X', '2026-09-01', '09:20', 'Muffin', '45.50'),
    ], MAPPING, ZONE);
    expect(result.totalsAreLineAmounts).toBe(false);
    expect(result.rows.map((row) => [row.receiptId, row.total])).toEqual([['T0', 68], ['T1', 70]]);
  });
});

describe('the outlier-date window at its edges', () => {
  const PACKED = { date: 'Date', items: 'Items', total: 'Total' };
  const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')},1 x Latte,38.00`);
  const parsePacked = (lines) => parseBuffer(Buffer.from(['Date,Items,Total', ...lines].join(LF)), { columnMapping: PACKED, itemsMode: 'packed' });

  it('still refuses a file with more than 5% outliers and names its two furthest-apart rows', async () => {
    const lines = [...days, '2000-01-01,1 x Latte,38.00', '2000-01-02,1 x Latte,38.00'];
    await expect(parsePacked(lines)).rejects.toThrow(
      /day limit\. Rows 32 \(2000-01-01\) and 31 \(2026-09-30\) are the furthest apart; export a shorter period\./
    );
  });

  it('refuses two equal clusters rather than guessing which one is right', async () => {
    const early = Array.from({ length: 10 }, (_, i) => `2020-01-${String(i + 1).padStart(2, '0')},1 x Latte,38.00`);
    await expect(parsePacked([...early, ...days.slice(0, 10)])).rejects.toThrow(/date range exceeds/i);
  });

  it('leaves a file inside the limit untouched', async () => {
    const result = await parsePacked(days);
    expect(result.errors).toBe(0);
    expect(result.rows).toHaveLength(30);
  });

  // Review of BE-03-T09: netting ran first, so the refund was counted once as netted and again as an outlier row.
  it('counts a refund dated far outside the file once, as an outlier, not also as netted', async () => {
    const sales = Array.from({ length: 40 }, (_, i) => `S${i},2026-09-${String((i % 30) + 1).padStart(2, '0')},09:00,Approved,1 x Latte,38.00`);
    const outliers = ['X1,2000-01-01,09:00,Partially Refunded,"1 x Latte, 2 x Muffin",98.00', 'X1,2000-01-01,09:05,Refunded,1 x Latte,-38.00'];
    const result = await parseBuffer(Buffer.from(['Receipt,Date,Time,Status,Items,Total', ...sales, ...outliers].join(LF)), {
      columnMapping: { receiptId: 'Receipt', date: 'Date', time: 'Time', status: 'Status', items: 'Items', total: 'Total' },
      itemsMode: 'packed',
    });
    expect({ rows: result.rows.length, errors: result.errors, netted: result.nettedRefundRows }).toEqual({ rows: 40, errors: 2, netted: 0 });
    expect(result.rows.length + result.errors + result.nettedRefundRows).toBe(result.totalRows);
  });

  it('counts every row of a line-per-row receipt dated far outside the file', async () => {
    const receipts = Array.from({ length: 30 }, (_, i) => `S${i},2026-09-${String(i + 1).padStart(2, '0')},09:00,Latte,1,38.00`);
    const outlier = ['X1,2000-01-01,09:00,Latte,1,38.00', 'X1,2000-01-01,09:00,Muffin,1,30.00', 'X1,2000-01-01,09:00,Water,1,20.00'];
    const result = await parseBuffer(Buffer.from(['Receipt,Date,Time,Item,Qty,Total', ...receipts, ...outlier].join(LF)), {
      columnMapping: MAPPING, itemsMode: 'line-per-row',
    });
    expect(result.rows).toHaveLength(30);
    expect(result.errors).toBe(3);
    expect(result.rowErrors).toEqual([expect.objectContaining({
      rowNumber: 32,
      reason: expect.stringMatching(/^Date 2000-01-01 is far outside the rest of this file \(2026-09-01 to 2026-09-30\)/),
    })]);
  });
});
