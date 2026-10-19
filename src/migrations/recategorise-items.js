const Item = require('../models/Item.model');
const { inferItemCategory } = require('../utils/itemCategory');

/**
 * One-off backfill for items misfiled by the previous category classifier.
 *
 * Why it is needed: the category selects the weather factor -- coffee is
 * adjusted +15% on a cold day while "retail" and "other" get no temperature
 * response at all -- so an item filed wrongly silently loses that signal. The
 * old classifier matched 9 of 33 realistic menu names; the current one matches
 * 37 of 37. Normal re-ingest will not repair the difference, because
 * menuItems.service deliberately only re-infers a category that is still
 * "other", so as never to overwrite a choice a human made.
 *
 * That same protection is the problem this script has to solve carefully:
 * Since 02c69a4, Item.manualFields records an owner's choice explicitly; it wins over
 * provenance-by-reproduction for categories set by hand.
 * The test used here is provenance by reproduction -- if the stored value is
 * exactly what the OLD classifier would have produced, no human changed it and
 * it is safe to re-infer. If it differs, someone corrected it, and it is left
 * alone. That is why a frozen copy of the old rules lives below: it is evidence,
 * not logic, and must not be "tidied up" to match the current classifier.
 *
 *   node src/migrations/runner.js            # dry run, changes nothing
 *   node src/migrations/runner.js --apply recategorise-items    # write the changes
 */

/** FROZEN copy of the pre-fix classifier. Do not edit -- see the note above. */
const legacyInferItemCategory = (name = '') => {
  const n = String(name).toLowerCase();
  if (n.includes('still') || n.includes('sparkling') || n.includes('water')) return 'water';
  if (n.includes('iced') || n.includes('cold brew')) return 'cold_drink';
  if (n.includes('matcha') && n.includes('iced')) return 'cold_drink';
  if (
    n.includes('flat white') || n.includes('long white') || n.includes('cappuccino') ||
    n.includes('cortado') || n.includes('espresso') || n.includes('americano') ||
    n.includes('black coffee') || n.includes('mocha') || n.includes('hot choc') ||
    n.includes('latte') || n.includes('pour over') || n.includes('red espresso') ||
    n.includes('matcha')
  ) return 'coffee';
  if (
    n.includes('muffin') || n.includes('croissant') || n.includes('brownie') ||
    n.includes('cookie') || n.includes('cake') || n.includes('sandwich') ||
    n.includes('crunch') || n.includes('lemon') || n.includes('banana') ||
    n.includes('simple square') || n.includes('poppyseed')
  ) return 'food';
  if (n.includes('250g') || n.includes('750g') || n.includes('blend')) return 'retail';
  return 'other';
};

const BATCH_SIZE = 500;

const plan = (items) => {
  const updates = [];
  const keptManual = [];
  for (const item of items) {
    const stored = item.category || 'other';
    const legacy = legacyInferItemCategory(item.name);
    const next = inferItemCategory(item.name);
    if (next === stored) continue;
    if (Array.isArray(item.manualFields) && item.manualFields.includes('category')) {
      keptManual.push({ name: item.name, stored, wouldBecome: next, reason: 'manualFields' });
      continue;
    }
    // A stored value the old rules would not have produced was set by a person.
    if (stored !== legacy) {
      keptManual.push({ name: item.name, stored, wouldBecome: next, reason: 'differs_from_legacy' });
      continue;
    }
    updates.push({ _id: item._id, cafeId: item.cafeId, name: item.name, from: stored, to: next });
  }
  return { updates, keptManual };
};

// The filter re-checks what plan() saw, so an owner edit between planning and applying wins.
const guardedUpdate = (update) => ({
  updateOne: {
    filter: {
      _id: update._id,
      category: update.from === 'other' ? { $in: ['other', null] } : update.from,
      manualFields: { $ne: 'category' },
    },
    update: { $set: { category: update.to } },
  },
});

const applyUpdates = async (updates) => {
  if (updates.length === 0) return { modified: 0 };
  const result = await Item.bulkWrite(updates.map(guardedUpdate), { ordered: false });
  return { modified: result.modifiedCount };
};

const scan = async (onBatch) => {
  let batch = [];
  const cursor = Item.find({})
    .select('_id cafeId name category manualFields')
    .lean()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const item of cursor) {
    batch.push(item);
    if (batch.length === BATCH_SIZE) {
      await onBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await onBatch(batch);
};

module.exports = {
  name: 'recategorise-items',
  description: 'Re-infer categories the old classifier misfiled; never touches a category an owner set',
  kind: 'data',
  mode: 'manual',
  plan,
  legacyInferItemCategory,
  applyUpdates,
  async check() {
    const moves = new Map();
    let scanned = 0;
    let kept = 0;
    await scan(async (batch) => {
      const { updates, keptManual } = plan(batch);
      scanned += batch.length;
      kept += keptManual.length;
      for (const { from, to } of updates) moves.set(`${from}->${to}`, (moves.get(`${from}->${to}`) || 0) + 1);
    });
    const toChange = [...moves.values()].reduce((sum, count) => sum + count, 0);
    const byMove = [...moves.entries()].map(([move, count]) => `${move} ${count}`).join(', ');
    return {
      pending: toChange > 0,
      detail: `${scanned} scanned, ${toChange} to recategorise${byMove ? ` (${byMove})` : ''}, ${kept} owner choices kept`,
    };
  },
  async up() {
    const totals = { scanned: 0, planned: 0, modified: 0, keptManual: 0 };
    await scan(async (batch) => {
      const { updates, keptManual } = plan(batch);
      const { modified } = await applyUpdates(updates);
      totals.scanned += batch.length;
      totals.planned += updates.length;
      totals.modified += modified;
      totals.keptManual += keptManual.length;
    });
    return totals;
  },
};

if (require.main === module) {
  const { cli } = require('./runner');
  const args = process.argv.includes('--apply') ? ['--apply', 'recategorise-items'] : [];
  cli(args).then((code) => process.exit(code), () => process.exit(1));
}
