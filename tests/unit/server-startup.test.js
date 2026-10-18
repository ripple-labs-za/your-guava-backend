process.env.LOG_LEVEL = 'silent';
const { EventEmitter } = require('events');

const mockListen = jest.fn();
const mockConnectDB = jest.fn();
const mockValidateEnv = jest.fn();
const mockPaymentInit = jest.fn();
const mockTeamInvitationInit = jest.fn();
const mockUsageInit = jest.fn();
const mockTransactionInit = jest.fn();
const mockForecastInit = jest.fn();
const mockUploadInit = jest.fn();
const mockAuthSessionInit = jest.fn();
const mockPendingRegistrationInit = jest.fn();
const mockPasswordResetInit = jest.fn();
const mockGeneratedInsightInit = jest.fn();
const mockIntegrationOAuthStateInit = jest.fn();
const mockAccessAuditEventInit = jest.fn();
const mockUserInit = jest.fn();
const mockItemInit = jest.fn();
const mockImprovementInit = jest.fn();
const mockLeaveBalanceInit = jest.fn();
const mockDisconnect = jest.fn();
const mockUploadCleanup = jest.fn();
const mockUploadMaintenanceRecovery = jest.fn();
const mockPaymentReconciliation = jest.fn();
const mockUsageReconciliation = jest.fn();
const mockBillingReminders = jest.fn();
const mockMongoose = { connection: { readyState: 1 }, disconnect: mockDisconnect };

jest.mock('mongoose', () => mockMongoose);
jest.mock('../../src/app', () => ({ listen: (...args) => mockListen(...args) }));
jest.mock('../../src/config/db', () => (...args) => mockConnectDB(...args));
jest.mock('../../src/config/validateEnv', () => (...args) => mockValidateEnv(...args));
jest.mock('../../src/controllers/uploads.controller', () => ({
  cleanupAbandonedPendingUploads: mockUploadCleanup,
  recoverPendingUploadMaintenance: mockUploadMaintenanceRecovery,
}));
jest.mock('../../src/models/PaymentSession.model', () => ({ init: mockPaymentInit }));
jest.mock('../../src/models/TeamInvitation.model', () => ({ init: mockTeamInvitationInit }));
jest.mock('../../src/models/UsageLedger.model', () => ({ init: mockUsageInit }));
jest.mock('../../src/models/Transaction.model', () => ({ init: mockTransactionInit }));
jest.mock('../../src/models/Forecast.model', () => ({ init: mockForecastInit }));
jest.mock('../../src/models/Upload.model', () => ({ init: mockUploadInit }));
jest.mock('../../src/models/AuthSession.model', () => ({ init: mockAuthSessionInit }));
jest.mock('../../src/models/PendingRegistration.model', () => ({ init: mockPendingRegistrationInit }));
jest.mock('../../src/models/PasswordResetToken.model', () => ({ init: mockPasswordResetInit }));
jest.mock('../../src/models/GeneratedInsight.model', () => ({ init: mockGeneratedInsightInit }));
jest.mock('../../src/models/IntegrationOAuthState.model', () => ({ init: mockIntegrationOAuthStateInit }));
jest.mock('../../src/models/AccessAuditEvent.model', () => ({ init: mockAccessAuditEventInit }));
jest.mock('../../src/models/User.model', () => ({ init: mockUserInit }));
jest.mock('../../src/models/Item.model', () => ({ init: mockItemInit }));
jest.mock('../../src/models/Improvement.model', () => ({ init: mockImprovementInit }));
jest.mock('../../src/models/LeaveBalance.model', () => ({ init: mockLeaveBalanceInit }));
jest.mock('../../src/services/billingPayments.service', () => ({
  reconcilePendingPayments: mockPaymentReconciliation,
}));
jest.mock('../../src/services/usage.service', () => ({
  reconcileStaleUsageReservations: mockUsageReconciliation,
}));
jest.mock('../../src/services/billing/reminders', () => ({ runBillingReminders: mockBillingReminders }));

