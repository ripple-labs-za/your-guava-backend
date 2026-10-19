const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ParserPool, runParserTask, withRequestAbort } = require('../../src/services/parser/runInWorker');
const { parseBuffer } = require('../../src/services/parser.service');
const { SOURCE_ROW_NUMBERS } = require('../../src/services/parser/rowErrors');

const pools = [];
const pool = (options = {}) => {
  const value = new ParserPool({ workerFile: path.join(__dirname, '../fixtures/parser-worker.cjs'),
    concurrency: 1, maxQueue: 2, timeoutMs: 5000, maxOldGenerationSizeMb: 64, ...options });
  pools.push(value);
  return value;
};
afterEach(async () => { await Promise.all(pools.splice(0).map((p) => p.close())); });
jest.setTimeout(20000);

it('a crashed worker returns a bounded resource refusal, leaves no worker, and releases the next queued upload', async () => {
  const p = pool();
  const crashed = p.run('crash', Buffer.alloc(0));
  const next = p.run('echo', Buffer.from('next'));
  await expect(crashed).rejects.toMatchObject({ statusCode: 413 });
  await expect(next).resolves.toMatchObject({ value: 'next', limits: { maxOldGenerationSizeMb: 64 } });
  expect(p.stats()).toEqual({ active: 0, queued: 0 });
});

it('a timeout terminates the worker before rejecting and clears its queue slot', async () => {
  const p = pool({ timeoutMs: 5 });
  await expect(p.run('hang', Buffer.alloc(0))).rejects.toMatchObject({ statusCode: 413, code: 'UPLOAD_PARSE_TIMEOUT' });
  expect(p.stats()).toEqual({ active: 0, queued: 0 });
});

it('a cancelled active upload terminates its worker and removes request listeners', async () => {
  const p = pool();
  const req = new EventEmitter();
  const res = new EventEmitter();
  const pending = withRequestAbort(req, res, (signal) => p.run('hang', Buffer.alloc(0), { signal }));
  res.emit('close');
  await expect(pending).rejects.toMatchObject({ statusCode: 499, code: 'UPLOAD_ABORTED' });
  expect(p.stats()).toEqual({ active: 0, queued: 0 });
  expect(req.listenerCount('aborted')).toBe(0);
  expect(res.listenerCount('close')).toBe(0);
});

it('queued cancellation removes the queued buffer without multiplying worker heaps', async () => {
  const p = pool();
  const firstAbort = new AbortController();
  const first = p.run('hang', Buffer.alloc(0), { signal: firstAbort.signal });
  const queuedAbort = new AbortController();
  const second = p.run('echo', Buffer.from('queued'), { signal: queuedAbort.signal });
  expect(p.stats()).toEqual({ active: 1, queued: 1 });
  queuedAbort.abort();
  await expect(second).rejects.toMatchObject({ statusCode: 499 });
  expect(p.stats()).toEqual({ active: 1, queued: 0 });
  firstAbort.abort();
  await expect(first).rejects.toMatchObject({ statusCode: 499 });
  expect(p.stats()).toEqual({ active: 0, queued: 0 });
});

it('worker parsing preserves dates, source rows, non-enumerability and client error codes', async () => {
  const buffer = Buffer.from('Receipt,Date,Time,Items,Total\nA,2026-01-05,08:00,1 x Latte,38\n');
  const options = { columnMapping: { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' },
    timezone: 'Africa/Johannesburg' };
  const direct = await parseBuffer(buffer, options);
  const isolated = await runParserTask('parse', buffer, options);
  expect(isolated).toEqual(direct);
  expect(isolated.rows[0].date).toBeInstanceOf(Date);
  expect(isolated.rows[0][SOURCE_ROW_NUMBERS]).toEqual(direct.rows[0][SOURCE_ROW_NUMBERS]);
  expect(Object.keys(isolated.rows[0])).not.toContain(SOURCE_ROW_NUMBERS);
  await expect(runParserTask('parse', Buffer.from('not a workbook'), { ...options, fileExt: 'xlsx' }))
    .rejects.toMatchObject({ statusCode: 400 });
});
