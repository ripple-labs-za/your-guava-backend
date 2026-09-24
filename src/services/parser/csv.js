// CSV reading: the one bounded reader (readCsv) behind preview and import, and overflow-column repair.
// BE-11-T01 moved it here; BE-03-T01 made readCsv the only reader; BE-03-T08 put prepareCsv (encoding, layout, quotes,
// in csvStructure.js) in front of it.
const { parserLimits, createClientInputError, tooManyColumnsError } = require('./limits');
const { SOURCE_ROW_NUMBERS, sourceRowNumber } = require('./rowErrors');
const { headerDeduper, normaliseCell, UNNAMED_COLUMN_RE, normaliseRows } = require('./headers');
const { decodeCsvBuffer } = require('./encoding');
const {
  csvSeparatorDirective, stripCsvSeparatorDirective, detectNewline, detectCsvLayout, prepareCsv,
} = require('./csvStructure');

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

/**
 * Picks the delimiter a CSV is really using: the separator under which a label-like header row fits the table below
 * it (BE-03-T08). The minimum-count rule this replaces let a report's title line make ',' win for a ';' file.
 */
const detectCsvSeparator = (buffer) => {
  const text = decodeCsvBuffer(buffer).buffer;
  return detectCsvLayout(text.toString('utf8', 0, Math.min(text.length, 65536)), {
    declaredSeparator: csvSeparatorDirective(text)?.separator,
    newline: detectNewline(text),
  }).separator;
};

/**
 * The one way an uploaded CSV is read: the upload preview, the wizard's
 * headers and the import itself all come through here. The preview used to
 * have its own reader, and it drifted: it kept an Excel "sep=" line as its
 * header row (so the wizard had nothing to map) and showed a repeated "Total"
 * once, with one column's money, while the import read the other column.
 * Returns the csv-parser stream; the source is piped in already. Only readCsv calls it.
 */
const readCsvStream = (body, separator, { limits = parserLimits() } = {}) => {
  const dedupeHeader = headerDeduper();
  // A copy: csv-parser unescapes "" by writing into the bytes it reads, and prepareCsv's body can be a view of the
  // uploaded buffer, which preview reads before the same buffer is staged for the import (review of BE-03-T08: a
  // "1 x 12"" Pizza" cell was stored as "12" Pizzaa").
  return Readable.from(Buffer.from(body)).pipe(csv({
    separator,
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
 * BE-03-T08: prepareCsv decodes the file to UTF-8, finds the header row below any report title lines, and rewrites
 * quotes so a stray inch mark cannot merge lines; blank records are skipped, and every line the quotes still merged
 * is counted as lost, so the import can say so instead of looking complete.
 *
 * @param {Buffer} buffer
 * @param {{ limit?: number, limits?: ReturnType<typeof parserLimits> }} [options]
 * @returns {Promise<{ headers: string[], rows: object[], encoding: string, separator: string, headerRowNumber: number,
 *   blankRows: number, lostRecords: number }>}
 */
const readCsv = (buffer, { limit = Infinity, limits = parserLimits() } = {}) =>
  new Promise((resolve, reject) => {
    const rows = [];
    let headers = [];
    let settled = false;
    let prepared;
    try {
      prepared = prepareCsv(buffer, limits);
    } catch (error) {
      if (!error.statusCode) error.statusCode = 400;
      reject(error);
      return;
    }
    let rowNumber = prepared.headerRowNumber;
    let blankRows = 0;
    let emptyLines = 0;
    // Lines that are not data do not count toward the preview's limit, so a flood of them is held to the row limit.
    const tooManyLines = () => emptyLines + blankRows + rows.length > limits.maxRows;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (!error) {
        const complete = !Number.isFinite(limit);
        resolve({
          headers,
          rows: normaliseRows(rows),
          encoding: prepared.encoding,
          separator: prepared.separator,
          headerRowNumber: prepared.headerRowNumber,
          blankRows,
          lostRecords: complete ? Math.max(0, prepared.expectedRecords - rows.length - blankRows) : 0,
        });
        return;
      }
      if (!error.statusCode) error.statusCode = 400;
      reject(error);
    };
    const parserStream = readCsvStream(prepared.body, prepared.separator, { limits });
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
        rowNumber += 1;
        // Width first, before anything walks the row: a line of nothing but separators is the BE-01 wide-row attack,
        // not a blank line to skip.
        const width = Object.keys(row).length;
        if (width > limits.maxColumns) {
          parserStream.destroy(tooManyColumnsError(limits));
          return;
        }
        // An empty line: csv-parser emits {} for it, and normaliseCsvQuotes did not count it as a record either, so it
        // takes no part in the lost-record arithmetic (counting it in blankRows would hide a merged line per blank line).
        if (width === 0) {
          emptyLines += 1;
          if (tooManyLines()) parserStream.destroy(createClientInputError(`File exceeds the ${limits.maxRows} row limit`));
          return;
        }
        const values = Object.values(row);
        // A separator-only line (",,"): a record in normaliseCsvQuotes' count, so it is counted here too.
        if (values.every((value) => String(value ?? '').trim() === '')) {
          blankRows += 1;
          if (tooManyLines()) parserStream.destroy(createClientInputError(`File exceeds the ${limits.maxRows} row limit`));
          return;
        }
        if (rows.length >= limits.maxRows) {
          parserStream.destroy(createClientInputError(`File exceeds the ${limits.maxRows} row limit`));
          return;
        }
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

// An item fragment has a quantity marker ("2 x Muffin") or starts with a letter ("Muffin"). A bare "38" is the tail of
// an unquoted decimal comma or thousands separator: folding it into Items booked R50 for a R38.50 sale (BE-03-T08).
const ITEM_FRAGMENT_RE = /^-?\d+(?:[.,]\d+)?\s*[x×]\s+\S|^[^\d\s].*\p{L}/iu;

/**
 * Folds cells beyond the header width back into Items when they look like the rest of an unquoted multi-item cell.
 * A row whose extra cells do not look like items is not guessed at: it comes back in ambiguousRows for a row error.
 */
const repairOverflowColumns = (rawRows, mapping) => {
  const ambiguousRows = [];
  const rows = rawRows.map((raw) => {
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
    const fragments = values.slice(itemIndex, itemIndex + overflow + 1).filter((value) => String(value || '').trim() !== '');
    if (!fragments.every((fragment) => ITEM_FRAGMENT_RE.test(String(fragment).trim()))) {
      ambiguousRows.push({ rowNumber: sourceRowNumber(raw), overflow });
      return null;
    }

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
  return { rows: rows.filter(Boolean), ambiguousRows };
};


module.exports = {
  csvMaxRowBytes, csvReadError, csvSeparatorDirective, stripCsvSeparatorDirective, detectCsvSeparator, readCsv,
  repairOverflowColumns,
};
