const mongoose = require('mongoose');
const { ITEM_CATEGORIES } = require('../utils/itemCategory');

const itemSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
    },
    name: {
      type: String,
      required: true,
      maxlength: 200,
    },
    normalizedName: {
      type: String,
    },
    aliases: [{ type: String, maxlength: 200 }],
    aliasKeys: [{ type: String, maxlength: 200 }],
    category: {
      type: String,
      enum: [...ITEM_CATEGORIES],
      default: 'other',
    },
    expectedPrice: {
      type: Number,
      min: 0,
      max: 1000000,
    },
    priceTolerancePct: {
      type: Number,
      default: 10,
      min: 0,
      max: 100,
    },
    reviewStatus: {
      type: String,
      enum: ['matched', 'needs_review', 'ignored', 'merged'],
      default: 'needs_review',
    },
    source: {
      type: String,
      enum: ['manual', 'pos', 'imported', 'system'],
      default: 'imported',
    },
    avgPrice: {
      type: Number,
    },
    observedPriceMin: { type: Number },
    observedPriceMax: { type: Number },
    lastObservedPrice: { type: Number },
    lastSeenAt: { type: Date },
    firstSeenAt: { type: Date },
    lastPriceMismatchAt: { type: Date },
    priceMismatchCount: { type: Number, default: 0 },
    notes: { type: String, maxlength: 2000 },
    mergedInto: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Item',
    },
    // Fields the owner set by hand on the Menu Items page. Every import runs
    // rebuildItemsForCafe, which relearns category, price and aliases from
    // sales -- and used to overwrite the owner's correction before the saving
    // request had even answered, so a wrong alias could not be removed and a
    // learned price could not be cleared. A field named here is off-limits to
    // the rebuild. 'name' records a rename (BE-03-T10): the rebuild keeps a
    // renamed item's name anyway, but the orphan clean-up must never delete an
    // item the owner has named.
    manualFields: [{
      type: String,
      enum: ['category', 'expectedPrice', 'aliases', 'name'],
    }],
    isActive: {
      type: Boolean,
      default: true,
    },
    totalSold: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

itemSchema.index({ cafeId: 1, name: 1 }, { unique: true });
itemSchema.index({ cafeId: 1, normalizedName: 1 });
itemSchema.index({ cafeId: 1, aliasKeys: 1 });
// The reconciliation queue's candidate pool: matched items, most-sold first.
// Without it the sort was an in-memory blocking sort of the cafe's whole menu,
// run once per review item on the page.
itemSchema.index({ cafeId: 1, reviewStatus: 1, totalSold: -1 });

module.exports = mongoose.model('Item', itemSchema);
