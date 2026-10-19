const Transaction = require('../models/Transaction.model');
const { sameKey, declaredIndexes, listIndexesSafe, dropIndexIfPresent } = require('./indexTools');

/**
 * Receipt numbers are unique per trading day, not forever: tills that restart
 * their numbering each morning reuse "#0001" daily. Mongoose never drops an index
 * it no longer declares, so a database that ran an older build keeps the unique
 * {cafeId, receiptId} index and refuses day two. This drops every unique receipt
 * index the schema does not declare, after making sure the declared ones exist.
 * Safe on existing data: rows unique on the narrower key are unique on the wider one.
 */
const LEGACY_KEY = { cafeId: 1, receiptId: 1 };
const isReceiptKey = (key) => {
  const fields = Object.keys(key);
  return fields[0] === 'cafeId' && fields[1] === 'receiptId';
};
const declaredReceiptIndexes = () =>
  declaredIndexes(Transaction).filter(({ key, options }) => options.unique && isReceiptKey(key));

const undeclaredReceiptIndexes = async (collection) => {
  const declared = declaredReceiptIndexes();
  return (await listIndexesSafe(collection)).filter((index) =>
    index.unique && isReceiptKey(index.key) && !declared.some((wanted) => sameKey(wanted.key, index.key)));
};

module.exports = {
  name: 'widen-receipt-index',
  description: 'Drop unique receipt indexes the Transaction schema no longer declares (the legacy {cafeId, receiptId} one)',
  kind: 'contract',
  mode: 'auto',
  LEGACY_KEY,
  async check({ db }) {
    const stale = await undeclaredReceiptIndexes(db.collection('transactions'));
    return stale.length > 0
      ? { pending: true, detail: `undeclared unique receipt index: ${stale.map((index) => index.name).join(', ')}` }
      : { pending: false, detail: 'only declared receipt indexes present' };
  },
  async up({ db }) {
    const collection = db.collection('transactions');
    const declared = declaredReceiptIndexes();
    for (const { key, options } of declared) {
      await collection.createIndex(key, options); // additive first; a no-op when Model.init already built it
    }
    const dropped = [];
    for (const index of await undeclaredReceiptIndexes(collection)) {
      await dropIndexIfPresent(collection, index.key, { requireOneOf: declared.map((wanted) => wanted.key) });
      dropped.push(index.name);
    }
    return { ensured: declared.length, dropped };
  },
};

if (require.main === module) {
  // The documented command still works: report by default, --apply to run it.
  const { cli } = require('./runner');
  const args = process.argv.includes('--apply') ? ['--apply', 'widen-receipt-index'] : [];
  cli(args).then((code) => process.exit(code), () => process.exit(1));
}
