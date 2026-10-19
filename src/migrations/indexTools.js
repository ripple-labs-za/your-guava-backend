// Index keys are ordered: {cafeId, receiptId} and {receiptId, cafeId} are different indexes.
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const declaredIndexes = (Model) => Model.schema.indexes().map(([key, options = {}]) => ({ key, options }));

const listIndexesSafe = async (collection) => {
  try {
    return await collection.indexes();
  } catch (error) {
    if (error.code === 26 || error.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
};

// Contract step: drop `key` only when at least one replacement already exists.
const dropIndexIfPresent = async (collection, key, { requireOneOf = [] } = {}) => {
  const live = await listIndexesSafe(collection);
  const target = live.find((index) => sameKey(index.key, key));
  if (!target) return false;
  const replaced = requireOneOf.length === 0
    || requireOneOf.some((wanted) => live.some((index) => sameKey(index.key, wanted)));
  if (!replaced) {
    throw new Error(`refusing to drop ${target.name}: its replacement index does not exist`);
  }
  await collection.dropIndex(target.name);
  return true;
};

module.exports = { sameKey, declaredIndexes, listIndexesSafe, dropIndexIfPresent };
