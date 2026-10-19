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
  historyBackfillCreditsPerDay: meter.historyBackfillCreditsPerDay,
  billingAccessForOrganization: policy.billingAccessForOrganization,
  billingGraceDays: policy.billingGraceDays,
  billingRequiredError: policy.billingRequiredError,
  bonusUsedForCredits: credits.bonusUsedForCredits,
  creditSnapshot: credits.creditSnapshot,
  meterGuavaCredits: meter.meterGuavaCredits,
  reconcileStaleUsageReservations: ledger.reconcileStaleUsageReservations,
  refreshCreditWindow: credits.refreshCreditWindow,
  usageSummary: ledger.usageSummary,
  withUsageDiagnostics: meter.withUsageDiagnostics,
};
