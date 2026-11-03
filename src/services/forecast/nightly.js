// L-2: the nightly learning job. For every cafe with sales, once per closed cafe-local day: score the closed days
// against what was sold, keep the observed weather for each of them (W-1), and regenerate the coming week so the plan
// carries the newest calibration. In-process and idempotent: each cafe-day is claimed through a unique JobRun key, so it
// runs once however many ticks (or processes) see it. Railway runs one replica; the key would hold with more.
const logger = require('../../utils/logger');
const Cafe = require('../../models/Cafe.model');
const JobRun = require('../../models/JobRun.model');
const { addZonedDays, getZonedDateParts, safeTimezone, zonedDateKey, zonedDayStart } = require('../../utils/timezone');
const { observeWeatherForDay } = require('../weather.service');
const { updateForecastActualsForRange } = require('./actuals');
const { generateForecastsForDates } = require('./generate');

// The job runs 01:00-05:00 cafe-local (Orchy 3 Nov): after the day has closed, before the cafe opens. A deploy during
// trading hours never starts a catch-up; a missed night is caught up by the next night's week of catch-up.
const NIGHTLY_LOCAL_HOUR = 1;
const NIGHTLY_END_HOUR = 5;
// A unit that keeps throwing is retried with backoff (30 min, then 60), then left to the next night's key.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 30 * 60 * 1000;
// A missed night (deploy, outage) is caught up: the last week is scored and its observed weather filled in.
const CATCH_UP_DAYS = 7;
const PLAN_DAYS = 7;
// A claim still "running" after this is an abandoned run (a restart mid-run) and may be taken again.
const STALE_RUNNING_MS = 60 * 60 * 1000;
const CAFE_PAGE_SIZE = 200;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const runKey = (cafeId, dateKey) => `nightly:${cafeId}:${dateKey}`;

/** True when this call now owns the key. A done key, or one running and fresh, is never taken. */
const claimRun = async (key, now) => {
  try {
    const claimed = await JobRun.findOneAndUpdate(
      { key, attempts: { $lt: MAX_ATTEMPTS }, $or: [
        { status: 'failed', $or: [{ retryAfter: null }, { retryAfter: { $lte: now } }] },
        { status: 'running', startedAt: { $lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
      ] },
      { $set: { status: 'running', startedAt: now, finishedAt: null, error: null, retryAfter: null }, $inc: { attempts: 1 } },
      { upsert: true, new: true }
    );
    return Boolean(claimed);
  } catch (error) {
    // The key exists and is done or running: the upsert's insert met the unique index.
    if (error?.code === 11000) return false;
    throw error;
  }
};

const finishRun = (key, status, fields) => JobRun.updateOne(
  { key }, { $set: { status, finishedAt: new Date(), ...fields } }
).catch((error) => logger.warn('nightly_finish_failed', logger.errorFields(error)));

const runNightlyForCafe = async (cafe, now = new Date()) => {
  const timezone = safeTimezone(cafe.timezone);
  const todayStart = zonedDayStart(now, timezone);
  const yesterdayStart = addZonedDays(todayStart, -1, timezone);
  const key = runKey(cafe._id, zonedDateKey(yesterdayStart, timezone));
  if (!(await claimRun(key, now))) return { status: 'skipped' };
  try {
    // 1. Score: closed days only (the range function never scores today).
    const scoring = await updateForecastActualsForRange(
      cafe._id, addZonedDays(todayStart, -CATCH_UP_DAYS, timezone), yesterdayStart, { timezone }
    );
    // 2. Observed weather for each closed day of the week that does not have it yet.
    const weather = {};
    for (let back = CATCH_UP_DAYS; back >= 1; back -= 1) {
      const result = await observeWeatherForDay(cafe, zonedDateKey(addZonedDays(todayStart, -back, timezone), timezone));
      weather[result.status] = (weather[result.status] || 0) + 1;
    }
    // 3. Recalibrate: the coming week is rebuilt from the newest scored days and the observed weather.
    const days = Array.from({ length: PLAN_DAYS }, (_, offset) => addZonedDays(todayStart, offset, timezone));
    const plan = await generateForecastsForDates(cafe._id, days, { origin: 'live' });
    const summary = {
      scored: scoring.scored || 0, cleared: scoring.cleared || 0, weather,
      regenerated: plan?.forecasts?.length || 0, failures: plan?.failures?.length || 0,
    };
    await finishRun(key, 'done', { summary });
    return { status: 'done', summary };
  } catch (error) {
    const attempts = (await JobRun.findOne({ key }).select('attempts').lean())?.attempts || 1;
    await finishRun(key, 'failed', {
      error: String(error?.message || error).slice(0, 500),
      retryAfter: new Date(now.getTime() + RETRY_BACKOFF_MS * 2 ** (attempts - 1)),
    });
    logger.error('nightly_cafe_failed', { cafeId: String(cafe._id), ...logger.errorFields(error) });
    return { status: 'failed' };
  }
};

/** One tick: every cafe with sales whose local night is inside the window, paged in _id order so none is starved. */
const runNightlyLearning = async ({ now = new Date() } = {}) => {
  const summary = { cafes: 0, done: 0, skipped: 0, failed: 0, waiting: 0 };
  let afterId = null;
  for (;;) {
    const cafes = await Cafe.find({ archivedAt: null, dataUploaded: true, ...(afterId ? { _id: { $gt: afterId } } : {}) })
      .select('_id timezone location orgId').sort({ _id: 1 }).limit(CAFE_PAGE_SIZE).lean();
    if (cafes.length === 0) break;
    afterId = cafes[cafes.length - 1]._id;
    for (const cafe of cafes) {
      summary.cafes += 1;
      const parts = getZonedDateParts(now, safeTimezone(cafe.timezone));
      if (!parts || parts.hour < NIGHTLY_LOCAL_HOUR || parts.hour >= NIGHTLY_END_HOUR) {
        summary.waiting += 1;
        continue;
      }
      const result = await runNightlyForCafe(cafe, now);
      summary[result.status] += 1;
      // One cafe's catch-up is several aggregations and a week's regeneration: let requests in between cafes.
      await yieldToEventLoop();
    }
    if (cafes.length < CAFE_PAGE_SIZE) break;
  }
  return summary;
};

module.exports = {
  runNightlyLearning, runNightlyForCafe, claimRun, runKey, NIGHTLY_LOCAL_HOUR, NIGHTLY_END_HOUR, MAX_ATTEMPTS, CATCH_UP_DAYS, PLAN_DAYS,
};
