const logger = require('./utils/logger');
const {
  drainBackgroundWork,
  markDraining,
  pendingBackgroundWork,
  withDeadline,
} = require('./utils/lifecycle');
require('dotenv').config();
const paymentProvider = require('./services/paymentProvider.service');
const { startEventLoopMonitor, stopEventLoopMonitor } = require('./utils/eventLoopMonitor');

process.env.TZ = process.env.TZ || process.env.DEFAULT_TIMEZONE || 'Africa/Johannesburg';

const mongoose = require('mongoose');
const app = require('./app');
const connectDB = require('./config/db');
const validateEnv = require('./config/validateEnv');
const { boundedInteger } = require('./services/parser.service');
const {
  cleanupAbandonedPendingUploads,
  recoverPendingUploadMaintenance,
} = require('./controllers/uploads.controller');
const PaymentSession = require('./models/PaymentSession.model');
const TeamInvitation = require('./models/TeamInvitation.model');
const UsageLedger = require('./models/UsageLedger.model');
const Transaction = require('./models/Transaction.model');
const Forecast = require('./models/Forecast.model');
const Upload = require('./models/Upload.model');
const AuthSession = require('./models/AuthSession.model');
const PendingRegistration = require('./models/PendingRegistration.model');
const PasswordResetToken = require('./models/PasswordResetToken.model');
const GeneratedInsight = require('./models/GeneratedInsight.model');
const IntegrationOAuthState = require('./models/IntegrationOAuthState.model');
const AccessAuditEvent = require('./models/AccessAuditEvent.model');
const User = require('./models/User.model');
const Item = require('./models/Item.model');
const Improvement = require('./models/Improvement.model');
const LeaveBalance = require('./models/LeaveBalance.model');
const { reconcilePendingPayments } = require('./services/billingPayments.service');
const { reconcileStaleUsageReservations } = require('./services/usage.service');

const PORT = process.env.PORT || 5000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS = 60 * 1000;
const DEFAULT_USAGE_RECONCILIATION_INTERVAL_MS = 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10 * 1000;
const DEFAULT_INDEX_INIT_TIMEOUT_MS = 90 * 1000;

let httpServer;
let cleanupTimer;
let cleanupPromise;
let paymentReconciliationTimer;
let paymentReconciliationPromise;
let usageReconciliationTimer;
let usageReconciliationPromise;
let shutdownPromise;
let shutdownExitCode = 0;
let shutdownExitRequested = false;

const runPendingUploadCleanup = () => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    try {
      const [summary, maintenance] = await Promise.all([
        cleanupAbandonedPendingUploads(),
        recoverPendingUploadMaintenance(),
      ]);
      if (summary.deleted > 0 || summary.storageRetried > 0 || summary.failed > 0) {
        logger.info('upload_cleanup_summary', summary);
      }
      if (maintenance.completed > 0 || maintenance.failed > 0) {
        logger.info('upload_maintenance_recovery_summary', maintenance);
      }
    } catch (error) {
      logger.error('upload_cleanup_failed', logger.errorFields(error));
    }
  })().finally(() => {
    cleanupPromise = undefined;
  });
  return cleanupPromise;
};

const schedulePendingUploadCleanup = () => {
  void runPendingUploadCleanup();
  const intervalMs = boundedInteger(
    process.env.UPLOAD_CLEANUP_INTERVAL_MS,
    DEFAULT_CLEANUP_INTERVAL_MS,
    5 * 60 * 1000,
    24 * 60 * 60 * 1000
  );
  cleanupTimer = setInterval(() => void runPendingUploadCleanup(), intervalMs);
  cleanupTimer.unref();
};

const runPaymentReconciliation = () => {
  if (paymentReconciliationPromise) return paymentReconciliationPromise;
  if (!paymentProvider.isHostedCheckoutEnabled()) return Promise.resolve();
  paymentReconciliationPromise = (async () => {
    try {
      const summary = await reconcilePendingPayments();
      if (summary.paid > 0 || summary.failed > 0 || summary.errors > 0) {
        logger.info('payment_reconcile_summary', summary);
      }
    } catch (error) {
      logger.error('payment_reconcile_sweep_failed', logger.errorFields(error));
    }
  })().finally(() => {
    paymentReconciliationPromise = undefined;
  });
  return paymentReconciliationPromise;
};

