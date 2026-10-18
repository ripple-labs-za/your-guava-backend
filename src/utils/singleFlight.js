/**
 * Concurrent callers with the same key share one in-flight call. In-process only, which D-005 (one
 * instance) makes sufficient; callers that write shared state still use a compare-and-set for the
 * brief overlap of a deploy.
 */
const inFlight = new Map();

const singleFlight = (key, run) => {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve()
    .then(run)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
};

module.exports = { singleFlight };
