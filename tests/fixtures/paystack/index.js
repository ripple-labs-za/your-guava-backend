const verifySuccess = require('./verify-success.json');

const clone = (value) => JSON.parse(JSON.stringify(value));

const GATEWAY_RESPONSES = {
  success: 'Successful',
  failed: 'Declined',
  reversed: 'Reversed',
};

/**
 * A Paystack verify body built from the recorded success response. `status` is any Paystack transaction status:
 * success, failed, abandoned, ongoing, pending, processing, queued, reversed.
 */
const verifyResponse = (status, { reference, amountRand, requestedRand, currency, id } = {}) => {
  const body = clone(verifySuccess);
  body.data.status = status;
  body.data.gateway_response = GATEWAY_RESPONSES[status] || 'The transaction was not completed';
  if (status !== 'success') body.data.paid_at = null;
  if (reference) {
    body.data.reference = reference;
    // A real recording (BE-07-T06) may carry metadata as a string or omit it.
    if (body.data.metadata && typeof body.data.metadata === 'object') body.data.metadata.merchant_reference = reference;
  }
  if (amountRand != null) {
    body.data.amount = Math.round(amountRand * 100);
    body.data.requested_amount = Math.round(amountRand * 100);
  }
  if (requestedRand != null) body.data.requested_amount = Math.round(requestedRand * 100);
  if (currency != null) body.data.currency = currency;
  if (id != null) body.data.id = id;
  return body;
};

const WEBHOOKS = {
  'charge.success': require('./webhook-charge-success.json'),
  'refund.processed': require('./webhook-refund-processed.json'),
  'charge.dispute.create': require('./webhook-dispute-create.json'),
};

/** A recorded webhook body with this test's reference and amount written into every place Paystack puts them. */
const webhookEvent = (event, { reference, amountRand } = {}) => {
  const body = clone(WEBHOOKS[event]);
  if (reference) {
    if ('reference' in body.data) body.data.reference = reference;
    if ('transaction_reference' in body.data) body.data.transaction_reference = reference;
    if (body.data.transaction) body.data.transaction.reference = reference;
    if (body.data.metadata) body.data.metadata.merchant_reference = reference;
  }
  if (amountRand != null) {
    body.data.amount = Math.round(amountRand * 100);
    if ('requested_amount' in body.data) body.data.requested_amount = body.data.amount;
    if (body.data.transaction) body.data.transaction.amount = body.data.amount;
  }
  return body;
};

module.exports = { clone, verifyResponse, webhookEvent };
