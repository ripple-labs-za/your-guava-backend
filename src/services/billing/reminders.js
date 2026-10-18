const Organization = require('../../models/Organization.model');
const User = require('../../models/User.model');
// Called through the module object so tests can spy on it.
const emailService = require('../email.service');
const { getPlan } = require('../billingPlans.service');
const { effectivePaidThrough } = require('../billingPayments.service');
const { billingGraceDays } = require('../usage.service');
const { isValidEmail } = require('../../utils/email');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ORGS_PER_RUN = 200;

/** Which reminder is due now: 1 inside the last day, 7 inside the last week, none otherwise. */
const reminderDue = (endsAt, now) => {
  const msLeft = endsAt.getTime() - now.getTime();
  if (msLeft <= 0) return null;
  if (msLeft <= DAY_MS) return 1;
  if (msLeft <= 7 * DAY_MS) return 7;
  return null;
};

const reminderTarget = (org) => {
  if (org.billingStatus === 'trialing' && org.trialEndsAt) return { kind: 'trial', endsAt: new Date(org.trialEndsAt) };
  if (org.billingStatus === 'active') {
    const endsAt = effectivePaidThrough(org);
    if (endsAt) {
      const pending = org.pendingPlanChange;
      const plan = pending?.periodEnd && new Date(pending.periodEnd).getTime() === endsAt.getTime()
        ? pending.plan
        : org.plan;
      return { kind: 'paid', endsAt, plan };
    }
  }
  return null;
};

// BE-02-T06 made the console transport report sent:false; a console delivery was still delivered.
const delivered = (result) => result?.sent === true || result?.transport === 'console';

/**
 * Emails the owner (and the billing email) 7 days and 1 day before a trial or paid period ends (gap-3).
 * Idempotent per org, period end and reminder; a failed delivery is released so the next run retries it.
 */
const runBillingReminders = async ({ now = new Date() } = {}) => {
  const horizon = new Date(now.getTime() + 7 * DAY_MS);
  const candidates = Organization.find({
    $or: [
      { billingStatus: 'trialing', trialEndsAt: { $gt: now, $lte: horizon } },
      { billingStatus: 'active', currentPeriodEnd: { $gt: now, $lte: horizon } },
      { billingStatus: 'active', 'pendingPlanChange.periodEnd': { $gt: now, $lte: horizon } },
    ],
  })
    .select('+billingRemindersSent')
    .sort({ _id: 1 })
    .lean()
    .cursor({ batchSize: MAX_ORGS_PER_RUN });

  const summary = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  for await (const org of candidates) {
    // Bound deliveries and memory, without starving later owners behind already delivered rows.
    if (summary.sent + summary.failed >= MAX_ORGS_PER_RUN) break;
    summary.scanned += 1;
    const target = reminderTarget(org);
    const daysLeft = target && reminderDue(target.endsAt, now);
    if (!daysLeft) {
      summary.skipped += 1;
      continue;
    }
    const key = `${target.kind}:${target.endsAt.toISOString()}:${daysLeft}d`;
    if (org.billingRemindersSent?.includes(key)) {
      summary.skipped += 1;
      continue;
    }
    const claimed = await Organization.updateOne(
      { _id: org._id, billingRemindersSent: { $ne: key } },
      { $push: { billingRemindersSent: { $each: [key], $slice: -12 } } }
    );
    if (claimed.modifiedCount !== 1) {
      summary.skipped += 1;
      continue;
    }
    try {
      const owner = await User.findById(org.ownerId).select('email name').lean();
      const billingEmail = typeof org.billingEmail === 'string' ? org.billingEmail.trim().toLowerCase() : '';
      const to = [...new Set([owner?.email, billingEmail].filter(isValidEmail))];
      if (to.length === 0) throw new Error('the organisation has no owner email or billing email');
      const result = await emailService.sendBillingReminderEmail({
        to,
        ownerName: owner?.name,
        orgName: org.name,
        planName: getPlan(target.plan || org.plan).name,
        kind: target.kind,
        endsAt: target.endsAt,
        daysLeft,
        now,
        graceDays: billingGraceDays(),
      });
      if (!delivered(result)) throw new Error(String(result?.reason || result?.error || 'email not sent'));
      summary.sent += 1;
    } catch (error) {
      summary.failed += 1;
      await Organization.updateOne({ _id: org._id }, { $pull: { billingRemindersSent: key } }).catch(() => null);
      console.error(`[billing] reminder ${key} for org ${org._id} failed:`, error.message);
    }
  }
  return summary;
};

module.exports = { runBillingReminders, reminderDue };
