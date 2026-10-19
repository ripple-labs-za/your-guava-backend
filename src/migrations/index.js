// Ordered. The runner runs expand, then data, then contract, keeping this order within a kind.
// add-orgs.js is deliberately absent: it runs on require and predates organisations (BE-11-T06 deletes it).
module.exports = [
  require('./widen-receipt-index'),
  require('./recategorise-items'),
  require('./align-import-indexes'),
  ...require('./legacyRegistry'),
];
