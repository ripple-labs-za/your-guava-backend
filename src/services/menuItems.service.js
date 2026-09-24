const mongoose = require('mongoose');
const Item = require('../models/Item.model');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const { inferItemCategory } = require('../utils/itemCategory');

const MAX_CANONICAL_NAME_CHARS = 200;
const MAX_ALIASES = 50;
const MATCH_CANDIDATE_POOL = 100;
// How far the resolver follows merged items to their target. map_to only links to active items and re-points the
// items already linked to the one it merges, so chains stay one hop; the bound keeps a hand-made cycle or a legacy
// chain from stalling an import.
const MAX_MERGE_HOPS = 5;
const { prepareMatchPool, rankMatchCandidates } = require('./menuMatching');

/**
 * The key that decides menu-item identity: two names with the same key are
 * treated as the same product by the sales-line lookup, by the rebuild and by
 * the duplicate check on POST /api/items.
 *
 * It used to delete every parenthesised group first, on the theory that
 * "(Blend)" and "(None)" were till noise. They are not — a parenthesised
 * modifier is how a Yoco export writes a variant, so "Cappuccino (Small)" and
 * "Cappuccino (Large)" collapsed into one Item with one expectedPrice, the
 * large sale was rewritten to disk as a small, and the owner could not add the
 * missing variant by hand because create answered 409. Case and punctuation are
 * levelled; every word the till printed survives into the key.
 */
const normalizeItemName = (name = '') =>
  String(name)
    .slice(0, MAX_CANONICAL_NAME_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// The looser key identity deliberately no longer uses: the name with its
// modifiers removed, kept only for telling siblings apart below.
const baseItemName = (name = '') =>
  normalizeItemName(String(name || '').replace(/\([^)]*\)/g, ' '));

const itemModifierKey = (name = '') =>
  (String(name || '').match(/\([^)]*\)/g) || [])
    .map((group) => normalizeItemName(group))
    .filter(Boolean)
    .sort()
    .join(' ');

// Two names that share a base but carry different modifiers are deliberate
// siblings — a small and a large, a blend and a decaf. Nothing may quietly join
// them back up: not the fuzzy match suggestions (approving one would undo the
// split), and not the alias the rebuild learns from a transaction's rawName,
// which is how a cafe whose history was merged under the old key would
// otherwise re-merge itself on its very next import.
const areSiblingVariants = (a = '', b = '') => {
  const [modifierA, modifierB] = [itemModifierKey(a), itemModifierKey(b)];
  if (!modifierA || !modifierB || modifierA === modifierB) return false;
  const base = baseItemName(a);
  return Boolean(base) && base === baseItemName(b);
};

const toObjectId = (id) => (
  id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
);

const uniqueStrings = (values = []) =>
  [...new Set(
    values
      .map((value) => String(value || '').trim())
      .filter((value) => value && value.length <= MAX_CANONICAL_NAME_CHARS)
  )].slice(0, MAX_ALIASES);

const buildAliasKeys = (aliases = []) =>
  uniqueStrings(aliases).map(normalizeItemName).filter(Boolean);

const withSession = (query, session) => (session ? query.session(session) : query);

/** The per-cafe menu lock: the first write of a transaction that rebuilds menu items (see Cafe.menuRevision). */
const lockCafeMenu = (cafeId, session) =>
  Cafe.updateOne({ _id: toObjectId(cafeId) }, { $inc: { menuRevision: 1 } }, session ? { session } : undefined);

// Menu edits used to save, relink and rebuild with no transaction, so an import committing in between had its new
// items zeroed and its totals overwritten by the edit's stale rebuild (uploads-catalogue-11). `work` runs again when
// the driver retries a conflict, so it must load what it changes inside the session and have no outside side effect.
const runMenuMutation = async (cafeId, work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      await lockCafeMenu(cafeId, session);
      result = await work(session);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } finally {
    await session.endSession();
  }
};

// A line whose unitPrice is a basket average spread across a multi-item
// receipt (parser priceSource 'derived') is not a price observation. Rows
// written before the flag existed carry no priceSource and are exact.
const isExactPrice = (item = {}) => item.priceSource !== 'derived';

