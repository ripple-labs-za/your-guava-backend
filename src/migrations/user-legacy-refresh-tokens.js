const { listIndexesSafe, dropIndexIfPresent } = require('./indexTools');

/**
 * Refresh-token families moved to AuthSession on 2026-07-30 and legacy refresh
 * tokens lived 7 days, so the refreshTokens array on users and its two indexes
 * serve nothing (platform-21). Drop the indexes, then unset the field.
 */
const LEGACY_KEYS = [{ 'refreshTokens.tokenHash': 1 }, { 'refreshTokens.token': 1 }];
const legacyIndexes = async (db) => (await listIndexesSafe(db.collection('users')))
  .filter((index) => Object.keys(index.key).some((field) => field.startsWith('refreshTokens')));

module.exports = {
  name: 'user-legacy-refresh-tokens',
  description: 'Drop the users.refreshTokens indexes and unset the field',
  kind: 'contract',
  mode: 'auto',
  async check({ db }) {
    const stale = await legacyIndexes(db);
    const hasFields = await db.collection('users').findOne({ refreshTokens: { $exists: true } }, { projection: { _id: 1 } });
    return stale.length > 0 || hasFields
      ? { pending: true, detail: `legacy refresh-token indexes: ${stale.map((index) => index.name).join(', ')}` }
      : { pending: false, detail: 'no legacy refresh-token indexes' };
  },
  async up({ db, dryRun }) {
    const dropped = [];
    for (const key of LEGACY_KEYS) {
      if (!dryRun && await dropIndexIfPresent(db.collection('users'), key)) dropped.push(Object.keys(key)[0]);
    }
    const unset = dryRun
      ? { modifiedCount: 0 }
      : await db.collection('users').updateMany({ refreshTokens: { $exists: true } }, { $unset: { refreshTokens: '' } });
    return { dropped, usersCleaned: unset.modifiedCount };
  },
};
