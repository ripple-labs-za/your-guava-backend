// The owner's corrections on Menu Items: link (map_to), confirm, ignore and edit. Moved out of menuItems.service.js by
// BE-03-T10, which gave the edit its own rules and would have taken that module past 800 lines.
const Item = require('../models/Item.model');
const Transaction = require('../models/Transaction.model');
const {
  normalizeItemName, uniqueStrings, buildAliasKeys, areSiblingVariants, updateTransactionMenuItemLinks, rebuildItemsForCafe,
  runMenuMutation, MAX_BULK_CONFIRM,
} = require('./menuItems.service');

const MANUAL_FIELDS = ['category', 'expectedPrice', 'aliases'];

const notFound = (message) => Object.assign(new Error(message), { statusCode: 404 });
// A refusal the controllers answer themselves with its code; publicCode is the field BE-03-T12's error middleware
// exposes (err.code alone never is), so both are set.
const refusal = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code, publicCode: code });

// Records that a value came from the owner rather than from sales, so the
// rebuild leaves it alone.
const markManualFields = (document, fields = []) => {
  const manual = new Set(document.manualFields || []);
  fields.forEach((field) => manual.add(field));
  document.manualFields = [...manual];
};

/**
 * Links `item` to an active menu item. It accepted any target: the item itself (it vanished with all its sales), or a
 * merged or ignored item (the sales landed where no screen shows them, and chains and cycles of merges became
 * possible). Both are refused before anything is written (BE-03-T10).
 */
const mapTo = async (cafeId, item, { targetItemId, expectedPrice, category, aliases }, session) => {
  if (String(targetItemId) === String(item._id)) throw refusal(400, 'MAP_TO_SELF', 'A menu item cannot be linked to itself.');
  const target = await Item.findOne({ _id: targetItemId, cafeId }).session(session);
  if (!target) throw notFound('Target item not found');
  if (target.isActive === false || ['merged', 'ignored'].includes(target.reviewStatus)) {
    throw refusal(400, 'MAP_TO_INACTIVE_TARGET', target.reviewStatus === 'merged'
      ? `"${target.name}" is already linked to another menu item. Link to that item instead.`
      : `"${target.name}" is not on the active menu. Link to an active menu item instead.`);
  }

  // The merged name goes first. uniqueStrings truncates at MAX_ALIASES, and
  // with the target's own list leading, a target already holding 50 aliases
  // silently dropped the one name the merge existed to record — so the same
  // misspelling came back as a fresh review item after every upload, forever.
  const mergedAliases = uniqueStrings([
    item.name,
    ...(aliases || []),
    ...(item.aliases || []),
    ...(target.aliases || []),
  ]);
  target.aliases = mergedAliases;
  target.aliasKeys = buildAliasKeys(mergedAliases);
  // The Fix Imports card sends its own category and price with every Link, so a value equal to the linked item's own
  // is the card echoing itself, not a decision about the target. Taken as one, linking "Capuccino" (inferred other,
  // priced at a mismatched 45) turned Cappuccino from coffee at 38 into other at 45 and locked both (BE-03-T10).
  if (expectedPrice !== undefined && Number(expectedPrice) !== item.expectedPrice) {
    target.expectedPrice = Number(expectedPrice);
    markManualFields(target, ['expectedPrice']);
  }
  if (category && category !== item.category) {
    target.category = category;
    markManualFields(target, ['category']);
  }
  target.reviewStatus = 'matched';
  await target.save({ session });

  item.reviewStatus = 'merged';
  item.isActive = false;
  item.mergedInto = target._id;
  await item.save({ session });
  // Items already linked to this one follow it, so every merge chain stays one hop and the resolver's hop limit is
  // never reached by ordinary use.
  await Item.updateMany({ cafeId, mergedInto: item._id, _id: { $ne: target._id } }, { $set: { mergedInto: target._id } }, { session });
  await updateTransactionMenuItemLinks(cafeId, item, target, { clearPriceMismatch: true, session });
  await rebuildItemsForCafe(cafeId, { session });
  return target;
};

// Confirm, link and ignore are explicit resolutions, so each clears the price mismatches of the lines it relinks. All of
// it runs under the cafe's menu lock in one transaction (BE-03-T12), and runs again if the driver retries a conflict.
const resolveMenuItem = (cafeId, itemId, body) => runMenuMutation(cafeId, (session) => resolveInSession(cafeId, itemId, body, session));

