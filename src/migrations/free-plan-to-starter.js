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

async function main() {
  require('dotenv').config();
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  if (!process.argv.includes('--apply')) {
    const count = await db.collection('organizations').countDocuments({ plan: 'free' });
    console.log(`DRY RUN: ${count} organisation(s) on the legacy free plan. Re-run with --apply to rewrite them.`);
    for await (const org of db.collection('organizations').find({ plan: 'free' }, { projection: { _id: 1 } })) {
      console.log(String(org._id));
    }
  } else {
    console.log('APPLIED:', await up(db));
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error('free-plan-to-starter failed:', error.message);
    await mongoose.disconnect().catch(() => null);
    process.exit(1);
  });
}

module.exports = { up };
