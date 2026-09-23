// CSV reading: separator detection and the sep= directive, the one bounded reader (readCsv) behind preview and import,
// overflow-column repair, readRows. BE-11-T01 moved it here; BE-03-T01 made readCsv the only reader.
const { parserLimits, createClientInputError, tooManyColumnsError } = require('./limits');
const { SOURCE_ROW_NUMBERS } = require('./rowErrors');
const { headerDeduper, normaliseCell, UNNAMED_COLUMN_RE, normaliseRows } = require('./headers');
const { assertSupportedFileBuffer } = require('./fileType');
const { readWorkbookRows } = require('./xlsx');

const csv = require('csv-parser');
const { Readable } = require('stream');

// csv-parser's own wording for a line longer than maxRowBytes.
const CSV_ROW_TOO_LONG_MESSAGE = 'Row exceeds the maximum size';

/** The longest line any CSV reader buffers before refusing the file. */
const csvMaxRowBytes = (limits = parserLimits()) => limits.maxRowBytes;

/**
 * csv-parser reports an over-long line as a bare Error with no status, and
 * confirm passed it straight to the error middleware as a 500. Say what is
 * wrong and what to do; leave every other error as it was.
 */
const csvReadError = (error, limits = parserLimits()) => {
  if (error?.message !== CSV_ROW_TOO_LONG_MESSAGE) return error;
  const tooLong = createClientInputError(
    `A line in this file is longer than ${Math.round(limits.maxRowBytes / 1024)} KB. A sales export keeps each sale on `
    + 'its own short line, so this is usually one runaway cell or the wrong separator. Export the report again, or save '
    + 'it from Excel as "CSV UTF-8 (Comma delimited)", and upload that.'
  );
  tooLong.code = 'CSV_ROW_TOO_LONG';
  return tooLong;
};

// Ordered so ',' wins a tie, which is what an ambiguous file most often is.
const CSV_SEPARATOR_CANDIDATES = [',', ';', '\t', '|'];
const CSV_SEPARATOR_SAMPLE_LINES = 5;

/**
 * Excel writes `sep=;` as the first line of a CSV whenever the machine's list
 * separator is not a comma, which is the default on South African and most
 * European Windows installs. It is a directive to Excel, not data.
 *
 * Read as data it becomes the header row: production upload 6a3289a4 has
 * `headers: ["sep=", ""]` and imported nothing, and its owner was told "no
 * valid transaction rows could be imported with this mapping" beside a mapping
 * screen listing one nonsensical column.
 *
 * It matters beyond that one file. The fix we hand someone with a legacy .xls
 * is "Save As CSV UTF-8", so this is the very next thing that same owner
 * produces. Without this they walk out of one dead end into another.
 *
 * Only the first line counts, and only when the directive is the whole of it,
 * so a genuine column named `sep=x` stays a column.
 */
const SEP_DIRECTIVE_RE = /^﻿?sep=(\\t|.)[ \t]*$/i;

const csvSeparatorDirective = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return null;
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 64));
  const firstLine = head.split(/\r?\n/)[0];
  const match = SEP_DIRECTIVE_RE.exec(firstLine || '');
  if (!match) return null;
  // `sep=\t` is written literally, two characters, not a tab byte.
  const separator = match[1] === '\\t' ? '\t' : match[1];
  return { separator, byteLength: Buffer.byteLength(firstLine, 'utf8') };
};

/** The buffer with any `sep=` directive line removed, ready to be parsed. */
const stripCsvSeparatorDirective = (buffer) => {
  const directive = csvSeparatorDirective(buffer);
  if (!directive) return buffer;
  let offset = directive.byteLength;
  if (buffer[offset] === 0x0d) offset += 1;
  if (buffer[offset] === 0x0a) offset += 1;
  return buffer.subarray(offset);
};

/**
 * Picks the delimiter a CSV is really using.
 *
 * Only ';' was ever weighed against ',', so a tab- or pipe-delimited export --
 * "Text (Tab delimited)" is a standard Excel save-as, and several tills write
 * it with a .csv extension -- collapsed its entire header row into one column.
 * The owner was shown one nonsensical column and had no way forward.
 *
 * The winner is the candidate that appears on EVERY sampled line, scored by its
 * smallest per-line count: a real delimiter separates every row, while a comma
 * inside one quoted item cell shows up on one line only.
 */
