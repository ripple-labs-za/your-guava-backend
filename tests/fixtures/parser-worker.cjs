const { parentPort, workerData, resourceLimits } = require('node:worker_threads');
if (workerData.task === 'crash') throw new Error('private worker crash details');
if (workerData.task === 'hang') setInterval(() => {}, 100);
if (workerData.task === 'echo') parentPort.postMessage({ result: {
  value: Buffer.from(workerData.buffer).toString(), limits: resourceLimits,
} });
