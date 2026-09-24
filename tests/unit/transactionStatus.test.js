const {
  normaliseTransactionStatus,
  SKIP_REASON_STATUS,
} = require('../../src/utils/transactionStatus');

describe('normaliseTransactionStatus', () => {
  it.each([
    ['Approved'], ['approved'], ['APPROVED'], [' Approved '],
    ['Completed'], ['complete'], ['COMPLETE'],
    ['Paid'], ['Successful'], ['Success'], ['Settled'],
    [undefined], [null], [''], ['   '],
  ])('treats %p as an approved sale', (raw) => {
    expect(normaliseTransactionStatus(raw)).toEqual({ status: 'approved', recognised: true });
  });

  it.each([
    ['Declined'], ['declined'], ['Refunded'], ['Refund'],
    ['Failed'], ['Void'], ['Voided'], ['Cancelled'], ['Canceled'], ['Reversed'],
  ])('treats %p as declined', (raw) => {
    expect(normaliseTransactionStatus(raw)).toEqual({ status: 'declined', recognised: true });
  });

  it('flags an unknown status as unrecognised, and declines it rather than guessing', () => {
    expect(normaliseTransactionStatus('Banana')).toEqual({ status: 'declined', recognised: false });
  });

  it('exports a stable skip-reason key for the stats breakdown', () => {
    expect(SKIP_REASON_STATUS).toBe('status_not_approved');
  });

  it.each([['Partially Refunded'], ['partially refunded'], ['Partial Refund'], ['Partly refunded']])(
    'keeps %p as a sale the customer partly kept',
    (raw) => {
      expect(normaliseTransactionStatus(raw)).toEqual({ status: 'approved', recognised: true, partialRefund: true });
    }
  );

  it('recognises a refund row, which is not a partial refund', () => {
    const { isRefundStatus } = require('../../src/utils/transactionStatus');
    expect(isRefundStatus('Refunded')).toBe(true);
    expect(isRefundStatus(' refund ')).toBe(true);
    expect(isRefundStatus('Partially Refunded')).toBe(false);
  });
});
