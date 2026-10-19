const mongoose = require('mongoose');
const { isItemCategory } = require('../utils/itemCategory');
const Item = require('../models/Item.model');
const Organization = require('../models/Organization.model');
const {
  normalizeItemName,
  buildAliasKeys,
  findMatchCandidates,
  loadMatchCandidatePool,
  confirmAllNeedsReview,
  MAX_BULK_CONFIRM,
} = require('../services/menuItems.service');
const { resolveMenuItem, updateMenuItem } = require('../services/menuCorrections.service');
const {
  MAX_AI_REVIEW_ITEMS,
  suggestMenuItemReviews,
} = require('../services/menuItemReviewAi.service');
const { scheduleForecastRefreshAfterMenuChange } = require('../services/forecast.service');
const { clearApiCache } = require('../middleware/cache.middleware');
const { creditSnapshot } = require('../services/usage.service');
const { activeCafeId } = require('../utils/tenancy');
const { refusalBody } = require('../utils/errorCodes');
const { boundedInteger } = require('../services/parser.service');

const VALID_REVIEW_STATUSES = new Set(['matched', 'needs_review', 'ignored', 'merged']);
const MAX_RECONCILIATION_ITEMS = 100;
const MAX_ITEM_NAME_CHARS = 200;
const MAX_ALIAS_COUNT = 50;
const MAX_ALIAS_CHARS = 200;
const MAX_NOTES_CHARS = 2000;
const MAX_EXPECTED_PRICE = 1000000;
const MAX_QUERY_CHARS = 100;
const DEFAULT_ITEMS_PAGE_SIZE = 50;
const MAX_ITEMS_PAGE_SIZE = 200;
const MAX_ITEMS_PAGE = 10000;
// A total order (names are unique per cafe), served by { cafeId, reviewStatus: -1, totalSold: -1, name: 1 } (BE-03-T14).
const ITEM_LIST_SORT = { reviewStatus: -1, totalSold: -1, name: 1 };
const ITEM_LIST_PROJECTION = '-aliasKeys -manualFields -__v';
const REVIEW_STATUSES = [...VALID_REVIEW_STATUSES];
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const pageCount = (total, limit) => Math.max(1, Math.ceil(total / limit));

// One pass over the cafe's items for every number the Menu Items header shows. The page used to count the arrays it
// received, so 300 unmatched items read "Need a match 50" (WS-10-T01); needsReview and priceMismatches are the same
// definitions /items/reconciliation counts.
const itemCounts = async (cafeId) => {
  const isActive = { $ne: ['$isActive', false] };
  const [row] = await Item.aggregate([
    { $match: { cafeId: new mongoose.Types.ObjectId(String(cafeId)) } },
    {
      $group: {
        _id: null,
        ...Object.fromEntries(REVIEW_STATUSES.map((status) => [status, { $sum: { $cond: [{ $eq: ['$reviewStatus', status] }, 1, 0] } }])),
        needsReview: { $sum: { $cond: [{ $and: [isActive, { $eq: ['$reviewStatus', 'needs_review'] }] }, 1, 0] } },
        priceMismatches: {
          $sum: {
            $cond: [{
              $and: [isActive, {
                $or: [
                  { $gt: [{ $ifNull: ['$priceMismatchCount', 0] }, 0] },
                  { $ne: [{ $ifNull: ['$lastPriceMismatchAt', null] }, null] },
                ],
              }],
            }, 1, 0],
          },
        },
      },
    },
  ]);
  const counts = Object.fromEntries(REVIEW_STATUSES.map((status) => [status, row?.[status] || 0]));
  return { counts, needsReview: row?.needsReview || 0, priceMismatches: row?.priceMismatches || 0 };
};

const reconciliationFilter = (cafeId) => ({
  cafeId,
  isActive: { $ne: false },
  $or: [
    { reviewStatus: 'needs_review' },
    { priceMismatchCount: { $gt: 0 } },
    { lastPriceMismatchAt: { $ne: null } },
  ],
});

// A refusal the menu services word for the owner (MAP_TO_SELF, MAP_TO_INACTIVE_TARGET, ITEM_NAME_TAKEN) is answered here
// with its code; anything else goes to the error middleware.
const answerRefusal = (error, res, next) => {
  if (error.publicCode && error.statusCode >= 400 && error.statusCode < 500) {
    return res.status(error.statusCode).json(refusalBody(error));
  }
  return next(error);
};

