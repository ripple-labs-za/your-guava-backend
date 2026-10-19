// Shared by ingestion and its worker: preview reads no models or persistence services.
const { readCsv } = require('./csv');
const { readWorkbook } = require('./xlsx');
const { assertSupportedFileBuffer } = require('./fileType');

const PREVIEW_ROWS = 5;
const previewBuffer = async (buffer, fileExt = 'csv') => {
  assertSupportedFileBuffer(buffer, fileExt);
  if (fileExt === 'xlsx') {
    // Keep the sheet's own headings even when it has no data rows.
    const { headers, rows } = await readWorkbook(buffer);
    return { headers, sampleRows: rows.slice(0, PREVIEW_ROWS) };
  }
  const { headers, rows } = await readCsv(buffer, { limit: PREVIEW_ROWS });
  return { headers, sampleRows: rows };
};

module.exports = { previewBuffer };
