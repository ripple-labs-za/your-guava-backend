const mongoose = require('mongoose');
const { listIndexesSafe, dropIndexIfPresent } = require('./indexTools');

// Existing readers retain their legacy fallbacks. These repairs change stored
// customer data and remain explicit operator actions after a read-only report.
const repair = (name, description, report, apply, pending) => ({
  name, description, kind: 'data', mode: 'manual',
  async check() {
    const stats = await report();
    return { pending: pending(stats), detail: JSON.stringify(stats) };
  },
  up: apply,
});

module.exports = [
  {
    name: 'improvement-tickets-per-org', kind: 'contract', mode: 'auto',
    description: 'Replace the global ticket index after ensuring its per-organisation replacement',
    async check() {
      const collection = mongoose.connection.db.collection('improvements');
      const indexes = await listIndexesSafe(collection);
      return { pending: indexes.some((index) => index.name === 'ticketNumber_1'), detail: 'legacy global ticket index' };
    },
    async up() {
      const collection = mongoose.connection.db.collection('improvements');
      const replacement = { orgId: 1, ticketNumber: 1 };
      await collection.createIndex(replacement, { unique: true });
      return { dropped: await dropIndexIfPresent(collection, { ticketNumber: 1 }, { requireOneOf: [replacement] }) };
    },
  },
  repair('mark-date-only-hours', 'Repair hours on legacy date-only imports',
    () => require('./mark-date-only-hours').markDateOnlyHours({ apply: false }),
    () => require('./mark-date-only-hours').markDateOnlyHours({ apply: true }),
    (stats) => stats.matched > 0),
  repair('backfill-event-date-keys', 'Add explicit day keys to legacy events; readers retain date fallbacks',
    () => require('./backfill-event-date-keys').backfillEventDateKeys({ apply: false }),
    () => require('./backfill-event-date-keys').backfillEventDateKeys({ apply: true }),
    (stats) => stats.wouldUpdate > 0),
  repair('free-plan-to-starter', 'Rewrite legacy plan names; the catalogue already reads free as Starter',
    async () => ({ matched: await mongoose.connection.db.collection('organizations').countDocuments({ plan: 'free' }) }),
    () => require('./free-plan-to-starter').up(mongoose.connection.db),
    (stats) => stats.matched > 0),
  repair('relink-ignored-lines', 'Repair ignored lines imported before demand filtering was corrected',
    () => require('./relink-ignored-lines').relinkIgnoredLines({ apply: false }),
    () => require('./relink-ignored-lines').relinkIgnoredLines({ apply: true }),
    (stats) => stats.transactionsWithMislabelledLines > 0),
  {
    name: 'rescore-forecast-accuracy', kind: 'data', mode: 'manual',
    description: 'Explicitly rescore historical forecasts with the current scoring rules',
    // Rescoring is repeatable even when current scores exist; the report is read-only.
    repeatable: true,
    async check() {
      const stats = await require('./rescore-forecast-accuracy').rescoreForecastAccuracy({ apply: false });
      return { pending: stats.scanned > 0, detail: JSON.stringify(stats) };
    },
    up: () => require('./rescore-forecast-accuracy').rescoreForecastAccuracy({ apply: true }),
  },
  repair('reencrypt-secrets', 'Re-seal readable legacy secrets under the current key after a rotation dry run',
    async () => {
      const Cafe = require('../models/Cafe.model');
      const paths = Cafe.secretPaths();
      const cafes = await Cafe.find({}).select(paths.map((path) => `+${path}`).join(' ')).lean();
      const { upgrades, failures } = require('./reencrypt-secrets').planSecretUpgrades(cafes, paths);
      return { upgrades: upgrades.length, unreadable: failures.length };
    },
    async () => {
      const Cafe = require('../models/Cafe.model');
      const paths = Cafe.secretPaths();
      const cafes = await Cafe.find({}).select(paths.map((path) => `+${path}`).join(' ')).lean();
      const { planSecretUpgrades, applySecretUpgrades } = require('./reencrypt-secrets');
      const { upgrades, failures } = planSecretUpgrades(cafes, paths);
      if (failures.length) throw new Error('Unreadable provider secrets: reconnect them before rotating');
      return { modified: await applySecretUpgrades(upgrades) };
    },
    (stats) => stats.upgrades > 0 || stats.unreadable > 0),
];