const enrichReviewItems = async (cafeId, items) => {
  const enriched = [];
  const suggestionInputs = [];
  // One pool for the whole page. The candidate query is identical for every
  // review item bar the self exclusion, and running it inside the loop meant
  // up to 100 round trips returning 10,000 documents for one page load.
  const pool = items.some((item) => item.reviewStatus === 'needs_review')
    ? await loadMatchCandidatePool(cafeId)
    : [];
  for (const item of items) {
    const candidates = item.reviewStatus === 'needs_review'
      ? await findMatchCandidates(cafeId, item, { pool })
      : [];
    enriched.push({
      ...item,
      candidates: candidates.map((candidate) => ({
        item: candidate.item,
        score: Number(candidate.score.toFixed(2)),
      })),
    });
    suggestionInputs.push({ item, candidates });
  }
  return { enriched, suggestionInputs };
};

const numberOrUndefined = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const validateItemMutation = (body = {}, { allowName = true, allowStatus = true } = {}) => {
  if (allowName && body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length > MAX_ITEM_NAME_CHARS) {
      return `name must be a string no longer than ${MAX_ITEM_NAME_CHARS} characters`;
    }
  }
  if (body.category !== undefined && !isItemCategory(body.category)) {
    return 'category is invalid';
  }
  if (body.expectedPrice !== undefined) {
    const price = Number(body.expectedPrice);
    if (!Number.isFinite(price) || price < 0 || price > MAX_EXPECTED_PRICE) {
      return `expectedPrice must be between 0 and ${MAX_EXPECTED_PRICE}`;
    }
  }
  if (body.priceTolerancePct !== undefined) {
    const tolerance = Number(body.priceTolerancePct);
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) {
      return 'priceTolerancePct must be between 0 and 100';
    }
  }
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.length > MAX_ALIAS_COUNT) {
      return `aliases must contain at most ${MAX_ALIAS_COUNT} values`;
    }
    if (body.aliases.some((alias) => typeof alias !== 'string' || alias.trim().length > MAX_ALIAS_CHARS)) {
      return `aliases must be strings no longer than ${MAX_ALIAS_CHARS} characters`;
    }
  }
  if (body.notes !== undefined &&
    (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_CHARS)) {
    return `notes must be a string no longer than ${MAX_NOTES_CHARS} characters`;
  }
  if (allowStatus && body.reviewStatus !== undefined && !VALID_REVIEW_STATUSES.has(body.reviewStatus)) {
    return 'reviewStatus is invalid';
  }
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    return 'isActive must be a boolean';
  }
  return null;
};

const itemPayload = (body, { creating = false } = {}) => {
  const payload = {};
  if (body.name !== undefined) {
    payload.name = String(body.name).trim();
    payload.normalizedName = normalizeItemName(payload.name);
  }
  if (body.category !== undefined && isItemCategory(body.category)) payload.category = body.category;
  if (body.expectedPrice !== undefined) payload.expectedPrice = numberOrUndefined(body.expectedPrice);
  if (body.priceTolerancePct !== undefined) payload.priceTolerancePct = numberOrUndefined(body.priceTolerancePct);
  if (body.aliases !== undefined) {
    payload.aliases = Array.isArray(body.aliases)
      ? [...new Set(body.aliases.map((alias) => String(alias || '').trim()).filter(Boolean))]
      : [];
    payload.aliasKeys = buildAliasKeys(payload.aliases);
  }
  if (body.reviewStatus !== undefined && VALID_REVIEW_STATUSES.has(body.reviewStatus)) {
    payload.reviewStatus = body.reviewStatus;
  }
  if (body.isActive !== undefined) payload.isActive = Boolean(body.isActive);
  if (body.notes !== undefined) payload.notes = String(body.notes || '');

  if (creating) {
    payload.source = 'manual';
    payload.reviewStatus = payload.reviewStatus || 'matched';
    payload.isActive = payload.isActive ?? true;
    payload.aliases = payload.aliases || [];
    payload.aliasKeys = payload.aliasKeys || [];
  }

  return payload;
};

