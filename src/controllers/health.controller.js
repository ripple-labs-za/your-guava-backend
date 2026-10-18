const { isDraining } = require('../utils/lifecycle');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { sha256Hex } = require('../utils/authPrimitives');
const mongoose = require('mongoose');
const { getEventLoopStats } = require('../utils/eventLoopMonitor');
const packageJson = require('../../package.json');
const r2 = require('../services/r2.service');
const validateEnv = require('../config/validateEnv');
const email = require('../services/email.service');
const paymentProvider = require('../services/paymentProvider.service');

const DB_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

const requiredEnvNames = () => [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'MONGODB_URI',
  ...(process.env.NODE_ENV === 'production'
    ? ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
    : []),
];

const databaseCapability = async () => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return { ok: false, transactionCapable: false };
  }
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const transactionCapable = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    return {
      ok: transactionCapable,
      transactionCapable,
      topology: hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replica_set' : 'standalone',
    };
  } catch (error) {
    return { ok: false, transactionCapable: false, state: 'probe_failed' };
  }
};

const basePayload = (req) => ({
  service: 'your-guava-api',
  version: packageJson.version,
  environment: process.env.NODE_ENV || 'development',
  uptimeSeconds: Math.round(process.uptime()),
  requestId: req.id,
});

// Informational: one instance (D-005) must not take itself out of rotation
// because the loop was busy, so ok is always true; `degraded` says whether
// the last complete window's p99 passed 200 ms.
const EVENT_LOOP_DEGRADED_P99_MS = 200;

const eventLoopCheck = () => {
  const { running, lastWindow, current } = getEventLoopStats();
  const window = lastWindow || current;
  return {
    ok: true,
    running,
    p50Ms: window ? window.p50Ms : null,
    p99Ms: window ? window.p99Ms : null,
    maxMs: window ? window.maxMs : null,
    windowMs: window ? window.windowMs : null,
    degraded: Boolean(lastWindow && lastWindow.p99Ms > EVENT_LOOP_DEGRADED_P99_MS),
  };
};

const READINESS_CACHE_MS = 5000;
let anonymousReadiness = null; // { at, promise } shared by concurrent anonymous callers

const digest = (value) => Buffer.from(sha256Hex(value), 'hex');

// Details are for operators: a 32+ character READINESS_TOKEN sent as X-Readiness-Token (security-11, platform-13).
const hasReadinessToken = (req) => {
  const expected = process.env.READINESS_TOKEN;
  const supplied = req.get('x-readiness-token');
  if (!expected || expected.length < 32 || typeof supplied !== 'string' || supplied.length === 0) return false;
  return crypto.timingSafeEqual(digest(supplied), digest(expected));
};

const computeReadiness = async () => {
  const databaseState = DB_STATES[mongoose.connection.readyState] || 'unknown';
  const database = await databaseCapability();
  const required = requiredEnvNames();
  const storage = r2.getConfigurationStatus();
  let environmentValid = true;
  try {
    validateEnv();
  } catch (error) {
    environmentValid = false;
  }
  const checks = {
    database: { ...database, state: databaseState },
    environment: {
      ok: environmentValid && required.every((key) => Boolean(process.env[key])),
      state: environmentValid ? 'valid' : 'invalid',
      required,
    },
    storage: { ok: storage.ok, configured: storage.configured, mode: storage.mode, missing: storage.missing },
    // Capability, not env presence (BE-00): a deploy that cannot email a verification link is not ready.
    email: email.deliveryCapability(),
    payments: paymentProvider.paymentCapability(),
    eventLoop: eventLoopCheck(),
  };
  return { ready: Object.values(checks).every((check) => check.ok), checks };
};

// Anonymous callers share one computation per 5 s, so a flood cannot run validateEnv and an admin command per request.
const anonymousReadinessResult = () => {
  const now = Date.now();
  if (!anonymousReadiness || now - anonymousReadiness.at >= READINESS_CACHE_MS) {
    // A probe that throws is "not ready", never a rejected promise that every caller in the window would inherit as a 500.
    anonymousReadiness = { at: now, promise: computeReadiness().then((result) => result.ready).catch(() => false) };
  }
  return anonymousReadiness.promise;
};

const health = (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    message: 'Your Guava API is running',
    service: 'your-guava-api',
    requestId: req.id,
    ...(hasReadinessToken(req) ? basePayload(req) : {}),
  });
};

const readiness = async (req, res) => {
  if (isDraining()) return res.status(503).json({ success: false, status: 'draining', requestId: req.id });
  if (hasReadinessToken(req)) {
    let result;
    try {
      result = await computeReadiness();
    } catch (error) {
      logger.error('readiness_probe_failed', logger.errorFields(error));
      return res.status(503).json({ success: false, status: 'not_ready', ...basePayload(req), checks: null, probe: 'failed' });
    }
    return res.status(result.ready ? 200 : 503).json({
      success: result.ready,
      status: result.ready ? 'ready' : 'not_ready',
      ...basePayload(req),
      checks: result.checks,
    });
  }
  const ready = await anonymousReadinessResult();
  return res.status(ready ? 200 : 503).json({ success: ready, status: ready ? 'ready' : 'not_ready', requestId: req.id });
};

const _resetReadinessCache = () => {
  anonymousReadiness = null;
};

module.exports = {
  health,
  readiness,
  _resetReadinessCache,
};
