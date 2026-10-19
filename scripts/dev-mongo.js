/**
 * A local MongoDB replica set for development when Docker is unavailable. Signup verification, invitations, upload confirm and
 * credit reservation use transactions, which a standalone MongoDB cannot run, so this starts a one-member replica set rs0.
 *
 * Usage: node scripts/dev-mongo.js [port] [--dbpath <dir>]
 *   port     default 27017; 0 selects an OS-assigned port
 *   --dbpath keep the data in <dir> between runs (default: a temporary directory, deleted on exit)
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const startDevMongo = async ({ port = 27017, dbPath } = {}) => {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port, ...(dbPath ? { dbPath } : {}) }],
  });
  return { replSet, uri: replSet.getUri('your-guava') };
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const portArgument = args.find((arg) => /^\d+$/.test(arg));
  const port = portArgument === undefined ? 27017 : Number(portArgument);
  const dbPathIndex = args.indexOf('--dbpath');
  const dbPath = dbPathIndex === -1 ? undefined : args[dbPathIndex + 1];
  startDevMongo({ port, dbPath }).then(({ replSet, uri }) => {
    console.log(`[dev-mongo] replica set rs0 on ${new URL(uri).host}${dbPath ? ` (data in ${dbPath})` : ' (temporary data)'}`);
    console.log(`[dev-mongo] MONGODB_URI=${uri}`);
    console.log('[dev-mongo] Ctrl+C to stop.');
    const stop = async () => {
      await replSet.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((error) => {
    console.error('[dev-mongo] failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = { startDevMongo };
