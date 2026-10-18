const cache = require('../middleware/cache.middleware');

/** One per-cafe invalidation for uploads and POS syncs, even if the insight write fails. */
const invalidateDerivedViews = async (cafeId) => {
  if (!cafeId) return;
  try {
    // Lazy: the AI barrel must not load its SDK client when the importers load.
    const { invalidateInsights } = require('./anthropic.service');
    if (typeof invalidateInsights === 'function') await invalidateInsights(cafeId);
  } finally {
    cache.clearApiCache({ cafeId: String(cafeId) });
  }
};

module.exports = { invalidateDerivedViews };
