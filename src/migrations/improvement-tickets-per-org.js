const logger = require('../utils/logger');
require('dotenv').config();
const mongoose = require('mongoose');
const Improvement = require('../models/Improvement.model');

/**
 * gap-10: tickets were numbered from one platform-wide counter with a global unique index. They are now numbered per
 * organisation, unique on { orgId, ticketNumber }. Mongoose creates the new index but never drops the old one, and with the old
 * one in place the second organisation's ticket #1 fails. Existing numbers stay as they are; each org's counter starts after its
 * highest number on first use.
 *
 *   node src/migrations/improvement-tickets-per-org.js           # dry run, changes nothing
 *   node src/migrations/improvement-tickets-per-org.js --apply   # drop the legacy index, ensure the new one
 */
const LEGACY_INDEX = 'ticketNumber_1';

const migrateImprovementTicketIndexes = async ({ apply = false } = {}) => {
  const indexes = await Improvement.collection.indexes();
  const dropLegacyIndex = indexes.some((index) => index.name === LEGACY_INDEX);
  if (apply) {
    if (dropLegacyIndex) await Improvement.collection.dropIndex(LEGACY_INDEX);
    await Improvement.collection.createIndex({ orgId: 1, ticketNumber: 1 }, { unique: true });
  }
  return { dropLegacyIndex, applied: apply };
};

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const result = await migrateImprovementTicketIndexes({ apply: process.argv.includes('--apply') });
    logger.info('migration', { name: 'improvement-tickets-per-org', ...result });
    await mongoose.disconnect();
  })().catch((error) => {
    logger.fatal('migration_cli_failed', logger.errorFields(error, { stack: true }));
    process.exitCode = 1;
  });
}

module.exports = { migrateImprovementTicketIndexes };
