const { receiptIdError } = require('../../src/services/parser/rowErrors');
const { receiptSignature } = require('../../src/services/transactionIdentity');

const ZONE = 'Africa/Johannesburg';
const LIMITS = { maxIdentifierChars: 128 };
const sale = (overrides = {}) => ({
  date: new Date('2026-09-14T07:00:00.000Z'), // 09:00 in Johannesburg
  total: 38,
  tip: 0,
  discount: 0,
  items: [{ salesItemId: 'item-flat-white', name: 'Flat White', quantity: 1 }],
  ...overrides,
});

describe('receipt numbers Excel shortened', () => {
  it('refuses scientific notation in either case and with a comma decimal', () => {
    for (const id of ['2.02609E+16', '2.02609e16', '2,02609E+16', '1E5']) {
      expect(receiptIdError(id, LIMITS)).toMatch(/scientific notation/);
    }
  });

  it('leaves real receipt numbers alone', () => {
    for (const id of ['E-1001', '1E', 'INV-2E5', '20260914000123', '0001', 'A1E2']) {
      expect(receiptIdError(id, LIMITS)).toBeNull();
    }
  });
});

describe('receipt content', () => {
  it('judges a sale to the minute, so an export with seconds matches one without', () => {
    const withSeconds = sale({ date: new Date('2026-09-14T07:00:05.000Z') });
    expect(receiptSignature(withSeconds, ZONE)).toBe(receiptSignature(sale(), ZONE));
  });

  it('ignores how the sale was paid, so a card/cash difference alone is the same sale', () => {
    expect(receiptSignature(sale({ paymentMethod: 'Cash' }), ZONE)).toBe(receiptSignature(sale({ paymentMethod: 'Card' }), ZONE));
  });

  it('tells apart baskets with the same money by the items in them', () => {
    const latte = sale({ items: [{ salesItemId: 'item-latte', name: 'Latte', quantity: 1 }] });
    expect(receiptSignature(latte, ZONE)).not.toBe(receiptSignature(sale(), ZONE));
  });

  it('keeps a renamed line the same sale while its menu item id holds', () => {
    const renamed = sale({ items: [{ salesItemId: 'item-flat-white', name: 'Flat white (regular)', quantity: 1 }] });
    expect(receiptSignature(renamed, ZONE)).toBe(receiptSignature(sale(), ZONE));
  });
});
