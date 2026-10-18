const { runInBackground } = require('./lifecycle');
const logger = require('./logger');
/**
 * Work that must not decide how long a response takes (identity-4): the handler answers first and the task runs on a later
 * turn of the event loop. Failures are logged, never thrown into the request. Tests and graceful shutdown await
 * settleAfterResponse(). One process (D-005), so an in-memory set is enough.
 */
const pending = new Set();

const runAfterResponse = (label, task) => {
  const promise = runInBackground(`after_response:${label}`, async () => {
    try {
      await task();
    } catch (error) {
      logger.error('after_response_failed', { label, ...logger.errorFields(error) });
    }
  }).finally(() => pending.delete(promise));
  pending.add(promise);
  return promise;
};

const settleAfterResponse = async () => {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
};

const pendingAfterResponseCount = () => pending.size;

module.exports = { runAfterResponse, settleAfterResponse, pendingAfterResponseCount };