const list = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { q, reviewStatus, active, ids } = req.query;
    const filter = { cafeId };

    if (q && String(q).length > MAX_QUERY_CHARS) {
      return res.status(400).json({
        success: false,
        message: `q cannot exceed ${MAX_QUERY_CHARS} characters`,
      });
    }
    if (reviewStatus && !VALID_REVIEW_STATUSES.has(reviewStatus)) {
      return res.status(400).json({ success: false, message: 'reviewStatus is invalid' });
    }
    if (active !== undefined && !['true', 'false'].includes(active)) {
      return res.status(400).json({ success: false, message: 'active must be true or false' });
    }

    // Named rows, for the page to re-read edits made on other pages before they are saved (BE-03-T14 review).
    if (ids !== undefined) {
      const wanted = String(ids).split(',').filter(Boolean);
      if (wanted.length === 0 || wanted.length > MAX_ITEMS_PAGE_SIZE || !wanted.every((id) => OBJECT_ID_RE.test(id))) {
        return res.status(400).json({ success: false, message: `ids must be 1 to ${MAX_ITEMS_PAGE_SIZE} item ids` });
      }
      filter._id = { $in: wanted };
    }
    if (reviewStatus) filter.reviewStatus = reviewStatus;
    if (active === 'true') filter.isActive = { $ne: false };
    if (active === 'false') filter.isActive = false;
    if (q) {
      const regex = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: regex }, { aliases: regex }];
    }

    // One page at a time: a cafe with modifier variants and till notes has thousands of items, and the whole menu was
    // returned unprojected and sorted in memory on every Menu Items load (uploads-catalogue-26).
    const limit = boundedInteger(req.query.limit, DEFAULT_ITEMS_PAGE_SIZE, 1, MAX_ITEMS_PAGE_SIZE);
    const page = boundedInteger(req.query.page, 1, 1, MAX_ITEMS_PAGE);
    // The whole-cafe counts are a pass over every item; a caller paging through link targets sends counts=false.
    const wantsCounts = req.query.counts !== 'false';
    const [items, total, summary] = await Promise.all([
      Item.find(filter).sort(ITEM_LIST_SORT).skip((page - 1) * limit).limit(limit).select(ITEM_LIST_PROJECTION).populate('mergedInto', 'name').lean(),
      Item.countDocuments(filter),
      wantsCounts ? itemCounts(cafeId) : {},
    ]);

    return res.status(200).json({
      success: true,
      items,
      meta: { total, page, limit, pages: pageCount(total, limit), ...summary },
    });
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const validationError = validateItemMutation(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const payload = itemPayload(req.body, { creating: true });
    if (!payload.name) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }

    const existing = await Item.findOne({
      cafeId: activeCafeId(req),
      normalizedName: payload.normalizedName,
    }).lean();
    if (existing) {
      return res.status(409).json({ success: false, message: 'A menu item with this name already exists' });
    }

    const item = await Item.create({
      cafeId: activeCafeId(req),
      category: 'other',
      ...payload,
    });
    clearApiCache({ cafeId: activeCafeId(req) });

    return res.status(201).json({ success: true, item });
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const validationError = validateItemMutation(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const payload = itemPayload(req.body);
    if (payload.name === '') {
      return res.status(400).json({ success: false, message: 'name cannot be empty' });
    }

    // What the owner changed is marked theirs inside updateMenuItem, so the rebuild cannot revert it before the 200
    // is written; only a change that alters sales, prices or categories refreshes the forecasts (BE-03-T10).
    const { item, changed } = await updateMenuItem(activeCafeId(req), req.params.id, payload);
    if (changed.identity || changed.price || changed.category) {
      await scheduleForecastRefreshAfterMenuChange(activeCafeId(req));
      clearApiCache({ cafeId: activeCafeId(req) });
    }

    return res.status(200).json({ success: true, item });
  } catch (error) {
    return answerRefusal(error, res, next);
  }
};