const newMenuItemFields = (name, item = {}) => {
  const unitPrice = Number.isFinite(Number(item.unitPrice)) ? Number(item.unitPrice) : undefined;
  // Only an exact line price may seed what the item is expected to cost, or be
  // shown as an observed price. A basket average from a multi-item receipt made
  // every later exact observation look like a price change.
  const learnedPrice = isExactPrice(item) ? unitPrice : undefined;
  return {
    normalizedName: normalizeItemName(name),
    category: inferItemCategory(name),
    expectedPrice: learnedPrice,
    source: 'imported',
    reviewStatus: 'needs_review',
    aliases: [],
    aliasKeys: [],
    avgPrice: unitPrice,
    observedPriceMin: learnedPrice,
    observedPriceMax: learnedPrice,
    lastObservedPrice: learnedPrice,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  };
};

/**
 * A merged item keeps its name (the unique index needs it), so a later import finds it by name and used to link the
 * sale to the inactive item, split off where no screen shows it. mergedInto is the owner's decision about where those
 * sales belong: load the targets and follow each chain to its root, at most MAX_MERGE_HOPS loads.
 */
const loadMergeTargets = async (cafeId, documents, session) => {
  const byId = new Map(documents.map((document) => [String(document._id), document]));
  const unloadedTarget = (document) => document.reviewStatus === 'merged' && document.mergedInto
    && !byId.has(String(document.mergedInto));
  let pending = documents.filter(unloadedTarget);
  for (let hop = 0; hop < MAX_MERGE_HOPS && pending.length > 0; hop += 1) {
    const targets = await withSession(Item.find({ cafeId, _id: { $in: pending.map((document) => document.mergedInto) } }), session);
    targets.forEach((target) => byId.set(String(target._id), target));
    pending = targets.filter(unloadedTarget);
  }
  const followMerge = (document) => {
    let current = document;
    const seen = new Set();
    while (current.reviewStatus === 'merged' && current.mergedInto && !seen.has(String(current._id))) {
      seen.add(String(current._id));
      const next = byId.get(String(current.mergedInto));
      if (!next) break;
      current = next;
    }
    return current;
  };
  followMerge.remember = (document) => byId.set(String(document._id), document);
  return followMerge;
};

/**
 * Resolves a whole basket of raw sales names against the cafe's menu in one
 * query, and remembers anything created along the way.
 *
 * Every line used to run its own findOne with a three-branch $or, awaited in
 * turn inside the ingest transaction, so a 50k-row import was tens of thousands
 * of sequential round trips — minutes of pure latency inside a 60-second
 * transaction that then rolled the whole import back.
 */
const createMenuItemResolver = async (cafeId, names, session) => {
  const keys = [...new Set(names.map(normalizeItemName).filter(Boolean))];
  const clauses = [{ name: { $in: names } }];
  if (keys.length > 0) {
    clauses.push({ normalizedName: { $in: keys } }, { aliasKeys: { $in: keys } });
  }
  const documents = await withSession(Item.find({ cafeId, $or: clauses }), session);
  const followMerge = await loadMergeTargets(cafeId, documents, session);

  const byName = new Map();
  const byKey = new Map();
  const byAliasKey = new Map();
  const register = (document) => {
    followMerge.remember(document);
    if (!byName.has(document.name)) byName.set(document.name, document);
    if (document.normalizedName && !byKey.has(document.normalizedName)) {
      byKey.set(document.normalizedName, document);
    }
    for (const aliasKey of document.aliasKeys || []) {
      if (!byAliasKey.has(aliasKey)) byAliasKey.set(aliasKey, document);
    }
  };
  documents.forEach(register);

  return {
    register,
    // Exact name, then the normalised key, then an alias. The old single $or
    // left the winner to whichever index the planner happened to use, so an
    // item that carried another item's name as an alias could out-rank it.
    // A merged item is then followed to where the owner linked it (BE-03-T10).
    resolve: (name) => {
      const key = normalizeItemName(name);
      const hit = byName.get(name) || byKey.get(key) || byAliasKey.get(key) || null;
      return hit ? followMerge(hit) : null;
    },
  };
};

