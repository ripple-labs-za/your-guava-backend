const mongoose = require('mongoose');

/**
 * BE-03-T13. Mongoose builds the indexes a schema declares but never drops one it stopped declaring, so each database
 * that ran an earlier build keeps paying for these on every import. Drops only when the index that covers it exists.
 *
 *   node src/migrations/align-import-indexes.js          # dry run: lists what would be dropped
 *   node src/migrations/align-import-indexes.js --apply  # creates the declared indexes, then drops the legacy ones
 *
 * BE-10-T02 registers it as a contract migration; until then it runs by hand at GATE-03.
 */
const LEGACY_INDEXES = [
  { model: 'Transaction', key: { cafeId: 1 }, coveredBy: { cafeId: 1, date: -1 } },
  { model: 'Transaction', key: { uploadId: 1 }, coveredBy: { cafeId: 1, uploadId: 1, date: -1 } },
  { model: 'Transaction', key: { date: 1 }, coveredBy: { cafeId: 1, date: -1 } },
  { model: 'Upload', key: { cafeId: 1 }, coveredBy: { cafeId: 1, createdAt: -1 } },
  { model: 'Upload', key: { status: 1 }, coveredBy: { status: 1, updatedAt: 1 } },
  { model: 'Upload', key: { fileFingerprint: 1 }, coveredBy: null },
  { model: 'Upload', key: { cafeId: 1, fileFingerprint: 1, createdAt: -1 }, coveredBy: null },
  { model: 'Item', key: { normalizedName: 1 }, coveredBy: { cafeId: 1, normalizedName: 1 } },
  { model: 'Item', key: { reviewStatus: 1 }, coveredBy: { cafeId: 1, reviewStatus: 1, totalSold: -1 } },
  { model: 'UsageLedger', key: { orgId: 1 }, coveredBy: { orgId: 1, createdAt: -1 } },
  { model: 'UsageLedger', key: { cafeId: 1 }, coveredBy: null },
  { model: 'UsageLedger', key: { userId: 1 }, coveredBy: null },
  { model: 'UsageLedger', key: { featureKey: 1 }, coveredBy: null },
  { model: 'UsageLedger', key: { status: 1 }, coveredBy: { status: 1, reservedAt: 1 } },
];
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const modelOf = (name) => require(`../models/${name}.model`);

// A dry run counts an index the schema declares as covering: --apply creates the declared set before it drops anything.
const inspect = async ({ countDeclared = false } = {}) => {
  const found = [];
  for (const entry of LEGACY_INDEXES) {
    const model = modelOf(entry.model);
    const indexes = await model.collection.indexes().catch(() => []);
    const declared = countDeclared ? model.schema.indexes().map(([key]) => ({ key })) : [];
    const legacy = indexes.find((index) => sameKey(index.key, entry.key));
    if (legacy) {
      found.push({
        ...entry,
        name: legacy.name,
        covered: !entry.coveredBy || [...indexes, ...declared].some((index) => sameKey(index.key, entry.coveredBy)),
      });
    }
  }
  return found;
};

module.exports = {
  name: 'align-import-indexes',
  description: 'Create the import query indexes and drop the single-field indexes they replace (BE-03-T13).',
  kind: 'contract',
  mode: 'auto',
  LEGACY_INDEXES,
  async check() {
    const found = await inspect();
    return { pending: found.length > 0, detail: found.map((entry) => `${entry.model}.${entry.name}`).join(', ') || 'none' };
  },
  async up({ dryRun = false } = {}) {
    const models = [...new Set(LEGACY_INDEXES.map((entry) => entry.model))].map(modelOf);
    if (!dryRun) for (const model of models) await model.createIndexes(); // the declared set first: nothing is dropped uncovered
    const dropped = [];
    for (const entry of await inspect({ countDeclared: dryRun })) {
      if (!entry.covered) throw new Error(`Refusing to drop ${entry.model}.${entry.name}: ${JSON.stringify(entry.coveredBy)} is missing`);
      if (!dryRun) await modelOf(entry.model).collection.dropIndex(entry.name);
      dropped.push(`${entry.model}.${entry.name}`);
    }
    return { dropped, dryRun };
  },
};

if (require.main === module) {
  // dotenv only when run as a script: requiring this module (tests, BE-10-T02's runner) must not read a .env.
  require('dotenv').config();
  (async () => {
    const apply = process.argv.includes('--apply');
    await mongoose.connect(process.env.MONGODB_URI);
    const result = await module.exports.up({ dryRun: !apply });
    console.log(`${apply ? 'APPLIED' : 'DRY RUN - nothing changed'}: ${result.dropped.join(', ') || 'no legacy indexes'}`);
    await mongoose.disconnect();
  })().catch((error) => { console.error(error); process.exit(1); });
}
