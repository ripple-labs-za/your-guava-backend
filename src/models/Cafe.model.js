const mongoose = require('mongoose');

const cafeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    location: {
      address: { type: String, maxlength: 240 },
      addressLine2: { type: String, maxlength: 240 },
      suburb: { type: String, maxlength: 120 },
      city: { type: String, maxlength: 120 },
      postalCode: { type: String, maxlength: 24 },
      province: { type: String, maxlength: 120 },
      country: { type: String, default: 'South Africa', maxlength: 120 },
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
    },
    yocoConnected: {
      type: Boolean,
      default: false,
    },
    yocoTokens: {
      accessToken: { type: String, select: false },
      refreshToken: { type: String, select: false },
      expiresAt: Date,
    },
    yocoBusinessId: String,
    yocoLocationId: String,
    yocoWebhookSubscriptionId: String,
    timezone: {
      type: String,
      default: 'Africa/Johannesburg',
    },
    tradingHours: {
      type: [
        new mongoose.Schema(
          {
            dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
            isOpen: { type: Boolean, default: true },
            openTime: { type: String, default: '07:00' },
            closeTime: { type: String, default: '17:00' },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    dataUploaded: {
      type: Boolean,
      default: false,
    },
    // Incremented as the first write of every transaction that rebuilds menu items (an import, an upload delete, a menu
    // edit). Two such transactions for one cafe write the same document, so MongoDB lets only one proceed and retries the
    // other on a fresh snapshot. Nothing reads the number; the write is the lock (BE-03-T12).
    menuRevision: { type: Number, default: 0 },
    savedColumnMapping: {
      type: new mongoose.Schema(
        {
          receiptId: { type: String },
          date: { type: String },
          time: { type: String },
          items: { type: String },
          total: { type: String },
          tip: { type: String },
          discount: { type: String },
          paymentMethod: { type: String },
          status: { type: String },
          quantity: { type: String },
          itemsMode: { type: String, enum: ['packed', 'line-per-row'] },
          // Where this mapping came from. A saved mapping only imports without asking when a new file has this same header
          // row; before, a mapping that half-fitted a different export was applied silently (BE-03-T05).
          sourceHeaders: { type: [String], default: undefined },
          savedAt: { type: Date },
          sourceUploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload' },
          sourceFileName: { type: String },
        },
        { _id: false }
      ),
      default: undefined,
    },
    forecastInputsVersion: { type: Number, default: 0 },
    forecastSettings: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    lastSyncAt: {
      type: Date,
    },
    // Archived locations keep all their data but leave quotas, lists and access (identity-8). Null means active.
    archivedAt: { type: Date, default: null },
    archivedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    accountingIntegrations: {
      xero: {
        connected: { type: Boolean, default: false },
        accessToken: { type: String, select: false },
        refreshToken: { type: String, select: false },
        tenantId: { type: String },
        expiresAt: { type: Date },
        connectedAt: { type: Date },
        lastSyncAt: { type: Date },
        lastSyncStatus: { type: String, enum: ['success', 'failed', null], default: null },
        lastSyncError: { type: String },
        lastSyncedThrough: { type: Date },
      },
      quickbooks: {
        connected: { type: Boolean, default: false },
        accessToken: { type: String, select: false },
        refreshToken: { type: String, select: false },
        realmId: { type: String },
        expiresAt: { type: Date },
        connectedAt: { type: Date },
        lastSyncAt: { type: Date },
        lastSyncStatus: { type: String, enum: ['success', 'failed', null], default: null },
        lastSyncError: { type: String },
        lastSyncedThrough: { type: Date },
      },
      sage: {
        connected: { type: Boolean, default: false },
        accessToken: { type: String, select: false },
        refreshToken: { type: String, select: false },
        businessId: { type: String },
        expiresAt: { type: Date },
        connectedAt: { type: Date },
        lastSyncAt: { type: Date },
        lastSyncStatus: { type: String, enum: ['success', 'failed', null], default: null },
        lastSyncError: { type: String },
        lastSyncedThrough: { type: Date },
      },
    },
  },
  { timestamps: true }
);

cafeSchema.index({ orgId: 1, createdAt: 1 });
cafeSchema.index({ orgId: 1, archivedAt: 1 });
// Connected business lookup is deliberately non-unique: ambiguity is refused by the webhook.
cafeSchema.index({ yocoBusinessId: 1 }, { partialFilterExpression: { yocoBusinessId: { $type: 'string' } } });

const { readAndUpgradeSecret } = require('../services/secrets.service');

const CAFE_SECRET_PATHS = Object.freeze([
  'yocoTokens.accessToken',
  'yocoTokens.refreshToken',
  ...['xero', 'quickbooks', 'sage'].flatMap((provider) => [
    `accountingIntegrations.${provider}.accessToken`,
    `accountingIntegrations.${provider}.refreshToken`,
  ]),
]);
const SECRET_PATH_SET = new Set(CAFE_SECRET_PATHS);

const valueAt = (cafe, path) => (typeof cafe?.get === 'function'
  ? cafe.get(path)
  : path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), cafe));

cafeSchema.static('secretPaths', () => [...CAFE_SECRET_PATHS]);

/**
 * Reads a stored provider token, re-sealing it under the current key when it is plaintext, a v1
 * envelope or sealed with the previous key (workforce-integrations-10). The caller must have selected the
 * path (tokens are select: false).
 */
cafeSchema.static('readSecret', function readSecret(cafe, path) {
  if (!SECRET_PATH_SET.has(path)) throw new TypeError(`Not a stored secret path: ${path}`);
  return readAndUpgradeSecret({ model: this, filter: { _id: cafe._id }, path, stored: valueAt(cafe, path) });
});

module.exports = mongoose.model('Cafe', cafeSchema);
