const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { setSourceRowNumbers } = require('./rowErrors');

const refusal = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
const aborted = () => refusal('Upload was cancelled', 499, 'UPLOAD_ABORTED');
const resourceError = () => refusal('This file could not be parsed within the available resources. '
  + 'Export a smaller file and upload it again.', 413, 'UPLOAD_PARSE_RESOURCE_LIMIT');

// Only two heaps can exist at once. Queued requests retain their original input, without spawning a worker.
class ParserPool {
  constructor({ workerFile = path.join(__dirname, 'worker.js'), concurrency = 2, maxQueue = 8,
    timeoutMs = 30000, maxOldGenerationSizeMb = 256 } = {}) {
    this.workerFile = workerFile;
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.timeoutMs = timeoutMs;
    this.heapMb = maxOldGenerationSizeMb;
    this.active = 0;
    this.queue = [];
    this.jobs = new Set();
    this.closed = false;
  }

  stats() { return { active: this.active, queued: this.queue.length }; }

  run(task, buffer, options = {}) {
    const { signal, timeoutMs = this.timeoutMs, ...taskOptions } = options;
    if (signal?.aborted || this.closed) return Promise.reject(aborted());
    if (this.active >= this.concurrency && this.queue.length >= this.maxQueue) {
      return Promise.reject(refusal('Too many uploads are being parsed. Try again shortly.', 413, 'UPLOAD_PARSE_BUSY'));
    }
    return new Promise((resolve, reject) => {
      const job = { task, buffer, taskOptions, started: false, settled: false };
      job.finish = async (error, result) => {
        if (job.settled) return;
        job.settled = true;
        clearTimeout(job.timer);
        signal?.removeEventListener('abort', job.cancel);
        this.queue = this.queue.filter((candidate) => candidate !== job);
        // Await termination before resolving or starting the next upload: no orphaned or excess worker heap.
        try { if (job.worker) await job.worker.terminate(); } finally {
          if (job.started) this.active -= 1;
          this.jobs.delete(job);
          if (error) reject(error); else resolve(result);
          this.pump();
        }
      };
      job.cancel = () => { void job.finish(aborted()); };
      job.timer = setTimeout(() => { void job.finish(refusal('This file took too long to parse. '
        + 'Export a smaller file and upload it again.', 413, 'UPLOAD_PARSE_TIMEOUT')); }, timeoutMs);
      signal?.addEventListener('abort', job.cancel, { once: true });
      this.jobs.add(job);
      this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    while (!this.closed && this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job.settled) continue;
      job.started = true;
      this.active += 1;
      try {
        job.worker = new Worker(this.workerFile, { workerData: { task: job.task, buffer: job.buffer, options: job.taskOptions },
          resourceLimits: { maxOldGenerationSizeMb: this.heapMb, maxYoungGenerationSizeMb: 32 } });
        job.worker.once('message', ({ result, sources = {}, error }) => {
          if (error) { void job.finish(Object.assign(new Error(error.message), error)); return; }
          for (const field of ['rows', 'sampleRows']) {
            for (const row of result[field] || []) {
              if (row.date && typeof row.date.getTime === 'function') row.date = new Date(row.date.getTime());
            }
            for (const [index, numbers] of (sources[field] || []).entries()) {
              if (numbers) setSourceRowNumbers(result[field][index], numbers);
            }
          }
          if (result.dateRange) {
            for (const key of ['firstDate', 'lastDate']) {
              const value = result.dateRange[key];
              if (value && typeof value.getTime === 'function') result.dateRange[key] = new Date(value.getTime());
            }
          }
          void job.finish(null, result);
        });
        job.worker.once('error', () => { void job.finish(resourceError()); });
        job.worker.once('exit', () => { if (!job.settled) void job.finish(resourceError()); });
      } catch { void job.finish(resourceError()); }
    }
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.jobs].map((job) => job.finish(aborted())));
  }
}

const pool = new ParserPool();
const runParserTask = (task, buffer, options) => pool.run(task, buffer, options);

// A normal incoming-request close means the body was consumed; only abort or an unfinished response close cancels.
const withRequestAbort = async (req, res, run) => {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const closed = () => { if (!res.writableEnded) cancel(); };
  req.once('aborted', cancel);
  res.once('close', closed);
  if (req.aborted) cancel();
  try { return await run(controller.signal); } finally {
    req.removeListener('aborted', cancel);
    res.removeListener('close', closed);
  }
};

module.exports = { ParserPool, runParserTask, withRequestAbort };