const createMenuItem = async (cafeId, name, item, session) => {
  // A read-then-create loses to a second writer — another upload confirm for
  // the same cafe, or the Yoco sync running alongside one — on the unique
  // {cafeId, name} index. The bulk import path rethrows that E11000 and aborts
  // the entire upload; the row-at-a-time path used to file it as a duplicate
  // transaction and drop a real sale silently. An upsert lets the loser read
  // the winner's document instead of raising at all.
  try {
    return await withSession(Item.findOneAndUpdate(
      { cafeId, name },
      { $setOnInsert: newMenuItemFields(name, item) },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ), session);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await withSession(Item.findOne({ cafeId, name }), session);
    if (winner) return winner;
    throw error;
  }
};

const priceCheckForItem = (menuItem, item = {}) => {
  const expectedPrice = Number(menuItem.expectedPrice);
  const observedPrice = Number(item.unitPrice);
  if (
    !isExactPrice(item) ||
    !Number.isFinite(expectedPrice) || expectedPrice <= 0 || !Number.isFinite(observedPrice)
  ) {
    return { expectedPrice: Number.isFinite(expectedPrice) ? expectedPrice : undefined };
  }

  const priceVariancePct = Number((((observedPrice - expectedPrice) / expectedPrice) * 100).toFixed(2));
  const tolerance = Number.isFinite(Number(menuItem.priceTolerancePct))
    ? Number(menuItem.priceTolerancePct)
    : 10;
  const isMismatch = Math.abs(priceVariancePct) > tolerance;

  return { expectedPrice, priceVariancePct, isMismatch };
};

const reconcileTransactionItems = async (cafeId, items = [], options = {}) => {
  const { session } = options;
  const reconciled = [];
  const mismatchUpdates = new Map();

  const lineNames = items.map((item) => String(item.name || '').trim() || 'Unknown Item');
  const resolver = await createMenuItemResolver(cafeId, [...new Set(lineNames)], session);
  const menuItems = new Map();
  for (const [index, name] of lineNames.entries()) {
    if (menuItems.has(name)) continue;
    let menuItem = resolver.resolve(name);
    if (!menuItem) {
      menuItem = await createMenuItem(cafeId, name, items[index], session);
      // So a second line in the same basket whose name differs only in
      // punctuation resolves to the row we just wrote rather than a twin.
      resolver.register(menuItem);
    }
    menuItems.set(name, menuItem);
  }

  for (const [index, item] of items.entries()) {
    const rawName = String(item.name || '').trim();
    const menuItem = menuItems.get(lineNames[index]);
    // Ignored is decided first: an ignored line is not a price observation either, and checked after the price it
    // came back as price_mismatch at any other price and counted as demand again (BE-03-T11).
    const ignored = menuItem.reviewStatus === 'ignored';
    const priceCheck = ignored ? { expectedPrice: menuItem.expectedPrice ?? undefined } : priceCheckForItem(menuItem, item);
    let menuItemStatus = 'matched';
    if (ignored) menuItemStatus = 'ignored';
    else if (priceCheck.isMismatch) menuItemStatus = 'price_mismatch';
    else if (menuItem.reviewStatus === 'needs_review') menuItemStatus = 'needs_review';

    if (priceCheck.isMismatch) {
      mismatchUpdates.set(String(menuItem._id), menuItem);
    }

    reconciled.push({
      ...item,
      salesItemId: menuItem._id,
      rawName: rawName !== menuItem.name ? rawName : item.rawName,
      name: menuItem.name,
      expectedPrice: priceCheck.expectedPrice,
      priceVariancePct: priceCheck.priceVariancePct,
      menuItemStatus,
    });
  }

  for (const menuItem of mismatchUpdates.values()) {
    await Item.updateOne(
      { _id: menuItem._id },
      {
        $set: { lastPriceMismatchAt: new Date() },
        $inc: { priceMismatchCount: 1 },
      },
      session ? { session } : undefined
    );
  }

  return reconciled;
};

const IS_DERIVED_LINE = { $eq: ['$items.priceSource', 'derived'] };
const exactOnly = (expression) => ({ $cond: [IS_DERIVED_LINE, null, expression] });

