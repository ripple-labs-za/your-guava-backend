jest.mock('../../src/migrations/index', () => []);
jest.mock('../../src/models/Migration.model', () => ({
  findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
}));

const Migration = require('../../src/models/Migration.model');
const logger = require('../../src/utils/logger');
const lifecycle = require('../../src/utils/lifecycle');
const { runStartupMigrations } = require('../../src/migrations/runner');

describe('startup migration lease waits', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    lifecycle.resetLifecycleForTests();
    jest.clearAllMocks();
    for (const level of ['info', 'warn', 'debug', 'error']) {
      jest.spyOn(logger, level).mockImplementation(() => {});
    }
    Migration.findOneAndUpdate.mockResolvedValue(null);
    Migration.updateOne.mockResolvedValue({ modifiedCount: 1 });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    lifecycle.resetLifecycleForTests();
    jest.restoreAllMocks();
  });

  const pending = () => ({
    name: 'lease-wait', kind: 'contract', mode: 'auto',
    check: jest.fn().mockResolvedValue({ pending: true, detail: 'pending' }),
    up: jest.fn(),
  });

  it('settles tracked startup promptly when draining begins during a long lease wait', async () => {
    const migration = pending();
    const run = runStartupMigrations({ migrations: [migration], retryDelayMs: 5000 });
    lifecycle.trackBackground('startup_migrations', run);
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledWith('migration_locked', { name: migration.name });
    lifecycle.markDraining();
    let drained = false;
    const drain = lifecycle.drainBackgroundWork().then(() => { drained = true; });
    await jest.advanceTimersByTimeAsync(100);
    expect(drained).toBe(true);
    await drain;
    expect(Migration.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(migration.up).not.toHaveBeenCalled();
    expect(lifecycle.pendingBackgroundWork()).toEqual([]);
  });

  it('spaces live lease retries and warns only on the first lock', async () => {
    const migration = pending();
    const expires = Date.now() + 300;
    let acquired = false;
    Migration.findOneAndUpdate.mockImplementation(async () => {
      if (Date.now() <= expires) return null;
      acquired = true;
      return { attempts: 2, startedAt: new Date() };
    });
    migration.check.mockImplementation(async () => ({ pending: !acquired, detail: 'lease' }));
    const run = runStartupMigrations({ migrations: [migration], retryDelayMs: 100 });
    await jest.advanceTimersByTimeAsync(450);
    const result = await run;
    expect(result.verified).toEqual([migration.name]);
    const locks = [logger.warn, logger.debug].flatMap((log) =>
      log.mock.calls.filter(([event]) => event === 'migration_locked'));
    expect(locks.length).toBeGreaterThanOrEqual(3);
    expect(locks.length).toBeLessThanOrEqual(5);
    expect(logger.warn.mock.calls.filter(([event]) => event === 'migration_locked')).toHaveLength(1);
    expect(logger.debug.mock.calls.filter(([event]) => event === 'migration_locked').length).toBeGreaterThanOrEqual(2);
    expect(migration.up).not.toHaveBeenCalled();
  });

  it('returns a failed migration immediately without retrying it', async () => {
    const migration = pending();
    Migration.findOneAndUpdate.mockResolvedValue({ attempts: 1, startedAt: new Date() });
    migration.up.mockRejectedValueOnce(new Error('cannot build index'))
      .mockImplementation(() => new Promise(() => {}));
    let result;
    const run = runStartupMigrations({ migrations: [migration], retryDelayMs: 100 })
      .then((value) => { result = value; });
    await jest.advanceTimersByTimeAsync(350);
    expect(result).toMatchObject({ failed: [migration.name], locked: [] });
    await run;
    expect(migration.up).toHaveBeenCalledTimes(1);
    expect(Migration.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