const schedulePaymentReconciliation = () => {
  if (!paymentProvider.isHostedCheckoutEnabled()) return;
  void runPaymentReconciliation();
  const intervalMs = boundedInteger(
    process.env.PAYMENT_RECONCILIATION_INTERVAL_MS,
    DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS,
    30 * 1000,
    60 * 60 * 1000
  );
  paymentReconciliationTimer = setInterval(() => void runPaymentReconciliation(), intervalMs);
  paymentReconciliationTimer.unref();
};

const runUsageReconciliation = () => {
  if (usageReconciliationPromise) return usageReconciliationPromise;
  usageReconciliationPromise = (async () => {
    try {
      const summary = await reconcileStaleUsageReservations();
      if (summary.refunded > 0 || summary.errors > 0) {
        logger.info('usage_reconcile_summary', summary);
      }
    } catch (error) {
      logger.error('usage_reconcile_sweep_failed', logger.errorFields(error));
    }
  })().finally(() => {
    usageReconciliationPromise = undefined;
  });
  return usageReconciliationPromise;
};

const scheduleUsageReconciliation = () => {
  void runUsageReconciliation();
  const intervalMs = boundedInteger(
    process.env.USAGE_RECONCILIATION_INTERVAL_MS,
    DEFAULT_USAGE_RECONCILIATION_INTERVAL_MS,
    30 * 1000,
    60 * 60 * 1000
  );
  usageReconciliationTimer = setInterval(() => void runUsageReconciliation(), intervalMs);
  usageReconciliationTimer.unref();
};

const { runBillingReminders } = require('./services/billing/reminders');
let billingReminderTimer;
let billingReminderPromise;
const runBillingReminderJob = () => {
  if (billingReminderPromise) return billingReminderPromise;
  billingReminderPromise = (async () => {
    try {
      const summary = await runBillingReminders();
      if (summary.sent > 0 || summary.failed > 0) logger.info('billing_reminder_summary', summary);
    } catch (error) {
      logger.error('billing_reminder_sweep_failed', logger.errorFields(error));
    }
  })().finally(() => { billingReminderPromise = undefined; });
  return billingReminderPromise;
};
const scheduleBillingReminders = () => {
  void runBillingReminderJob();
  const intervalMs = boundedInteger(process.env.BILLING_REMINDER_INTERVAL_MS, 60 * 60 * 1000, 5 * 60 * 1000, 24 * 60 * 60 * 1000);
  billingReminderTimer = setInterval(() => void runBillingReminderJob(), intervalMs);
  billingReminderTimer.unref();
};

const cleanupFailedStart = async () => {
  const partialServer = httpServer;
  httpServer = undefined;
  if (partialServer?.listening) {
    await new Promise((resolve) => partialServer.close(() => resolve()));
  }
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
};

const start = async () => {
  if (httpServer) return httpServer;
  try {
    validateEnv();
    await connectDB();
    // Correctness, lifecycle cleanup, and exactly-once guarantees depend on
    // these indexes. Do not accept traffic until MongoDB confirms they exist.
    const indexTimeoutMs = boundedInteger(process.env.INDEX_INIT_TIMEOUT_MS, DEFAULT_INDEX_INIT_TIMEOUT_MS, 10000, 600000);
    try {
      await withDeadline(Promise.all([
        PaymentSession.init(),
        TeamInvitation.init(),
        UsageLedger.init(),
        Transaction.init(),
        Forecast.init(),
        Upload.init(),
        AuthSession.init(),
        PendingRegistration.init(),
        PasswordResetToken.init(),
        GeneratedInsight.init(),
        IntegrationOAuthState.init(),
        AccessAuditEvent.init(),
        User.init(),
        Item.init(),
        Improvement.init(),
        LeaveBalance.init(),
      ]), indexTimeoutMs, 'index initialisation');
    } catch (error) {
      if (error.code !== 'DEADLINE_EXCEEDED') throw error;
      logger.error('index_init_timeout', { timeoutMs: indexTimeoutMs });
      throw Object.assign(new Error(`index initialisation exceeded ${indexTimeoutMs}ms`), { code: 'INDEX_INIT_TIMEOUT' });
    }
    httpServer = app.listen(PORT);
    const candidateServer = httpServer;
    await new Promise((resolve, reject) => {
      const onListening = () => {
        candidateServer.off('error', onError);
        resolve();
      };
      const onError = (error) => {
        candidateServer.off('listening', onListening);
        reject(error);
      };
      candidateServer.once('listening', onListening);
      candidateServer.once('error', onError);
    });
    logger.info('server_listening', { port: Number(PORT), env: process.env.NODE_ENV || 'development' });
    schedulePendingUploadCleanup();
    schedulePaymentReconciliation();
    scheduleUsageReconciliation();
    scheduleBillingReminders();
    // The loop's own lag, logged per window and shown on /api/ready. Started
    // here, not in app.js, so suites that load the app never start an interval.
    startEventLoopMonitor({
      intervalMs: boundedInteger(process.env.EVENT_LOOP_LOG_INTERVAL_MS, 60 * 1000, 5 * 1000, 60 * 60 * 1000),
    });
    return httpServer;
  } catch (error) {
    try {
      await cleanupFailedStart();
    } catch (cleanupError) {
      logger.error('startup_cleanup_failed', logger.errorFields(cleanupError));
    }
    throw error;
  }
};