const resolveInSession = async (cafeId, itemId, { action, targetItemId, expectedPrice, category, aliases, notes }, session) => {
  const item = await Item.findOne({ _id: itemId, cafeId }).session(session);
  if (!item) throw notFound('Item not found');

  if (action === 'map_to') return mapTo(cafeId, item, { targetItemId, expectedPrice, category, aliases }, session);

  if (action === 'ignore') {
    item.reviewStatus = 'ignored';
    item.isActive = false;
    if (notes !== undefined) item.notes = notes;
    await item.save({ session });
    await updateTransactionMenuItemLinks(cafeId, item, item, { clearPriceMismatch: true, session });
    await rebuildItemsForCafe(cafeId, { session });
    return item;
  }

  item.reviewStatus = 'matched';
  item.isActive = true;
  if (expectedPrice !== undefined) {
    item.expectedPrice = Number(expectedPrice);
    markManualFields(item, ['expectedPrice']);
  }
  if (category) {
    item.category = category;
    markManualFields(item, ['category']);
  }
  if (notes !== undefined) item.notes = notes;
  if (aliases !== undefined) {
    item.aliases = uniqueStrings(aliases);
    item.aliasKeys = buildAliasKeys(item.aliases);
    markManualFields(item, ['aliases']);
  }
  item.normalizedName = normalizeItemName(item.name);
  await item.save({ session });
  await updateTransactionMenuItemLinks(cafeId, item, item, { clearPriceMismatch: true, session });
  await rebuildItemsForCafe(cafeId, { session });
  return item;
};

