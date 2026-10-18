const fs = require('fs');
const path = require('path');
const lifecycle = require('../../src/utils/lifecycle');
const logger = require('../../src/utils/logger');

const SRC_ROOT = path.resolve(__dirname, '../../src');
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

describe('background work registry', () => {
  afterEach(() => {
    lifecycle.resetLifecycleForTests();
    jest.restoreAllMocks();
  });

  it('runs scheduled work on a later tick, not inside the request that scheduled it', async () => {
    const task = jest.fn().mockResolvedValue(undefined);
    const done = lifecycle.runInBackground('probe', task);
    expect(task).not.toHaveBeenCalled();
    await done;
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('drains work that is still running, including work registered while draining', async () => {
    const first = deferred();
    const second = deferred();
    lifecycle.runInBackground('first', () => first.promise);
    let drained = false;
    const drain = lifecycle.drainBackgroundWork().then(() => { drained = true; });
    await nextTick();
    lifecycle.runInBackground('second', () => second.promise);
    first.resolve();
    await nextTick();
    await nextTick();
    expect(drained).toBe(false);
    second.resolve();
    await drain;
    expect(lifecycle.pendingBackgroundWork()).toEqual([]);
  });

  it('logs a failed background job with its name and never rejects', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await expect(
      lifecycle.runInBackground('menu_change_refresh', async () => { throw new Error('mongo blip'); })
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'background_job_failed',
      expect.objectContaining({ job: 'menu_change_refresh', errorMessage: 'mongo blip' })
    );
  });

  it('tracks an already-started promise so shutdown waits for it', async () => {
    const job = deferred();
    lifecycle.trackBackground('forecast_invalidation', job.promise);
    expect(lifecycle.pendingBackgroundWork().map((entry) => entry.name)).toEqual(['forecast_invalidation']);
    job.resolve();
    await lifecycle.drainBackgroundWork();
    expect(lifecycle.pendingBackgroundWork()).toEqual([]);
  });

  it('reports pending work by name and age for the shutdown timeout log', () => {
    lifecycle.trackBackground('slow_job', new Promise(() => {}));
    const [entry] = lifecycle.pendingBackgroundWork();
    expect(entry.name).toBe('slow_job');
    expect(entry.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('marks the process as draining', () => {
    expect(lifecycle.isDraining()).toBe(false);
    lifecycle.markDraining();
    expect(lifecycle.isDraining()).toBe(true);
  });

  it('rejects with DEADLINE_EXCEEDED when work outlives its deadline', async () => {
    jest.useFakeTimers();
    try {
      const pending = lifecycle.withDeadline(new Promise(() => {}), 1000, 'index initialisation');
      const assertion = expect(pending).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
      await jest.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolves with the value when work finishes before its deadline', async () => {
    await expect(lifecycle.withDeadline(Promise.resolve('built'), 1000, 'x')).resolves.toBe('built');
  });

  it('is the only module in src that schedules detached work with setImmediate', () => {
    const offenders = walk(SRC_ROOT)
      .filter((file) => !file.endsWith(path.join('utils', 'lifecycle.js')))
      .filter((file) => {
        // An awaited cooperative yield in forecast generation is not detached work.
        const source = fs.readFileSync(file, 'utf8').replace(
          'await new Promise((resolve) => setImmediate(resolve));', ''
        );
        return /setImmediate\(/.test(source);
      })
      .map((file) => path.relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
