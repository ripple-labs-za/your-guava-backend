const { parentPort, workerData } = require('node:worker_threads');
const { SOURCE_ROW_NUMBERS } = require('./rowErrors');

(async () => {
  try {
    const { task, options } = workerData;
    const buffer = Buffer.from(workerData.buffer);
    let result;
    if (task === 'parse') result = await require('./parse').parseBuffer(buffer, options);
    else if (task === 'preview') result = await require('./preview').previewBuffer(buffer, options.fileExt);
    else throw Object.assign(new Error('Unknown parser task'), { statusCode: 400 });
    // Structured clone omits non-enumerable source-row metadata; carry and restore it explicitly.
    const sources = Object.fromEntries(['rows', 'sampleRows'].map((field) =>
      [field, (result[field] || []).map((row) => row[SOURCE_ROW_NUMBERS] || null)]));
    parentPort.postMessage({ result, sources });
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, statusCode: error.statusCode,
      publicCode: error.publicCode, code: error.code } });
  }
})();
