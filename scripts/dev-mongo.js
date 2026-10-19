/**
 * A local MongoDB replica set for development when Docker is unavailable. Signup verification, invitations, upload confirm and
 * credit reservation use transactions, which a standalone MongoDB cannot run, so this starts a one-member replica set rs0.
 *
 * Usage: node scripts/dev-mongo.js [port] [--dbpath <dir>]
 *   port     default 27017
 *   --dbpath keep the data in <dir> between runs (default: a temporary directory, deleted on exit)
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const args = process.argv.slice(2);
const port = Number(args.find((arg) => /^\d+$/.test(arg))) || 27017;
const dbPathIndex = args.indexOf('--dbpath');
const dbPath = dbPathIndex === -1 ? undefined : args[dbPathIndex + 1];

(async () => {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port, ...(dbPath ? { dbPath } : {}) }],
  });
  console.log(`[dev-mongo] replica set rs0 on 127.0.0.1:${port}${dbPath ? ` (data in ${dbPath})` : ' (temporary data)'}`);
  console.log(`[dev-mongo] MONGODB_URI=mongodb://127.0.0.1:${port}/your-guava?replicaSet=rs0`);
  console.log('[dev-mongo] Ctrl+C to stop.');
  const stop = async () => {
    await replSet.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((error) => {
  console.error('[dev-mongo] failed to start:', error.message);
  process.exit(1);
});