const reconciliation = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const limit = boundedInteger(req.query.limit, DEFAULT_ITEMS_PAGE_SIZE, 1, MAX_RECONCILIATION_ITEMS);
    const page = boundedInteger(req.query.page, 1, 1, MAX_ITEMS_PAGE);
    const filter = reconciliationFilter(cafeId);
    // Counted against the collection, not against the page. Derived from the
    // truncated page, "needs review: 50" was the limit rather than the backlog:
    // an owner cleared all 50, reloaded, saw 50 again and had no way to tell
    // whether they were making progress.
    // name is the last tie-break, so pages of the queue never overlap or skip an item (BE-03-T14).
    const [items, total, needsReview, priceMismatches] = await Promise.all([
      Item.find(filter)
        .sort({ reviewStatus: -1, lastPriceMismatchAt: -1, totalSold: -1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Item.countDocuments(filter),
      Item.countDocuments({ ...filter, reviewStatus: 'needs_review' }),
      Item.countDocuments({
        cafeId,
        isActive: { $ne: false },
        $or: [{ priceMismatchCount: { $gt: 0 } }, { lastPriceMismatchAt: { $ne: null } }],
      }),
    ]);

    const { enriched, suggestionInputs } = await enrichReviewItems(cafeId, items);

    const suggestions = await suggestMenuItemReviews(cafeId, suggestionInputs, {
      useAi: false,
    });
    suggestions.forEach((suggestion, index) => {
      enriched[index].aiSuggestion = suggestion;
    });

    return res.status(200).json({
      success: true,
      items: enriched,
      meta: {
        needsReview,
        priceMismatches,
        returned: enriched.length,
        limit,
        paidAiUsed: false,
        total,
        page,
        pages: pageCount(total, limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

const generateReconciliationSuggestions = async (req, res, next) => {
  const { abortWhenResponseCloses } = require('../utils/requestAbort');
  const requestAbort = abortWhenResponseCloses(res);
  try {
    const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        message: 'Idempotency-Key is required for paid AI requests',
      });
    }
    if (idempotencyKey.length > 120) {
      return res.status(400).json({
        success: false,
        message: 'Idempotency-Key is too long',
      });
    }
    const itemIds = Array.isArray(req.body.itemIds) ? [...new Set(req.body.itemIds.map(String))] : [];
    if (itemIds.length === 0) {
      return res.status(400).json({ success: false, message: 'itemIds is required' });
    }
    if (itemIds.length > MAX_AI_REVIEW_ITEMS) {
      return res.status(400).json({
        success: false,
        message: `A maximum of ${MAX_AI_REVIEW_ITEMS} menu items can be reviewed at once`,
      });
    }
    if (itemIds.some((id) => !mongoose.isValidObjectId(id))) {
      return res.status(400).json({ success: false, message: 'itemIds contains an invalid item id' });
    }

    const cafeId = activeCafeId(req);
    const items = await Item.find({
      ...reconciliationFilter(cafeId),
      _id: { $in: itemIds },
    }).lean();
    const byId = new Map(items.map((item) => [String(item._id), item]));
    const orderedItems = itemIds.map((id) => byId.get(id)).filter(Boolean);
    if (orderedItems.length !== itemIds.length) {
      return res.status(404).json({ success: false, message: 'One or more review items were not found' });
    }

    const { enriched, suggestionInputs } = await enrichReviewItems(cafeId, orderedItems);
    const suggestions = await suggestMenuItemReviews(cafeId, suggestionInputs, {
      orgId: req.user.orgId,
      userId: req.user.id,
      useAi: true,
      idempotencyPrefix: `menu-review:${req.user.id}:${idempotencyKey}`,
      signal: requestAbort.signal,
      requestId: req.id,
    });
    if (requestAbort.signal.aborted || res.destroyed) return;
    suggestions.forEach((suggestion, index) => {
      const {
        guavaCredits: _credits,
        ...publicSuggestion
      } = suggestion;
      enriched[index].aiSuggestion = publicSuggestion;
    });
    const paidAiCount = suggestions.filter((suggestion) => suggestion.source === 'ai').length;
    const creditsCharged = suggestions.reduce(
      (sum, suggestion) => sum + (Number(suggestion.aiCreditsCharged) || 0),
      0
    );
    const organization = await Organization.findById(req.user.orgId);

    return res.status(200).json({
      success: true,
      items: enriched,
      guavaCredits: organization ? creditSnapshot(organization) : null,
      meta: {
        requested: itemIds.length,
        paidAiUsed: paidAiCount > 0,
        paidAiCount,
        creditsCharged,
      },
    });
  } catch (error) {
    if (requestAbort.signal.aborted || res.destroyed) return;
    next(error);
  } finally {
    requestAbort.dispose();
  }
};

const resolve = async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!['confirm', 'map_to', 'ignore'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid resolve action' });
    }
    const validationError = validateItemMutation(req.body, { allowName: false, allowStatus: false });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    if (action === 'map_to' && !mongoose.isValidObjectId(req.body.targetItemId)) {
      return res.status(400).json({ success: false, message: 'targetItemId is invalid' });
    }

    const item = await resolveMenuItem(activeCafeId(req), req.params.id, req.body);
    await scheduleForecastRefreshAfterMenuChange(activeCafeId(req));
    clearApiCache({ cafeId: activeCafeId(req) });
    return res.status(200).json({ success: true, item });
  } catch (error) {
    return answerRefusal(error, res, next);
  }
};

const confirmAllNew = async (req, res, next) => {
  try {
    const expectedCount = req.body?.expectedCount;
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > MAX_BULK_CONFIRM) {
      return res.status(400).json({ success: false, message: `expectedCount must be a whole number from 1 to ${MAX_BULK_CONFIRM}` });
    }
    const cafeId = activeCafeId(req);
    const { confirmed } = await confirmAllNeedsReview(cafeId, { expectedCount });
    await scheduleForecastRefreshAfterMenuChange(cafeId);
    clearApiCache({ cafeId });
    const { counts, needsReview } = await itemCounts(cafeId);
    return res.status(200).json({ success: true, confirmed, meta: { needsReview, counts } });
  } catch (error) { return next(error); }
};

module.exports = {
  confirmAllNew,
  create,
  generateReconciliationSuggestions,
  list,
  reconciliation,
  resolve,
  update,
};
