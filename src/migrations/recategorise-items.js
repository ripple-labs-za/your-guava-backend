const logger = require('../utils/logger');
require('dotenv').config();
const mongoose = require('mongoose');
const Item = require('../models/Item.model');
const Cafe = require('../models/Cafe.model');
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
 * nothing records whether a stored category was auto-assigned or set by hand.
 * The test used here is provenance by reproduction -- if the stored value is
 * exactly what the OLD classifier would have produced, no human changed it and
 * it is safe to re-infer. If it differs, someone corrected it, and it is left
 * alone. That is why a frozen copy of the old rules lives below: it is evidence,
 * not logic, and must not be "tidied up" to match the current classifier.
 *
 *   node src/migrations/recategorise-items.js            # dry run, changes nothing
 *   node src/migrations/recategorise-items.js --apply    # write the changes
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

const plan = (items) => {
  const updates = [];
  const keptManual = [];

  for (const item of items) {
    const stored = item.category || 'other';
    const legacy = legacyInferItemCategory(item.name);
    const next = inferItemCategory(item.name);

    if (next === stored) continue;

    // A stored value the old rules would not have produced was set by a person.
    if (stored !== legacy) {
      keptManual.push({ name: item.name, stored, wouldBecome: next });
      continue;
    }
    updates.push({ _id: item._id, cafeId: item.cafeId, name: item.name, from: stored, to: next });
  }

  return { updates, keptManual };
};

async function migrate() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI);

  const items = await Item.find({}).select('_id cafeId name category').lean();
  const { updates, keptManual } = plan(items);

  const cafeIds = [...new Set(updates.map((u) => String(u.cafeId)))];
  const cafes = await Cafe.find({ _id: { $in: cafeIds } }).select('name').lean();
  const cafeName = new Map(cafes.map((c) => [String(c._id), c.name]));

  logger.printLine(`\n${apply ? 'APPLYING' : 'DRY RUN — no changes will be written'}`);
  logger.printLine(`items scanned            : ${items.length}`);
  logger.printLine(`already correct          : ${items.length - updates.length - keptManual.length}`);
  logger.printLine(`manual choices preserved : ${keptManual.length}`);
  logger.printLine(`to recategorise          : ${updates.length}\n`);

  const byMove = new Map();
  for (const u of updates) {
    const key = `${u.from} -> ${u.to}`;
    if (!byMove.has(key)) byMove.set(key, []);
    byMove.get(key).push(u);
  }
  for (const [move, rows] of [...byMove.entries()].sort((a, b) => b[1].length - a[1].length)) {
    logger.printLine(`  ${move.padEnd(22)} ${String(rows.length).padStart(4)}`);
    for (const r of rows.slice(0, 5)) {
      logger.printLine(`      ${r.name}  (${cafeName.get(String(r.cafeId)) || r.cafeId})`);
    }
    if (rows.length > 5) logger.printLine(`      ... and ${rows.length - 5} more`);
  }

  if (keptManual.length > 0) {
    logger.printLine('\nleft untouched because a person had set them:');
    for (const k of keptManual.slice(0, 10)) {
      logger.printLine(`  ${k.name}: kept "${k.stored}" (would otherwise become "${k.wouldBecome}")`);
    }
    if (keptManual.length > 10) logger.printLine(`  ... and ${keptManual.length - 10} more`);
  }

  if (apply && updates.length > 0) {
    const result = await Item.bulkWrite(
      updates.map((u) => ({
        updateOne: { filter: { _id: u._id }, update: { $set: { category: u.to } } },
      }))
    );
    logger.printLine(`\nmodified: ${result.modifiedCount}`);
    logger.printLine('Forecasts regenerate on their own; existing stored forecasts keep their old factors until then.');
  } else if (!apply) {
    logger.printLine('\nRe-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
  process.exit(0);
}

module.exports = { plan, legacyInferItemCategory };

if (require.main === module) {
  migrate().catch((e) => { logger.fatal('migration_cli_failed', logger.errorFields(e, { stack: true })); process.exit(1); });
}