const definedValues = (values = []) => values.filter((value) => value !== null && value !== undefined);
const minOf = (values) => {
  const defined = definedValues(values);
  return defined.length > 0 ? defined.reduce((a, b) => (b < a ? b : a)) : null;
};
const maxOf = (values) => {
  const defined = definedValues(values);
  return defined.length > 0 ? defined.reduce((a, b) => (b > a ? b : a)) : null;
};

// The later of two {date, order} price observations, applying the same tiebreak
// the aggregation does: _id decides when a date-only export puts a whole day's
// sales at midnight.
const laterExactPrice = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  const byDate = new Date(a.date).getTime() - new Date(b.date).getTime();
  if (byDate !== 0) return byDate > 0 ? a : b;
  return String(a.order) >= String(b.order) ? a : b;
};

const cafeSalesStats = (cafeObjectId, session) => {
  const aggregation = Transaction.aggregate([
    { $match: { cafeId: cafeObjectId, status: 'approved' } },
    { $unwind: '$items' },
    { $match: { 'items.name': { $nin: [null, ''] } } },
    {
      $group: {
        _id: {
          salesItemId: '$items.salesItemId',
          name: '$items.name',
        },
        rawNames: { $addToSet: '$items.rawName' },
        totalQty: { $sum: '$items.quantity' },
        totalRevenue: {
          $sum: {
            $multiply: [
              { $ifNull: ['$items.unitPrice', 0] },
              '$items.quantity',
            ],
          },
        },
        // Only an exact line is a price observation, so the range shown on the
        // very page built for checking prices cannot start at a basket average.
        // $min/$max skip nulls, so a derived line simply does not count; an item
        // that has only ever sold inside baskets reports null instead.
        observedPriceMin: { $min: exactOnly('$items.unitPrice') },
        observedPriceMax: { $max: exactOnly('$items.unitPrice') },
        lastSeenAt: { $max: '$date' },
        firstSeenAt: { $min: '$date' },
        // The newest exact price, chosen by comparing {date, order} composites
        // rather than by sorting the history first. The pipeline used to open
        // with a blocking $sort of every approved transaction purely to make
        // this deterministic — around 300MB at 500k transactions, past Mongo's
        // 100MB limit, and inside the upload's transaction it cannot even spill
        // to disk, so the import aborted and rolled back. BSON compares
        // sub-documents field by field in order, so $max over these is exactly
        // "the latest row, _id breaking a same-instant tie".
        lastExactPrice: { $max: exactOnly({ date: '$date', order: '$_id', value: '$items.unitPrice' }) },
        needsReviewCount: {
          $sum: { $cond: [{ $eq: ['$items.menuItemStatus', 'needs_review'] }, 1, 0] },
        },
        priceMismatchCount: {
          $sum: { $cond: [{ $eq: ['$items.menuItemStatus', 'price_mismatch'] }, 1, 0] },
        },
        lastPriceMismatchAt: {
          $max: {
            $cond: [
              { $eq: ['$items.menuItemStatus', 'price_mismatch'] },
              '$date',
              null,
            ],
          },
        },
      },
    },
  ]);
  if (session) aggregation.session(session);
  return aggregation;
};

// Two stats groups can land on one Item — the same name under both a null and a
// non-null salesItemId, or two spellings that share a key. Written one at a
// time the second overwrote the first's totalSold instead of adding to it, so
// the item reported a fraction of its real volume to the forecast and to the
// review queue's sort order.
const groupStatsByTargetItem = (stats, resolveExisting) => {
  const merged = new Map();
  for (const entry of stats) {
    const existing = resolveExisting(entry);
    const key = existing ? `id:${existing._id}` : `key:${normalizeItemName(entry._id.name)}`;
    const group = merged.get(key);
    if (group) group.entries.push(entry);
    else merged.set(key, { existing, entries: [entry] });
  }
  return [...merged.values()];
};

