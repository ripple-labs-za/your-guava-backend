// Ordered. The runner runs expand, then data, then contract, keeping this order within a kind.
module.exports = [
  require('./widen-receipt-index'),
  require('./recategorise-items'),
  require('./align-import-indexes'),
  ...require('./legacyRegistry'),
  require('./forecast-unused-indexes'),
  require('./user-legacy-refresh-tokens'),
];
