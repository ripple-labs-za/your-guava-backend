const { contentSignature, contentKey } = require('../../src/services/transactionIdentity');

const ZONE = 'Africa/Johannesburg';
const sale = (overrides = {}) => ({
  date: new Date('2026-09-10T07:10:00.000Z'), // 09:10 in Johannesburg
  total: 38,
  tip: 0,
  discount: 0,
  items: [{ name: 'Flat White', quantity: 1 }],
  ...overrides,
});

describe('content identity for receipt-less sales', () => {
  it('reads the sale in the cafe zone, to the minute, with money to the cent', () => {
    expect(contentSignature(sale(), ZONE)).toBe('2026-09-10|09:10|38.00|0.00|0.00|1|1');
  });

  it('does not change when a menu correction renames the stored line', () => {
    const renamed = sale({ items: [{ name: 'Flat White (merged into Flat white)', quantity: 1 }] });
    expect(contentSignature(renamed, ZONE)).toBe(contentSignature(sale(), ZONE));
  });

  it('tells apart sales that differ in money, minute or basket shape', () => {
    const base = contentSignature(sale(), ZONE);
    expect(contentSignature(sale({ total: 38.5 }), ZONE)).not.toBe(base);
    expect(contentSignature(sale({ date: new Date('2026-09-10T07:11:00.000Z') }), ZONE)).not.toBe(base);
    expect(contentSignature(sale({ items: [{ name: 'Flat White', quantity: 2 }] }), ZONE)).not.toBe(base);
    expect(contentSignature(sale({ tip: 5 }), ZONE)).not.toBe(base);
  });

  it('gives each occurrence of one sale its own key', () => {
    const signature = contentSignature(sale(), ZONE);
    expect(contentKey(signature, 1)).toMatch(/^[a-f0-9]{64}$/);
    expect(contentKey(signature, 1)).not.toBe(contentKey(signature, 2));
    expect(contentKey(signature, 2)).toBe(contentKey(signature, 2));
  });
});