const detectCsvSeparator = (buffer) => {
  // The file declaring its own separator beats guessing from the shape of
  // the rows, which a one-column-per-row export gives nothing to score.
  const declared = csvSeparatorDirective(buffer);
  if (declared) return declared.separator;

  const lines = (Buffer.isBuffer(buffer)
    ? buffer.toString('utf8', 0, Math.min(buffer.length, 4096))
    : '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, CSV_SEPARATOR_SAMPLE_LINES);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = 0;
  for (const candidate of CSV_SEPARATOR_CANDIDATES) {
    const score = Math.min(...lines.map((line) => line.split(candidate).length - 1));
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
};

/**
 * The one way an uploaded CSV is read: the upload preview, the wizard's
 * headers and the import itself all come through here. The preview used to
 * have its own reader, and it drifted: it kept an Excel "sep=" line as its
 * header row (so the wizard had nothing to map) and showed a repeated "Total"
 * once, with one column's money, while the import read the other column.
 * Returns the csv-parser stream; the source is piped in already. Only readCsv calls it.
 */
const readCsvStream = (buffer, { limits = parserLimits() } = {}) => {
  const dedupeHeader = headerDeduper();
  // Stripped before parsing; left in place the directive becomes the header
  // row and every real column disappears behind it.
  return Readable.from(stripCsvSeparatorDirective(buffer)).pipe(csv({
    separator: detectCsvSeparator(buffer),
    // csv-parser buffers a whole line before it splits it; without a cap one
    // line of separators became a row object with one key per separator.
    maxRowBytes: csvMaxRowBytes(limits),
    mapHeaders: ({ header, index }) => dedupeHeader(header, index),
    mapValues: ({ value }) => normaliseCell(value, limits),
  }));
};

/**
 * The one CSV reader. The upload preview (limit 5) and the import (no limit) both come through here, so the
 * columns an owner maps are the columns the import reads: an Excel `sep=` line is dropped, repeated headers
 * become "Total (2)", and the same column, row and row-size limits apply to both. Two readers that were
 * "the same" drifted once already and made a production file un-importable; do not add a second one.
 *
 * @param {Buffer} buffer
 * @param {{ limit?: number, limits?: ReturnType<typeof parserLimits> }} [options]
 * @returns {Promise<{ headers: string[], rows: object[] }>}
 */
const readCsv = (buffer, { limit = Infinity, limits = parserLimits() } = {}) =>
  new Promise((resolve, reject) => {
    const rows = [];
    let headers = [];
    let rowNumber = 1;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (!error) {
        resolve({ headers, rows: normaliseRows(rows) });
        return;
      }
      if (!error.statusCode) error.statusCode = 400;
      reject(error);
    };
    const parserStream = readCsvStream(buffer, { limits });
    parserStream
      .on('headers', (names) => {
        if (names.length > limits.maxColumns) {
          parserStream.destroy(tooManyColumnsError(limits));
          return;
        }
        headers = names;
      })
      .on('data', (row) => {
        if (settled) return;
        if (Object.keys(row).length > limits.maxColumns) {
          parserStream.destroy(tooManyColumnsError(limits));
          return;
        }
        if (rows.length >= limits.maxRows) {
          parserStream.destroy(createClientInputError(`File exceeds the ${limits.maxRows} row limit`));
          return;
        }
        rowNumber += 1;
        Object.defineProperty(row, SOURCE_ROW_NUMBERS, { value: [rowNumber], enumerable: false, configurable: true });
        rows.push(row);
        if (rows.length >= limit) {
          finish();
          parserStream.destroy();
        }
      })
      // csv-parser's over-long-line error becomes BE-01-T02's 400 with code CSV_ROW_TOO_LONG.
      .on('error', (error) => finish(csvReadError(error, limits)))
      .on('end', () => finish());
  });

const extraColumnIndex = (key) => {
  const match = String(key).match(UNNAMED_COLUMN_RE);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

const repairOverflowColumns = (rawRows, mapping) =>
  rawRows.map((raw) => {
    const keys = Object.keys(raw);
    const extraKeys = keys
      .filter((key) => UNNAMED_COLUMN_RE.test(key))
      .sort((a, b) => extraColumnIndex(a) - extraColumnIndex(b));

    if (!mapping.items || extraKeys.length === 0) return raw;

    const headers = keys.filter((key) => !UNNAMED_COLUMN_RE.test(key));
    const itemIndex = headers.indexOf(mapping.items);
    if (itemIndex < 0) return raw;

    const values = [...headers, ...extraKeys].map((key) => raw[key]);
    const overflow = values.length - headers.length;
    if (overflow <= 0) return raw;

    const repaired = {};
    for (let index = 0; index < headers.length; index++) {
      const header = headers[index];
      if (index < itemIndex) {
        repaired[header] = values[index];
      } else if (index === itemIndex) {
        repaired[header] = values
          .slice(index, index + overflow + 1)
          .filter((value) => String(value || '').trim() !== '')
          .join(', ');
      } else {
        repaired[header] = values[index + overflow];
      }
    }

    if (raw?.[SOURCE_ROW_NUMBERS]) {
      Object.defineProperty(repaired, SOURCE_ROW_NUMBERS, {
        value: raw[SOURCE_ROW_NUMBERS],
        enumerable: false,
        configurable: true,
      });
    }

    return repaired;
  });

const readRows = async (buffer, fileExt) => {
  assertSupportedFileBuffer(buffer, fileExt);
  if (fileExt === 'xlsx') return readWorkbookRows(buffer);
  return (await readCsv(buffer)).rows;
};

module.exports = {
  csvMaxRowBytes, csvReadError, csvSeparatorDirective, stripCsvSeparatorDirective, detectCsvSeparator, readCsv,
  repairOverflowColumns, readRows,
};
