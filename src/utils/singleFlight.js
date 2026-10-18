/**
 * Concurrent callers with the same key share one in-flight call. In-process only, which D-005 (one
 * instance) makes sufficient; callers that write shared state still use a compare-and-set for the
 * brief overlap of a deploy.
 */
const inFlight = new Map();

// Exclusive lifecycle operations queue behind the current flight and cannot be
// joined as though their result were a refreshed token. Later refreshes wait too.
const singleFlight = (key, run, { exclusive = false } = {}) => {
  const existing = inFlight.get(key);
  if (existing && existing.shareable && !exclusive) return existing.promise;
  const entry = { shareable: !exclusive };
  const promise = (existing ? existing.promise.catch(() => {}) : Promise.resolve())
    .then(run)
    .finally(() => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    });
  entry.promise = promise;
  inFlight.set(key, entry);
  return promise;
};

module.exports = { singleFlight };
