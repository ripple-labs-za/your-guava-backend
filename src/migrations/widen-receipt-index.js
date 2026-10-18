const logger = require('../utils/logger');
require('dotenv').config();
const mongoose = require('mongoose');

/**
 * Replaces the unique index {cafeId, receiptId} with {cafeId, receiptId, date}.
 *
 * Receipt numbers are only unique within a trading day on tills that restart
 * their numbering each morning. Under the old index the second day's "#0001"
 * collided with the first, and the whole import was refused.
 *
 * Safe to run against existing data: every row that satisfied the narrower
 * uniqueness also satisfies the wider one, so no document can conflict. Mongoose
 * will not drop the old index on its own -- an index it no longer declares is
 * simply left in place -- which is why this exists.
 *
 *   node src/migrations/widen-receipt-index.js          # report only
 *   node src/migrations/widen-receipt-index.js --apply  # make the change
 */

const OLD_KEY = { cafeId: 1, receiptId: 1 };
const NEW_KEY = { cafeId: 1, receiptId: 1, date: 1 };
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function migrate() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI);
  const collection = mongoose.connection.collection('transactions');
  const indexes = await collection.indexes();

  const old = indexes.find((i) => sameKey(i.key, OLD_KEY) && i.unique);
  const next = indexes.find((i) => sameKey(i.key, NEW_KEY) && i.unique);

  logger.printLine(`\n${apply ? 'APPLYING' : 'DRY RUN — no changes will be written'}`);
  logger.printLine(`  old unique {cafeId, receiptId}       : ${old ? old.name : 'absent'}`);
  logger.printLine(`  new unique {cafeId, receiptId, date} : ${next ? next.name : 'absent'}`);

  if (!apply) {
    logger.printLine('\nRe-run with --apply to make the change.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!next) {
    await collection.createIndex(NEW_KEY, {
      unique: true,
      partialFilterExpression: { receiptId: { $type: 'string' } },
    });
    logger.printLine('  created the wider unique index');
  }
  if (old) {
    await collection.dropIndex(old.name);
    logger.printLine(`  dropped ${old.name}`);
  }

  logger.printLine('done');
  await mongoose.disconnect();
  process.exit(0);
}

if (require.main === module) {
  migrate().catch((e) => { logger.fatal('migration_cli_failed', logger.errorFields(e, { stack: true })); process.exit(1); });
}

module.exports = { OLD_KEY, NEW_KEY };
