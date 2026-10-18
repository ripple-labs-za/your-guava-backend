/**
 * Re-export barrel (BE-11-T04). Billing access and the AI safety policy live in
 * ./usage/policy.js, credit arithmetic in ./usage/credits.js, the ledger and its
 * sweeper in ./usage/ledger.js, metering in ./usage/meter.js. Four test files mock
 * this path, so code outside ./usage imports only this file.
 */
const policy = require('./usage/policy');
const credits = require('./usage/credits');
const ledger = require('./usage/ledger');
const meter = require('./usage/meter');

module.exports = {
  FEATURE_COSTS: meter.FEATURE_COSTS,
  billingAccessForOrganization: policy.billingAccessForOrganization,
  billingGraceDays: policy.billingGraceDays,
  billingRequiredError: policy.billingRequiredError,
  bonusUsedForCredits: credits.bonusUsedForCredits,
  consumeGuavaCredits: meter.consumeGuavaCredits,
  creditSnapshot: credits.creditSnapshot,
  ensureFreshCreditWindow: credits.ensureFreshCreditWindow,
  meterGuavaCredits: meter.meterGuavaCredits,
  reconcileStaleUsageReservations: ledger.reconcileStaleUsageReservations,
  refreshCreditWindow: credits.refreshCreditWindow,
  refundGuavaCredits: credits.refundGuavaCredits,
  reserveGuavaCredits: credits.reserveGuavaCredits,
  usageSummary: ledger.usageSummary,
  withUsageDiagnostics: meter.withUsageDiagnostics,
};