const sameNames = (a = [], b = []) => {
  const left = [...new Set(a.map(String))].sort();
  const right = [...new Set(b.map(String))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

// Which fields the PUT actually changes. The portal sends every field on Save, so "present" is not "changed".
const changedFields = (before, payload) => {
  const has = (field) => Object.prototype.hasOwnProperty.call(payload, field);
  return {
    name: has('name') && payload.name !== before.name,
    aliases: has('aliases') && !sameNames(payload.aliases, before.aliases),
    isActive: has('isActive') && payload.isActive !== (before.isActive !== false),
    reviewStatus: has('reviewStatus') && payload.reviewStatus !== before.reviewStatus,
    expectedPrice: has('expectedPrice') && (payload.expectedPrice ?? null) !== (before.expectedPrice ?? null),
    category: has('category') && payload.category !== before.category,
  };
};

/**
 * A rename keeps the till's spelling. It replaced the name and nothing else, so the next "1 x FLT WHT" created a
 * brand-new review item and split the history; and it skipped the uniqueness rule create enforces, so two items
 * could share a key and the resolver and rebuild flipped sales between them (BE-03-T10).
 */
const renamedFields = async (cafeId, before, payload, session) => {
  const clash = await Item.findOne({ cafeId, normalizedName: payload.normalizedName, _id: { $ne: before._id } })
    .select('name').session(session).lean();
  if (clash) throw refusal(409, 'ITEM_NAME_TAKEN', `A menu item called "${clash.name}" already exists.`);
  // The till keeps printing the old name. Put it first so the 50-alias cap can never drop it; a sibling variant
  // (the small of a large) never becomes an alias, or the next import merges the variants again.
  const hasAliases = Object.prototype.hasOwnProperty.call(payload, 'aliases');
  const aliases = uniqueStrings([before.name, ...(hasAliases ? payload.aliases : before.aliases || [])])
    .filter((alias) => alias !== payload.name && !areSiblingVariants(alias, payload.name));
  return { ...payload, aliases, aliasKeys: buildAliasKeys(aliases) };
};

/**
 * The Menu Items PUT. Every edit used to relink the item's sales (clearing their price mismatches), rebuild the menu
 * and wipe the forecasts, even a notes-only one. Now only a change to what the item is (name, aliases, active,
 * review status) or to its price relinks and rebuilds, and only a price or review-status change clears mismatches.
 */
const updateMenuItem = (cafeId, itemId, payload) => runMenuMutation(cafeId, (session) => updateInSession(cafeId, itemId, payload, session));

const updateInSession = async (cafeId, itemId, payload, session) => {
  const item = await Item.findOne({ _id: itemId, cafeId }).session(session);
  if (!item) throw notFound('Item not found');
  const before = item.toObject();
  const changed = changedFields(before, payload);
  // Only what the owner changed is theirs; the old name a rename adds to the aliases is the till's, not theirs. A
  // rename itself is recorded, so the orphan clean-up never deletes an item the owner has named.
  const manual = [...MANUAL_FIELDS.filter((field) => changed[field]), ...(changed.name ? ['name'] : [])];
  const changes = changed.name ? await renamedFields(cafeId, before, payload, session) : payload;
  if (changed.name) changed.aliases = true;

  Object.assign(item, changes);
  markManualFields(item, manual);
  await item.save({ session });
  const identity = changed.name || changed.aliases || changed.isActive || changed.reviewStatus;
  if (identity || changed.expectedPrice) {
    // The old names find lines that still carry the old name or an alias the edit removed; the new aliases pick up
    // old lines written before lines carried an id.
    const linesOf = { ...before, aliases: [...(before.aliases || []), ...(item.aliases || [])] };
    await updateTransactionMenuItemLinks(cafeId, linesOf, item, { clearPriceMismatch: changed.expectedPrice || changed.reviewStatus, session });
    await rebuildItemsForCafe(cafeId, { session });
  }
  return { item, changed: { identity, price: changed.expectedPrice, category: changed.category } };
};

const bulkError = (statusCode, code, message, details) => Object.assign(new Error(message), {
  statusCode, code, publicCode: code, details: { code, ...details },
});

// Confirm identities in one scan. Linked ids always win; legacy unlinked names
// and aliases retain the old first-item-wins order without N collection scans.
const confirmationPipeline = (items) => {
  const names = new Map();
  items.forEach((item, index) => {
    uniqueStrings([item.name, ...(item.aliases || [])]).forEach((name) => {
      if (!names.has(name)) names.set(name, index);
    });
  });
  const targets = items.map((item) => ({ salesItemId: item._id, name: item.name,
    ...(item.expectedPrice !== undefined ? { expectedPrice: item.expectedPrice } : {}) }));
  const ownerIndex = (index) => ({ $cond: [{ $gte: [index, 0] },
    { $arrayElemAt: [{ $literal: [...names.values()] }, index] }, items.length] });
  const pipeline = [{ $set: { items: { $map: { input: '$items', as: 'line', in: {
    $let: { vars: {
      idIndex: { $indexOfArray: [{ $literal: items.map((item) => item._id) }, '$$line.salesItemId'] },
      nameIndex: { $indexOfArray: [{ $literal: [...names.keys()] }, '$$line.name'] },
      rawIndex: { $indexOfArray: [{ $literal: [...names.keys()] }, '$$line.rawName'] },
    }, in: { $let: { vars: { targetIndex: { $cond: [
      { $gte: ['$$idIndex', 0] }, '$$idIndex',
      { $cond: [{ $eq: [{ $ifNull: ['$$line.salesItemId', null] }, null] },
        { $min: [ownerIndex('$$nameIndex'), ownerIndex('$$rawIndex')] }, items.length] },
    ] } }, in: { $cond: [{ $lt: ['$$targetIndex', items.length] }, { $mergeObjects: [
      { $cond: [{ $eq: ['$$line.menuItemStatus', 'price_mismatch'] }, '$$line',
        { $arrayToObject: { $filter: { input: { $objectToArray: '$$line' }, as: 'field',
          cond: { $ne: ['$$field.k', 'priceVariancePct'] } } } }] },
      { $arrayElemAt: [{ $literal: targets }, '$$targetIndex'] },
      { menuItemStatus: { $cond: [{ $eq: ['$$line.menuItemStatus', 'price_mismatch'] }, 'price_mismatch', 'matched'] } },
    ] }, '$$line'] } } } },
  } } } } }];
  return { pipeline, names: [...names.keys()] };
};

const confirmAllNeedsReview = async (cafeId, { expectedCount }) => {
  const filter = { cafeId, reviewStatus: 'needs_review', isActive: { $ne: false } };
  const checkCount = (actual) => {
    if (actual > MAX_BULK_CONFIRM) throw bulkError(400, 'TOO_MANY_ITEMS',
      `There are ${actual} items waiting; confirm them in the list below.`, { actual, max: MAX_BULK_CONFIRM });
    if (actual !== expectedCount) throw bulkError(409, 'ITEM_COUNT_CHANGED',
      `${actual} items are waiting now, not ${expectedCount}. Review the list again.`, { expected: expectedCount, actual });
  };
  checkCount(await Item.countDocuments(filter));
  return runMenuMutation(cafeId, async (session) => {
    const items = await Item.find(filter).session(session);
    checkCount(items.length);
    for (const item of items) {
      item.reviewStatus = 'matched';
      item.isActive = true;
      // Identity and name are unchanged, so the legacy forecast stamp is a no-op.
    }
    await Item.bulkSave(items, { session });
    if (items.length) {
      const { pipeline, names } = confirmationPipeline(items);
      await Transaction.updateMany({ cafeId, $or: [
        { 'items.salesItemId': { $in: items.map((item) => item._id) } },
        { 'items.name': { $in: names } }, { 'items.rawName': { $in: names } },
      ] }, pipeline, { session });
    }
    await rebuildItemsForCafe(cafeId, { session });
    return { confirmed: items.length };
  });
};

module.exports = { markManualFields, resolveMenuItem, updateMenuItem, confirmAllNeedsReview };
