const { parseBuffer } = require('../../src/services/parser.service');
const { sanitizeRowErrors } = require('../../src/controllers/uploads/shared');

describe('bounded source date on an outlier rejection', () => {
  it.each(['packed', 'line-per-row'])('retains only the original mapped date for %s rows', async (itemsMode) => {
    const product = itemsMode === 'packed' ? '1 x Latte' : 'Latte';
    const rows = Array.from({ length: 30 }, (_, i) => `R${i},2026/09/${String(i + 1).padStart(2, '0')},${product},1,38,private-${i}`);
    rows.splice(16, 0, `SECRET-RECEIPT,2000/01/01,${product},1,38,private-outlier`);
    const parsed = await parseBuffer(Buffer.from(['Receipt,When,Product,Qty,Amount,Private', ...rows].join('\n')), {
      itemsMode, columnMapping: { receiptId: 'Receipt', date: 'When', items: 'Product', quantity: 'Qty', total: 'Amount' },
    });
    expect(parsed.rows).toHaveLength(30);
    expect(parsed.errors).toBe(1);
    expect(parsed.rowErrors[0]).toEqual(expect.objectContaining({ rowNumber: 18, raw: { date: '2000/01/01' } }));
    expect(sanitizeRowErrors(parsed.rowErrors)[0]).toEqual(expect.objectContaining({ rowNumber: 18, raw: { date: '2000/01/01' } }));
    expect(JSON.stringify(parsed.rowErrors)).not.toMatch(/SECRET-RECEIPT|private-outlier|Amount|Product/);
  });

  it('caps the source date and omits every other raw field at the upload boundary', () => {
    const [error] = sanitizeRowErrors([{ rowNumber: 2,
      reason: 'Date 2000-01-01 is far outside the rest of this file (2026-09-01 to 2026-09-30). Check the till clock.',
      raw: { date: 'x'.repeat(1000), receiptId: 'private', total: '100', Private: 'secret' },
    }]);
    expect(error.raw).toEqual({ date: 'x'.repeat(160) });
  });

  it('continues stripping raw data from other rejection reasons and non-string date values', () => {
    const errors = sanitizeRowErrors([
      { rowNumber: 2, reason: 'Could not parse row', raw: { date: 'secret', Other: 'private' } },
      { rowNumber: 3, reason: 'Date 2000-01-01 is far outside the rest of this file (2026-09-01 to 2026-09-30).', raw: { date: { private: true } } },
    ]);
    for (const error of errors) expect(error).not.toHaveProperty('raw');
  });
});
