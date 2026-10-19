const logger = require('../utils/logger');
const mongoose = require('mongoose');

/** Rewrite the legacy stored plan; retain the schema enum until GATE-03.
 * Rollback: free is read as Starter everywhere; there is no behavior to roll back.
 * This module's import is hermetic. Only its explicit CLI loads environment.
 * node src/migrations/free-plan-to-starter.js          reports only
 * node src/migrations/free-plan-to-starter.js --apply  applies the rewrite
 */
const up = async (db) => {
  const result = await db.collection('organizations').updateMany(
    { plan: 'free' }, { $set: { plan: 'starter' } }
  );
  return { matched: result.matchedCount, modified: result.modifiedCount };
};

/** The CLI's work on an open db: a dry-run report (count and ids), or the rewrite with --apply. */
const run = async (db, { apply = false, print = (line) => logger.printLine(line) } = {}) => {
  if (!apply) {
    const count = await db.collection('organizations').countDocuments({ plan: 'free' });
    print(`DRY RUN: ${count} organisation(s) on the legacy free plan. Re-run with --apply to rewrite them.`);
    for await (const org of db.collection('organizations').find({ plan: 'free' }, { projection: { _id: 1 } })) {
      print(String(org._id));
    }
    return { applied: false, count };
  }
  const result = await up(db);
  print('APPLIED: ' + JSON.stringify(result));
  return { applied: true, ...result };
};

async function main() {
  require('dotenv').config();
  await mongoose.connect(process.env.MONGODB_URI);
  await run(mongoose.connection.db, { apply: process.argv.includes('--apply') });
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    logger.fatal('migration_cli_failed', logger.errorFields(error, { stack: true }));
    await mongoose.disconnect().catch(() => null);
    process.exit(1);
  });
}

module.exports = { up, run };