const shutdown = (signal = 'shutdown', { exitProcess = false, exitCode } = {}) => {
  if (exitProcess) shutdownExitRequested = true;
  if (exitCode) shutdownExitCode = exitCode;
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const startedAt = Date.now();
    markDraining();
    logger.info('shutdown_started', { signal });
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (paymentReconciliationTimer) clearInterval(paymentReconciliationTimer);
    if (usageReconciliationTimer) clearInterval(usageReconciliationTimer);
    if (billingReminderTimer) clearInterval(billingReminderTimer);
    stopEventLoopMonitor();

    const timeoutMs = boundedInteger(
      process.env.SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      1000,
      60 * 1000
    );
    let timedOut = false;
    let timeoutHandle;
    let idleConnectionSweep;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (typeof httpServer?.closeAllConnections === 'function') httpServer.closeAllConnections();
        resolve();
      }, timeoutMs);
      timeoutHandle.unref();
    });
    const closeResources = (async () => {
      if (httpServer) {
        const server = httpServer;
        const closeIdle = () => {
          if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        };
        // A request active at SIGTERM becomes idle later. Reap it then too,
        // rather than waiting for keepAliveTimeout to consume the drain budget.
        idleConnectionSweep = setInterval(closeIdle, 50);
        idleConnectionSweep.unref();
        try {
          const closed = new Promise((resolve) => server.close(() => resolve()));
          closeIdle();
          await closed;
        } finally {
          clearInterval(idleConnectionSweep);
        }
      }
      await Promise.allSettled(
        [cleanupPromise, paymentReconciliationPromise, usageReconciliationPromise, billingReminderPromise].filter(Boolean)
      );
      await drainBackgroundWork();
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    })();

    try {
      await Promise.race([closeResources, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
      clearInterval(idleConnectionSweep);
    }
    if (timedOut) {
      logger.error('shutdown_timeout', { signal, timeoutMs, pendingBackground: pendingBackgroundWork() });
    } else {
      logger.info('shutdown_complete', { signal, durationMs: Date.now() - startedAt });
    }
    if (shutdownExitRequested) process.exit(shutdownExitCode || (timedOut ? 1 : 0));
  })();
  return shutdownPromise;
};

// Node 24 exits on an unhandled rejection. Log one structured fatal line, then
// drain as for SIGTERM (bounded by SHUTDOWN_TIMEOUT_MS) and exit 1, so Railway's
// ALWAYS policy restarts a clean process and the log says why it died.
const handledProcesses = new WeakSet();
const installProcessHandlers = ({ proc = process, shutdownFn = shutdown } = {}) => {
  if (handledProcesses.has(proc)) return;
  handledProcesses.add(proc);
  const fatal = (kind) => (reason) => {
    logger.fatal(`process_${kind}`, logger.errorFields(reason, { stack: true }));
    try {
      Promise.resolve(shutdownFn(kind, { exitProcess: true, exitCode: 1 })).catch(() => proc.exit(1));
    } catch (_error) {
      proc.exit(1);
    }
  };
  proc.on('unhandledRejection', fatal('unhandled_rejection'));
  proc.on('uncaughtException', fatal('uncaught_exception'));
};

if (require.main === module) {
  installProcessHandlers();
  start().catch((error) => {
    logger.fatal('startup_failed', logger.errorFields(error, { stack: true }));
    process.exit(1);
  });
  const shutdownForSignal = (signal) => {
    void shutdown(signal, { exitProcess: true }).catch((error) => {
      logger.fatal('shutdown_failed', logger.errorFields(error, { stack: true }));
      process.exit(1);
    });
  };
  process.once('SIGTERM', () => shutdownForSignal('SIGTERM'));
  process.once('SIGINT', () => shutdownForSignal('SIGINT'));
}

module.exports = { start, shutdown, installProcessHandlers };