describe('server startup cleanup', () => {
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockPaymentInit.mockResolvedValue(undefined);
    mockTeamInvitationInit.mockResolvedValue(undefined);
    mockUsageInit.mockResolvedValue(undefined);
    mockTransactionInit.mockResolvedValue(undefined);
    mockForecastInit.mockResolvedValue(undefined);
    mockUploadInit.mockResolvedValue(undefined);
    mockAuthSessionInit.mockResolvedValue(undefined);
    mockPendingRegistrationInit.mockResolvedValue(undefined);
    mockPasswordResetInit.mockResolvedValue(undefined);
    mockGeneratedInsightInit.mockResolvedValue(undefined);
    mockIntegrationOAuthStateInit.mockResolvedValue(undefined);
    mockAccessAuditEventInit.mockResolvedValue(undefined);
    mockUserInit.mockResolvedValue(undefined);
    mockItemInit.mockResolvedValue(undefined);
    mockImprovementInit.mockResolvedValue(undefined);
    mockLeaveBalanceInit.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    mockUploadCleanup.mockResolvedValue({
      deleted: 0,
      storageRetried: 0,
      failed: 0,
    });
    mockUploadMaintenanceRecovery.mockResolvedValue({ completed: 0, failed: 0 });
    mockPaymentReconciliation.mockResolvedValue({ paid: 0, failed: 0, errors: 0 });
    mockUsageReconciliation.mockResolvedValue({ refunded: 0, errors: 0 });
    mockBillingReminders.mockResolvedValue({ scanned: 0, sent: 0, skipped: 0, failed: 0 });
    mockMongoose.connection.readyState = 1;
  });

  it('disconnects Mongo when a critical index fails before listen', async () => {
    mockPaymentInit.mockRejectedValue(new Error('index failed'));
    const { start } = require('../../src/server');

    await expect(start()).rejects.toThrow('index failed');
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockListen).not.toHaveBeenCalled();
  });

  it('disconnects Mongo and clears startup state when listen fails', async () => {
    const failedServer = new EventEmitter();
    failedServer.listening = false;
    mockListen.mockImplementationOnce(() => {
      queueMicrotask(() => failedServer.emit('error', new Error('port busy')));
      return failedServer;
    });
    const { start } = require('../../src/server');

    await expect(start()).rejects.toThrow('port busy');
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledTimes(1);
  });

  it('waits for every correctness and lifecycle index before accepting traffic', async () => {
    const listeningServer = new EventEmitter();
    listeningServer.listening = true;
    listeningServer.off = listeningServer.removeListener.bind(listeningServer);
    mockListen.mockImplementationOnce(() => {
      queueMicrotask(() => listeningServer.emit('listening'));
      return listeningServer;
    });
    const { start, shutdown } = require('../../src/server');

    await start();

    expect(mockBillingReminders).toHaveBeenCalledTimes(1);

    [
      mockPaymentInit,
      mockTeamInvitationInit,
      mockUsageInit,
      mockTransactionInit,
      mockForecastInit,
      mockUploadInit,
      mockAuthSessionInit,
      mockPendingRegistrationInit,
      mockPasswordResetInit,
      mockGeneratedInsightInit,
      mockIntegrationOAuthStateInit,
      mockAccessAuditEventInit,
      mockUserInit,
      mockItemInit,
      mockImprovementInit,
      mockLeaveBalanceInit,
    ].forEach((init) => expect(init).toHaveBeenCalledTimes(1));

    listeningServer.closeIdleConnections = jest.fn();
    listeningServer.close = (callback) => callback();
    await shutdown();
  });
  it('starts the event-loop monitor with the server and stops it on shutdown', async () => {
    const listeningServer = new EventEmitter();
    listeningServer.listening = true;
    listeningServer.off = listeningServer.removeListener.bind(listeningServer);
    mockListen.mockImplementationOnce(() => {
      queueMicrotask(() => listeningServer.emit('listening'));
      return listeningServer;
    });
    const { start, shutdown } = require('../../src/server');
    const { getEventLoopStats } = require('../../src/utils/eventLoopMonitor');

    await start();
    expect(getEventLoopStats().running).toBe(true);

    listeningServer.closeIdleConnections = jest.fn();
    listeningServer.close = (callback) => callback();
    await shutdown();
    expect(getEventLoopStats().running).toBe(false);
  });
  const makeListeningServer = () => {
    const server = new EventEmitter();
    server.listening = true;
    server.off = server.removeListener.bind(server);
    server.closeIdleConnections = jest.fn();
    server.closeAllConnections = jest.fn();
    return server;
  };
  const listenWith = (server) =>
    mockListen.mockImplementationOnce(() => {
      queueMicrotask(() => server.emit('listening'));
      return server;
    });
  const nextTick = () => new Promise((resolve) => setImmediate(resolve));

  it('drains in-flight requests and registered background work before disconnecting Mongo', async () => {
    const server = makeListeningServer();
    let finishInFlight;
    server.close = (callback) => { finishInFlight = callback; };
    listenWith(server);
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    let finishJob;
    let stopping;
    try {
      const { start, shutdown } = require('../../src/server');
      const lifecycle = require('../../src/utils/lifecycle');
      await start();

      lifecycle.runInBackground('menu_change_refresh', () => new Promise((resolve) => { finishJob = resolve; }));
      stopping = shutdown('SIGTERM', { exitProcess: true });
      await nextTick();

      expect(lifecycle.isDraining()).toBe(true);
      expect(mockDisconnect).not.toHaveBeenCalled();
      finishInFlight();
      await nextTick();
      expect(mockDisconnect).not.toHaveBeenCalled();
      finishJob();
      await stopping;
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      finishInFlight?.();
      finishJob?.();
      await stopping;
      exit.mockRestore();
    }
  });

  it('escalates a crash during an existing graceful drain without disconnecting twice', async () => {
    const server = makeListeningServer();
    let finishRequest;
    server.close = jest.fn((callback) => { finishRequest = callback; });
    listenWith(server);
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    let stopping;
    try {
      const { start, shutdown, installProcessHandlers } = require('../../src/server');
      jest.spyOn(require('../../src/utils/logger'), 'fatal').mockImplementation(() => {});
      await start();
      stopping = shutdown('SIGTERM', { exitProcess: true });
      const proc = new EventEmitter();
      proc.exit = jest.fn();
      installProcessHandlers({ proc });
      installProcessHandlers({ proc });
      expect(proc.listenerCount('unhandledRejection')).toBe(1);
      proc.emit('unhandledRejection', new Error('crash while draining'));
      finishRequest();
      await stopping;
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(server.close).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    } finally {
      finishRequest?.();
      await stopping;
      exit.mockRestore();
    }
  });

  it('forces connections closed and exits 1 when draining outlives SHUTDOWN_TIMEOUT_MS', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate', 'nextTick'] });
    process.env.SHUTDOWN_TIMEOUT_MS = '1000';
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      const server = makeListeningServer();
      server.close = () => {};
      listenWith(server);
      const { start, shutdown } = require('../../src/server');
      await start();
      const stopping = shutdown('SIGTERM', { exitProcess: true });
      await jest.advanceTimersByTimeAsync(1000);
      await stopping;
      expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      delete process.env.SHUTDOWN_TIMEOUT_MS;
      jest.useRealTimers();
    }
  });

  it('gives up on index initialisation after INDEX_INIT_TIMEOUT_MS instead of hanging the deploy', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate', 'nextTick'] });
    process.env.INDEX_INIT_TIMEOUT_MS = '10000';
    try {
      mockPaymentInit.mockReturnValue(new Promise(() => {}));
      const { start } = require('../../src/server');
      const started = start();
      const assertion = expect(started).rejects.toMatchObject({ code: 'INDEX_INIT_TIMEOUT' });
      await jest.advanceTimersByTimeAsync(10000);
      await assertion;
      expect(mockListen).not.toHaveBeenCalled();
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.INDEX_INIT_TIMEOUT_MS;
      jest.useRealTimers();
    }
  });

  it('logs an unhandled rejection as one fatal event and shuts down with exit code 1', async () => {
    const { installProcessHandlers } = require('../../src/server');
    const logger = require('../../src/utils/logger');
    const fatal = jest.spyOn(logger, 'fatal').mockImplementation(() => {});
    const proc = new EventEmitter();
    proc.exit = jest.fn();
    const shutdownFn = jest.fn().mockResolvedValue(undefined);
    installProcessHandlers({ proc, shutdownFn });

    proc.emit('unhandledRejection', new Error('detached job blew up'));
    // The handler logs synchronously and starts the shutdown on a later microtask.
    await nextTick();

    expect(fatal).toHaveBeenCalledWith(
      'process_unhandled_rejection',
      expect.objectContaining({ errorMessage: 'detached job blew up' })
    );
    expect(shutdownFn).toHaveBeenCalledWith('unhandled_rejection', { exitProcess: true, exitCode: 1 });
  });

  it('treats an uncaught exception the same way', async () => {
    const { installProcessHandlers } = require('../../src/server');
    const logger = require('../../src/utils/logger');
    const fatal = jest.spyOn(logger, 'fatal').mockImplementation(() => {});
    const proc = new EventEmitter();
    proc.exit = jest.fn();
    const shutdownFn = jest.fn().mockResolvedValue(undefined);
    installProcessHandlers({ proc, shutdownFn });

    proc.emit('uncaughtException', new TypeError('cannot read properties of undefined'));
    await nextTick();

    expect(fatal).toHaveBeenCalledWith(
      'process_uncaught_exception',
      expect.objectContaining({ errorName: 'TypeError' })
    );
    expect(shutdownFn).toHaveBeenCalledWith('uncaught_exception', { exitProcess: true, exitCode: 1 });
  });

  it('still exits 1 when the graceful shutdown after a crash fails', async () => {
    const { installProcessHandlers } = require('../../src/server');
    const logger = require('../../src/utils/logger');
    jest.spyOn(logger, 'fatal').mockImplementation(() => {});
    const proc = new EventEmitter();
    proc.exit = jest.fn();
    installProcessHandlers({ proc, shutdownFn: jest.fn().mockRejectedValue(new Error('disconnect hung')) });

    proc.emit('unhandledRejection', 'a string, not an Error');
    await nextTick();

    expect(proc.exit).toHaveBeenCalledWith(1);
  });

});
