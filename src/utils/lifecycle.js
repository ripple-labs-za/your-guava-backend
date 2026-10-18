const logger = require('./logger');

/**
 * Process lifecycle state shared by server.js, readiness and every piece of
 * detached work. Work a request starts and does not await must be registered
 * here, or a SIGTERM disconnects Mongo underneath it (tests-ops-17).
 */
const state = { draining: false };
const background = new Map();
let nextId = 0;

const register = (name, promise) => {
  nextId += 1;
  const id = nextId;
  const tracked = Promise.resolve(promise)
    .then(() => undefined)
    .catch((error) => {
      logger.error('background_job_failed', { job: name, ...logger.errorFields(error) });
    })
    .finally(() => background.delete(id));
  background.set(id, { name, startedAt: Date.now(), promise: tracked });
  return tracked;
};

const runInBackground = (name, task) =>
  register(name, new Promise((resolve) => setImmediate(resolve)).then(() => task()));

const trackBackground = (name, promise) => register(name, promise);

const drainBackgroundWork = async () => {
  while (background.size > 0) {
    await Promise.allSettled([...background.values()].map((entry) => entry.promise));
  }
};

const pendingBackgroundWork = () =>
  [...background.values()].map(({ name, startedAt }) => ({ name, ageMs: Date.now() - startedAt }));

const markDraining = () => { state.draining = true; };
const isDraining = () => state.draining;

const withDeadline = (promise, ms, label) => {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} exceeded ${ms}ms`);
      error.code = 'DEADLINE_EXCEEDED';
      reject(error);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

const resetLifecycleForTests = () => {
  state.draining = false;
  background.clear();
};

module.exports = {
  runInBackground,
  trackBackground,
  drainBackgroundWork,
  pendingBackgroundWork,
  markDraining,
  isDraining,
  withDeadline,
  resetLifecycleForTests,
};
