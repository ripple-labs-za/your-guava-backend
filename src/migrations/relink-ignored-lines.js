const logger = require('../utils/logger');
require('dotenv').config();
const mongoose = require('mongoose');
const Item = require('../models/Item.model');
const Transaction = require('../models/Transaction.model');
const { updateTransactionMenuItemLinks } = require('../services/menuItems.service');

/**
 * BE-03-T11. Before the fix, a line imported for an ignored menu item at a price outside its tolerance was stored as
 * price_mismatch, not ignored (a delivery fee priced by distance), and every demand reader still counts it. Relinking
 * each ignored item's lines marks them ignored: an ignored target always wins over a kept mismatch. The report counts
 * the transactions that carry such a line.
 *
 *   node src/migrations/relink-ignored-lines.js          # report only
 *   node src/migrations/relink-ignored-lines.js --apply  # make the change
 */
const relinkIgnoredLines = async ({ apply = false } = {}) => {
  const items = await Item.find({ reviewStatus: 'ignored' }).select('_id cafeId name aliases reviewStatus expectedPrice').lean();
  let mislabelled = 0;
  for (const item of items) {
    mislabelled += await Transaction.countDocuments({
      cafeId: item.cafeId,
      items: { $elemMatch: { salesItemId: item._id, menuItemStatus: { $ne: 'ignored' } } },
    });
    if (apply) await updateTransactionMenuItemLinks(item.cafeId, item, item);
  }
  return { ignoredItems: items.length, transactionsWithMislabelledLines: mislabelled, applied: apply };
};

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const summary = await relinkIgnoredLines({ apply: process.argv.includes('--apply') });
    logger.printLine(JSON.stringify(summary));
    await mongoose.disconnect();
  })().catch((error) => {
    logger.fatal('migration_cli_failed', logger.errorFields(error, { stack: true }));
    process.exit(1);
  });
}

module.exports = { relinkIgnoredLines, up: () => relinkIgnoredLines({ apply: true }) };
