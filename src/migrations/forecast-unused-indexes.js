const { listIndexesSafe, dropIndexIfPresent, sameKey } = require('./indexTools');

/**
 * Drops Forecast indexes no query uses (forecasting-23). Reads filter on cafeId +
 * date ({ cafeId: 1, date: 1 }, unique) or cafeId + dateKey ({ cafeId: 1, dateKey: 1 },
 * BE-06-T01's stored-signal lookup); nothing filters on dateKey or origin alone.
 * Mongoose never drops an index it stops declaring, so without this they stay and
 * cost every write. Edit UNUSED only with BE-11-T06 step 0's query inventory.
 */
const UNUSED = [{ dateKey: 1 }, { origin: 1 }];
const REQUIRED_REPLACEMENT = [{ cafeId: 1, date: 1 }];
const present = async (db) => (await listIndexesSafe(db.collection('forecasts')))
  .filter((index) => UNUSED.some((key) => sameKey(index.key, key)));

module.exports = {
  name: 'forecast-unused-indexes',
  description: 'Drop Forecast indexes that no query uses (dateKey alone, origin alone)',
  kind: 'contract',
  mode: 'auto',
  async check({ db }) {
    const stale = await present(db);
    return stale.length > 0
      ? { pending: true, detail: `unused forecast indexes: ${stale.map((index) => index.name).join(', ')}` }
      : { pending: false, detail: 'no unused forecast indexes' };
  },
  async up({ db }) {
    const dropped = [];
    for (const key of UNUSED) {
      // Throws, and the runner records the migration failed, unless the cafeId + date index every read relies on exists.
      const gone = await dropIndexIfPresent(db.collection('forecasts'), key, { requireOneOf: REQUIRED_REPLACEMENT });
      if (gone) dropped.push(JSON.stringify(key));
    }
    return { dropped };
  },
};