const combineStats = (entries, existing) => {
  const sum = (field) => entries.reduce((total, entry) => total + (entry[field] || 0), 0);
  const collect = (field) => entries.map((entry) => entry[field]);
  // The item keeps the name it already has when the history still uses it, and
  // otherwise the spelling it sold most under, so two groups landing on one
  // Item cannot rename it at random.
  const byVolume = [...entries].sort(
    (a, b) => (b.totalQty || 0) - (a.totalQty || 0) || String(a._id.name).localeCompare(String(b._id.name))
  );
  const name = existing && entries.some((entry) => entry._id.name === existing.name)
    ? existing.name
    : byVolume[0]._id.name;

  return {
    name,
    totalQty: sum('totalQty'),
    totalRevenue: sum('totalRevenue'),
    needsReviewCount: sum('needsReviewCount'),
    priceMismatchCount: sum('priceMismatchCount'),
    observedPriceMin: minOf(collect('observedPriceMin')),
    observedPriceMax: maxOf(collect('observedPriceMax')),
    firstSeenAt: minOf(collect('firstSeenAt')),
    lastSeenAt: maxOf(collect('lastSeenAt')),
    lastPriceMismatchAt: maxOf(collect('lastPriceMismatchAt')),
    lastExactPrice: collect('lastExactPrice').reduce(laterExactPrice, null),
    rawNames: entries.flatMap((entry) => entry.rawNames || []),
  };
};

const rebuiltItemFields = (combined, existing) => {
  const { name, totalQty } = combined;
  // Fields the owner set by hand are theirs. The rebuild used to relearn all
  // three from sales — before the PUT's own 200 had been written — so an alias
  // could not be removed and a cleared price could not be cleared.
  const manual = new Set(existing?.manualFields || []);
  // An alias that is a sibling variant of the item's own name can only have
  // come from the old match key, which merged the variants in the first place.
  // Left in aliasKeys it re-merges them on the next import, so it is dropped
  // whether it was stored earlier or has just been observed as a rawName.
  const keep = (list) => uniqueStrings(list)
    .filter((alias) => alias !== name && !areSiblingVariants(alias, name));
  const aliases = manual.has('aliases')
    ? keep(existing?.aliases || [])
    : keep([...(existing?.aliases || []), ...combined.rawNames]);

  const fields = {
    name,
    normalizedName: normalizeItemName(name),
    aliases,
    aliasKeys: buildAliasKeys(aliases),
    totalSold: totalQty,
    // Revenue per unit over every line, derived ones included: the forecast
    // multiplies this by predicted quantity, so it has to reconcile with what
    // the till actually took, unlike the observed price range above.
    avgPrice: totalQty > 0 ? parseFloat((combined.totalRevenue / totalQty).toFixed(2)) : 0,
    observedPriceMin: combined.observedPriceMin,
    observedPriceMax: combined.observedPriceMax,
    lastObservedPrice: combined.lastExactPrice?.value ?? null,
    firstSeenAt: combined.firstSeenAt,
    lastSeenAt: combined.lastSeenAt,
    lastPriceMismatchAt: combined.priceMismatchCount > 0 ? combined.lastPriceMismatchAt : null,
    priceMismatchCount: combined.priceMismatchCount,
    reviewStatus: existing?.reviewStatus && existing.reviewStatus !== 'needs_review'
      ? existing.reviewStatus
      : combined.needsReviewCount > 0 || !existing
        ? 'needs_review'
        : 'matched',
    isActive: existing?.isActive ?? true,
  };
  if (!manual.has('category') && (!existing || existing.category === 'other')) {
    fields.category = inferItemCategory(name);
  }
  if (!manual.has('expectedPrice') && existing?.expectedPrice == null && combined.lastExactPrice?.value != null) {
    fields.expectedPrice = combined.lastExactPrice.value;
  }
  return fields;
};

// Remap, upload delete and duplicate-skipping imports leave imported items with no sales. Nothing else removed them
// and there is no delete route, so they sat in the review queue for ever (BE-03-T10). Only items no one has touched
// go: imported, still needing review, no owner fields, no notes, and not the target of a merge.
//
// Only when the caller asks (pruneOrphans): import, remap, upload delete and re-admission, gap-4's own triggers, all
// inside their transaction, so an import's own orphans roll back with it. Since BE-03-T12 every rebuild runs in a
// transaction, but a menu edit's or a Yoco webhook's rebuild still must not prune: a webhook creates its item and
// writes its sale outside any transaction, so a rebuild between the two would delete the item and leave the sale
// pointing at nothing (review of BE-03-T10; ISSUES #37).
const deleteUntouchedOrphans = async (cafeObjectId, noSales, session) => {
  const mergeTargets = await withSession(Item.distinct('mergedInto', { cafeId: cafeObjectId, mergedInto: { $ne: null } }), session);
  await Item.deleteMany({
    cafeId: cafeObjectId,
    source: 'imported',
    reviewStatus: 'needs_review',
    _id: { $nin: mergeTargets },
    $and: [
      { $or: [{ manualFields: { $exists: false } }, { manualFields: { $size: 0 } }] },
      { $or: [{ notes: { $exists: false } }, { notes: null }, { notes: '' }] },
    ],
    ...noSales,
  }, { session });
};

