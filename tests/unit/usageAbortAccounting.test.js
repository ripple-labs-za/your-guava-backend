const mongoose = require('mongoose');
const Organization = require('../../src/models/Organization.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const { refundAndFinishUsage } = require('../../src/services/usage/ledger');

afterEach(() => jest.restoreAllMocks());

const input = (diagnostics) => ({
  ledger: { _id: 'ledger', replayCount: 2 }, orgId: 'org', credits: 1, providerDiagnostics: diagnostics,
});
const mockTransaction = () => {
  jest.spyOn(mongoose, 'startSession').mockResolvedValue({
    withTransaction: async (run) => run(), endSession: jest.fn(),
  });
  return jest.spyOn(Organization, 'findOneAndUpdate').mockResolvedValue({});
};

it('counts a dispatched request with no token counts while refunding its customer', async () => {
  const refund = mockTransaction();
  const update = jest.spyOn(UsageLedger, 'updateOne').mockImplementation(async (filter) => ({
    matchedCount: filter.status === 'reserved' ? 1 : 0,
  }));
  await refundAndFinishUsage(input({ operation: 'menu_item_ai_review', providerRequestSent: true }));
  expect(refund).toHaveBeenCalledTimes(1);
  const settlement = update.mock.calls.find(([filter]) => filter.status === 'reserved');
  expect(settlement[0]).toMatchObject({ _id: 'ledger', replayCount: 2 });
  expect(settlement[1]).toMatchObject({
    $set: { status: 'refunded', providerDiagnostics: { providerRequestSent: true } },
    $inc: { providerConsumedRuns: 1 },
  });
});

it('records a dispatched request after a stale refund without refunding twice', async () => {
  const refund = mockTransaction();
  const update = jest.spyOn(UsageLedger, 'updateOne').mockResolvedValue({ matchedCount: 1 });
  await refundAndFinishUsage(input({ providerRequestSent: true }));
  expect(refund).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'refunded', recoveryReason: 'stale_reservation', replayCount: 2 }),
    expect.objectContaining({ $inc: { providerConsumedRuns: 1 } })
  );
});

it('does not count an attempt that never dispatched a request', async () => {
  mockTransaction();
  const update = jest.spyOn(UsageLedger, 'updateOne').mockResolvedValue({ matchedCount: 1 });
  await refundAndFinishUsage(input({ providerRequestSent: false, inputTokens: 0, outputTokens: 0 }));
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][1].$inc).toBeUndefined();
});
