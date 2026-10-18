/**
 * Re-export barrel (BE-11-T04). Plan periods live in ./billing/periods.js, hosted
 * sessions in sessions.js, fulfilment in fulfilment.js, reconciliation and its
 * sweeper in reconcile.js. server.js and the startup test import this path.
 */
const periods = require('./billing/periods');
const sessions = require('./billing/sessions');
const fulfilment = require('./billing/fulfilment');
const reconcile = require('./billing/reconcile');

module.exports = {
  planChangeForPayment: periods.planChangeForPayment,
  isScheduledChange: periods.isScheduledChange,
  serialisePlanChange: periods.serialisePlanChange,
  previewPlanChanges: periods.previewPlanChanges,
  effectivePaidThrough: periods.effectivePaidThrough,
  planChangeIsDue: periods.planChangeIsDue,
  formatBillingDate: periods.formatBillingDate,
  renewalPeriodEnd: periods.renewalPeriodEnd,
  applyPlanPayment: fulfilment.applyPlanPayment,
  applyDuePlanChange: fulfilment.applyDuePlanChange,
  createHostedPaymentSession: sessions.createHostedPaymentSession,
  fulfilMockCreditPurchase: fulfilment.fulfilMockCreditPurchase,
  generateReference: sessions.generateReference,
  getCreditPack: sessions.getCreditPack,
  invalidateFutureForecastsForOrg: periods.invalidateFutureForecastsForOrg,
  normalizePaymentIdempotencyKey: sessions.normalizePaymentIdempotencyKey,
  normalizePaymentReference: sessions.normalizePaymentReference,
  paymentRequestFingerprint: sessions.paymentRequestFingerprint,
  reconcilePayment: reconcile.reconcilePayment,
  reconcilePendingPayments: reconcile.reconcilePendingPayments,
  providerLabel: reconcile.providerLabel,
  reconcileOneGatePayment: reconcile.reconcileOneGatePayment,
  reconcilePendingOneGatePayments: reconcile.reconcilePendingOneGatePayments,
};