const rebuildItemsForCafe = async (cafeId, options = {}) => {
  const { session, pruneOrphans = false } = options;
  // Every rebuild holds the cafe's menu lock inside a transaction, its own when the caller has none (BE-03-T12).
  if (!session) return runMenuMutation(cafeId, (own) => rebuildItemsForCafe(cafeId, { session: own, pruneOrphans }));
  await lockCafeMenu(cafeId, session);
  const cafeObjectId = toObjectId(cafeId);
  const stats = await cafeSalesStats(cafeObjectId, session);

  // The cafe's whole menu in one query. Resolving each stats group with its own
  // findOne, then upserting it with its own findOneAndUpdate, was 2 round trips
  // per menu item — 600 sequential queries for a 300-item cafe, on every upload
  // commit, every upload delete and every single menu-item edit.
  const existingItems = await withSession(Item.find({ cafeId: cafeObjectId }).lean(), session);
  const byId = new Map(existingItems.map((document) => [String(document._id), document]));
  const byName = new Map();
  const byKey = new Map();
  for (const document of existingItems) {
    if (!byName.has(document.name)) byName.set(document.name, document);
    if (document.normalizedName && !byKey.has(document.normalizedName)) {
      byKey.set(document.normalizedName, document);
    }
  }
  const resolveExisting = (entry) => (entry._id.salesItemId
    ? byId.get(String(entry._id.salesItemId)) || null
    : byName.get(entry._id.name) || byKey.get(normalizeItemName(entry._id.name)) || null);

  const groups = groupStatsByTargetItem(stats, resolveExisting);
  const activeIds = groups.filter((group) => group.existing).map((group) => group.existing._id);
  const activeNames = groups
    .filter((group) => !group.existing)
    .flatMap((group) => group.entries.map((entry) => entry._id.name));

  const noSales = activeIds.length > 0 || activeNames.length > 0
    ? {
        $nor: [
          ...(activeIds.length > 0 ? [{ _id: { $in: activeIds } }] : []),
          ...(activeNames.length > 0 ? [{ name: { $in: activeNames } }] : []),
        ],
      }
    : {};
  await Item.updateMany(
    { cafeId: cafeObjectId, ...noSales },
    { $set: { totalSold: 0, avgPrice: 0 } },
    session ? { session } : undefined
  );
  if (pruneOrphans) await deleteUntouchedOrphans(cafeObjectId, noSales, session);

  const operations = groups.map(({ existing, entries }) => {
    const fields = rebuiltItemFields(combineStats(entries, existing), existing);
    return {
      updateOne: {
        filter: existing
          ? { _id: existing._id }
          : { cafeId: cafeObjectId, normalizedName: fields.normalizedName },
        update: {
          $set: fields,
          $setOnInsert: { cafeId: cafeObjectId, source: 'imported' },
        },
        upsert: true,
      },
    };
  });
  if (operations.length > 0) {
    await Item.bulkWrite(operations, { ordered: false, ...(session ? { session } : {}) });
  }
};

// A relinked line takes its item's review status: ignored always wins (BE-03-T11 relies on it), then needs_review.
const lineStatusFor = (item) => {
  if (item.reviewStatus === 'ignored') return 'ignored';
  if (item.reviewStatus === 'needs_review') return 'needs_review';
  return 'matched';
};

/**
 * Points every sales line of `item` at `targetItem`. It used to set every line matched and drop its price variance,
 * so a notes-only edit cleared the item's price mismatches (BE-03-T10). Status is written first and only on the
 * lines being relinked, never on the target's own; a price_mismatch line keeps its flag unless the caller is
 * resolving it (confirm, link, ignore, a new menu price) or the target is ignored.
 */
