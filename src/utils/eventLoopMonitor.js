const logger = require('./logger');
/**
 * How long the event loop waits before it can run the next callback.
 *
 * Every cafe shares one Node process (D-005), so a stall anywhere is a stall
 * for everyone: a quadratic regex, a synchronous parse, a big JSON response.
 * /api/health answers from the loop it would be measuring, so it cannot see
 * this. The histogram samples every `resolutionMs`; each `intervalMs` the
 * window's p50, p99 and max go to one structured log line, and /api/ready
 * exposes the last window and the one in progress.
 */
const { monitorEventLoopDelay } = require('node:perf_hooks');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_RESOLUTION_MS = 20;
const WARN_P99_MS = 200;

let histogram = null;
let timer = null;
let windowStartedAt = 0;
let lastWindow = null;

// Nanoseconds to milliseconds, one decimal.
const toMs = (ns) => (Number.isFinite(ns) ? Math.round(ns / 1e5) / 10 : 0);

const summarise = (source, windowMs) => {
  const sampled = source.count > 0;
  return {
    p50Ms: sampled ? toMs(source.percentile(50)) : 0,
    p99Ms: sampled ? toMs(source.percentile(99)) : 0,
    maxMs: sampled ? toMs(source.max) : 0,
    samples: source.count,
    windowMs,
    endedAt: new Date().toISOString(),
  };
};

const defaultLog = (entry) => {
  const level = entry.p99Ms > WARN_P99_MS ? 'warn' : 'info';
  if (level === 'warn') logger.warn('event_loop_lag', entry);
  else logger.info('event_loop_lag', entry);
};

const startEventLoopMonitor = ({
  intervalMs = DEFAULT_INTERVAL_MS, resolutionMs = DEFAULT_RESOLUTION_MS, log = defaultLog,
} = {}) => {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  windowStartedAt = Date.now();
  timer = setInterval(() => {
    lastWindow = summarise(histogram, Date.now() - windowStartedAt);
    histogram.reset();
    windowStartedAt = Date.now();
    log(lastWindow);
  }, intervalMs);
  // Never the reason the process stays up.
  timer.unref();
};

const stopEventLoopMonitor = () => {
  if (timer) clearInterval(timer);
  if (histogram) histogram.disable();
  histogram = null;
  timer = null;
  windowStartedAt = 0;
  lastWindow = null;
};

const getEventLoopStats = () => ({
  running: Boolean(histogram),
  lastWindow,
  current: histogram ? summarise(histogram, Date.now() - windowStartedAt) : null,
});

module.exports = { startEventLoopMonitor, stopEventLoopMonitor, getEventLoopStats };
