const logger = require('../../src/utils/logger');
const {
  startEventLoopMonitor, stopEventLoopMonitor, getEventLoopStats,
} = require('../../src/utils/eventLoopMonitor');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Hold the event loop the way a quadratic regex or a big synchronous parse does.
const stallFor = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* busy */ }
};

afterEach(() => stopEventLoopMonitor());

describe('event-loop lag monitor', () => {
  it('reports p50, p99 and max for each window, and sees a stall', async () => {
    const windows = [];
    startEventLoopMonitor({ intervalMs: 200, log: (entry) => windows.push(entry) });
    await sleep(50);
    stallFor(120);
    await sleep(400);
    expect(windows.length).toBeGreaterThanOrEqual(1);
    expect(windows[0]).toEqual(expect.objectContaining({
      p50Ms: expect.any(Number), p99Ms: expect.any(Number), maxMs: expect.any(Number),
      samples: expect.any(Number), windowMs: expect.any(Number), endedAt: expect.any(String),
    }));
    expect(Math.max(...windows.map((entry) => entry.maxMs))).toBeGreaterThanOrEqual(100);
  });

  it('exposes the last window and the one in progress', async () => {
    expect(getEventLoopStats()).toEqual({ running: false, lastWindow: null, current: null });
    startEventLoopMonitor({ intervalMs: 100, log: () => {} });
    await sleep(250);
    const stats = getEventLoopStats();
    expect(stats.running).toBe(true);
    expect(stats.lastWindow).toEqual(expect.objectContaining({ p99Ms: expect.any(Number) }));
    expect(stats.current).toEqual(expect.objectContaining({ windowMs: expect.any(Number) }));
    stopEventLoopMonitor();
    expect(getEventLoopStats().running).toBe(false);
  });

  it('writes one structured event_loop_lag line per window by default, as a warning when p99 passes 200 ms', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    startEventLoopMonitor({ intervalMs: 100 });
    await sleep(30);
    stallFor(260);
    await sleep(250);
    const lines = [...info.mock.calls, ...warn.mock.calls].map(([event, fields]) => ({ event, ...fields }));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((line) => line.event === 'event_loop_lag')).toBe(true);
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(1);
    info.mockRestore();
    warn.mockRestore();
  });

  it('starts once however often it is asked, and restarts after a stop', () => {
    startEventLoopMonitor({ intervalMs: 1000, log: () => {} });
    startEventLoopMonitor({ intervalMs: 1000, log: () => {} });
    expect(getEventLoopStats().running).toBe(true);
    stopEventLoopMonitor();
    startEventLoopMonitor({ intervalMs: 1000, log: () => {} });
    expect(getEventLoopStats().running).toBe(true);
  });

  it('answers before the first window without throwing', () => {
    startEventLoopMonitor({ intervalMs: 60_000, log: () => {} });
    const stats = getEventLoopStats();
    expect(stats.lastWindow).toBeNull();
    expect(stats.current).toEqual(expect.objectContaining({ p50Ms: expect.any(Number), samples: expect.any(Number) }));
  });
});