const updateTransactionMenuItemLinks = async (cafeId, item, targetItem = item, { clearPriceMismatch = false, session } = {}) => {
  const rawNames = uniqueStrings([item.name, ...(item.aliases || [])]);
  const lineOf = (alias) => ({
    $or: [
      { [`${alias}.salesItemId`]: item._id },
      // The name/rawName fallback only exists for lines written before
      // they carried an id. Applied to linked lines it let an alias steal
      // another menu item's sales outright: an alias equal to item B's
      // name reassigned every one of B's lines to A on an ordinary PUT,
      // and the next rebuild then zeroed B.
      {
        $and: [
          { [`${alias}.salesItemId`]: null },
          { $or: [{ [`${alias}.name`]: { $in: rawNames } }, { [`${alias}.rawName`]: { $in: rawNames } }] },
        ],
      },
    ],
  });
  const filter = {
    cafeId,
    $or: [{ 'items.salesItemId': item._id }, { 'items.name': { $in: rawNames } }, { 'items.rawName': { $in: rawNames } }],
  };
  const options = session ? { session } : {};
  const status = lineStatusFor(targetItem);
  const keepMismatch = !clearPriceMismatch && status !== 'ignored';
  await Transaction.updateMany(filter, {
    $set: { 'items.$[line].menuItemStatus': status },
    $unset: { 'items.$[line].priceVariancePct': '' },
  }, {
    arrayFilters: [keepMismatch ? { $and: [lineOf('line'), { 'line.menuItemStatus': { $ne: 'price_mismatch' } }] } : lineOf('line')],
    ...options,
  });
  const link = { 'items.$[line].salesItemId': targetItem._id, 'items.$[line].name': targetItem.name };
  if (String(item._id) !== String(targetItem._id)) link['items.$[line].rawName'] = item.name;
  if (targetItem.expectedPrice !== undefined) link['items.$[line].expectedPrice'] = targetItem.expectedPrice;
  await Transaction.updateMany(filter, { $set: link }, { arrayFilters: [lineOf('line')], ...options });
};

// The pool is the same for every review item on the page bar the self
// exclusion, so it is fetched once and passed in. Re-running it per item cost
// 100 round trips and 10,000 documents for a single reconciliation page load.
const loadMatchCandidatePool = (cafeId) => Item.find({
  cafeId,
  isActive: { $ne: false },
  reviewStatus: 'matched',
})
  .sort({ totalSold: -1 })
  .limit(MATCH_CANDIDATE_POOL)
  .lean();

// One prepared pool per pool array, so a reconciliation page normalises each
// candidate and alias once and shares one work budget across its items.
const preparedPools = new WeakMap();

const preparedPoolFor = (pool) => {
  let prepared = preparedPools.get(pool);
  if (!prepared) {
    prepared = prepareMatchPool(pool, { normalize: normalizeItemName });
    preparedPools.set(pool, prepared);
  }
  return prepared;
};

const findMatchCandidates = async (cafeId, item, { limit = 3, pool = null } = {}) => {
  if (!normalizeItemName(item.name)) return [];
  const candidatePool = pool || await loadMatchCandidatePool(cafeId);
  const prepared = preparedPoolFor(candidatePool);
  const ranked = rankMatchCandidates(item, prepared, {
    normalize: normalizeItemName,
    // A sibling variant is a different product on purpose; offering it as a
    // merge target puts the collapse the key change removed one click away.
    isSibling: areSiblingVariants,
    limit,
  });
  if (prepared.budget.exhausted && !prepared.budget.reported) {
    prepared.budget.reported = true;
    console.warn(JSON.stringify({
      level: 'warn', event: 'menu_match_budget_exhausted', cafeId: String(cafeId), poolSize: candidatePool.length,
    }));
  }
  return ranked;
};

// markManualFields and resolveMenuItem moved to menuCorrections.service.js (BE-03-T10).
module.exports = {
  normalizeItemName,
  uniqueStrings,
  buildAliasKeys,
  areSiblingVariants,
  reconcileTransactionItems,
  rebuildItemsForCafe,
  lockCafeMenu,
  runMenuMutation,
  findMatchCandidates,
  loadMatchCandidatePool,
  updateTransactionMenuItemLinks,
};
