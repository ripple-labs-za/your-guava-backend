// CSV structure before csv-parser sees a byte (BE-03-T08): the encoding, the sep= directive, the separator and the
// header row a report puts below its title lines, and quotes rewritten into RFC 4180 form so a stray inch mark
// cannot merge lines. csv.js reads what prepareCsv returns and re-exports the directive helpers.
const { decodeCsvBuffer } = require('./encoding');
const { createClientInputError } = require('./limits');

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


const QUOTE = 0x22; const LF = 0x0a; const CR = 0x0d;
const CSV_SEPARATOR_CANDIDATES = [',', ';', '\t', '|'];
const HEADER_SCAN_LINES = 20;
const LAYOUT_SAMPLE_BYTES = 64 * 1024;
// Layout detection splits at most this many cells per line. No real header is this wide (the column limit refuses such
// a file anyway), and splitting a 128 KB line of separators four times, once per candidate, blocked the event loop.
const MAX_LAYOUT_CELLS = 1024;
const NUMERIC_OR_DATE_RE = /^[-+(]?\s*(?:R|\$|€|£)?\s*[\d.,:/\s-]+\)?$/;

/** Splits one text line for layout detection only: quote-aware, and a quote that does not open a field is literal. */
const splitCsvLine = (line, separator, maxCells = Infinity) => {
  const cells = []; let cell = ''; let quoted = false; let atStart = true;
  for (let i = 0; i < line.length && cells.length < maxCells; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"' && (i + 1 === line.length || line[i + 1] === separator)) quoted = false;
      else cell += ch;
    } else if (ch === '"' && atStart) { quoted = true; atStart = false; }
    else if (ch === separator) { cells.push(cell); cell = ''; atStart = true; }
    else { cell += ch; atStart = false; }
  }
  cells.push(cell);
  return cells;
};

/** A header has at least two filled cells, and at least half of them read as labels rather than numbers or dates. */
const looksLikeHeaderRow = (cells) => {
  const filled = cells.map((cell) => String(cell ?? '').trim()).filter(Boolean);
  if (filled.length < 2) return false;
  const labels = filled.filter((cell) => /\p{L}/u.test(cell) && !NUMERIC_OR_DATE_RE.test(cell));
  return labels.length * 2 >= filled.length;
};

const filledCount = (cells) => cells.filter((cell) => String(cell ?? '').trim() !== '').length;

/** The most common field count among the non-blank rows (ties go to the wider count). */
const modalWidth = (rows) => {
  const counts = new Map(); let best = 0; let bestCount = 0;
  for (const row of rows) {
    if (!row || filledCount(row) === 0) continue;
    const seen = (counts.get(row.length) || 0) + 1;
    counts.set(row.length, seen);
    if (seen > bestCount || (seen === bestCount && row.length > best)) { best = row.length; bestCount = seen; }
  }
  return best;
};

/** The most common value (ties go to the larger), or 0 for none. */
const modalOf = (values) => {
  const counts = new Map(); let best = 0; let bestCount = 0;
  for (const value of values) {
    const seen = (counts.get(value) || 0) + 1;
    counts.set(value, seen);
    if (seen > bestCount || (seen === bestCount && value > best)) { best = value; bestCount = seen; }
  }
  return best;
};

/**
 * Report exports put a title, a date range and a blank line above the column names. The header is the first
 * row within the first 20 that looks like labels and fits the table below it. CSV (strictWidth): the next
 * non-blank row is at least as wide (an unquoted multi-item cell makes data rows WIDER), or the row is at
 * least as wide as most rows below it (csv-parser accepts SHORT rows, e.g. an empty trailing Note column the
 * till leaves off; without this a data row would win over a real header). XLSX: the rows below mostly fill at
 * least half as many cells (the most common count over the next ten, so one sparse first data row does not hide
 * the header). 0 when none qualifies, so an ordinary file reads exactly as it did before.
 */
const findHeaderRowIndex = (rows, { scanRows = HEADER_SCAN_LINES, strictWidth = false } = {}) => {
  for (let index = 0; index < Math.min(scanRows, rows.length); index += 1) {
    const cells = rows[index] || [];
    if (!looksLikeHeaderRow(cells)) continue;
    const below = rows.slice(index + 1);
    const filledBelow = below.filter((row) => filledCount(row || []) > 0);
    if (filledBelow.length === 0) return index;
    if (strictWidth) {
      if (filledBelow[0].length >= cells.length || cells.length >= modalWidth(below)) return index;
    } else if (modalOf(filledBelow.slice(0, 10).map((row) => filledCount(row))) * 2 >= filledCount(cells)) return index;
  }
  return 0;
};

/**
 * The separator is the one whose header row fits the table below it best: the most rows of exactly its width. A
 * wider header alone is not enough: under ',' the first sale of a ';' file ("2026-09-01;\"1 x Latte, 1 x Muffin\";
 * 76,00") splits into label-like pieces and used to win, leaving the real header behind (review of BE-03-T08). Ties
 * go to the wider header, then to the candidate order (',' first).
 */
const detectCsvLayout = (text, { declaredSeparator } = {}) => {
  // csv-parser ends a record at LF only, so layout lines do too (a CR before the LF belongs to it).
  const lines = text.split(/\r?\n/, HEADER_SCAN_LINES + 5);
  let best = null;
  for (const separator of declaredSeparator ? [declaredSeparator] : CSV_SEPARATOR_CANDIDATES) {
    const rows = lines.map((line) => (line.trim() === '' ? [] : splitCsvLine(line, separator, MAX_LAYOUT_CELLS)));
    const index = findHeaderRowIndex(rows, { strictWidth: true });
    const header = rows[index] || [];
    if (header.length < 2 || !looksLikeHeaderRow(header)) continue;
    let fit = 0;
    for (let row = index + 1; row < rows.length; row += 1) if (rows[row].length === header.length) fit += 1;
    if (!best || fit > best.fit || (fit === best.fit && header.length > best.width)) {
      best = { separator, headerLineIndex: index, width: header.length, fit };
    }
  }
  return best
    ? { separator: best.separator, headerLineIndex: best.headerLineIndex }
    : { separator: declaredSeparator || ',', headerLineIndex: 0 };
};

const LITERAL_OPENINGS_FLOOR = 1000;

const unreadableQuotes = () => createClientInputError(
  'This CSV has quotation marks that never close, so its rows cannot be told apart. '
  + 'Export it again, or save it from Excel as "CSV UTF-8", and upload that.'
);

/**
 * Records (non-empty lines) of a file with no quotation marks, found with native searches: nothing needs rewriting,
 * and walking 10 MB byte by byte in JavaScript blocked the event loop. A record ends at LF, as csv-parser's does; a
 * line holding only the CR of a CRLF is empty. One indexOf per line, each starting where the last ended: linear.
 */
const countQuoteFreeRecords = (buffer) => {
  let records = 0;
  let start = 0;
  while (start < buffer.length) {
    const lf = buffer.indexOf(LF, start);
    const end = lf === -1 ? buffer.length : lf;
    const contentEnd = end > start && buffer[end - 1] === CR ? end - 1 : end;
    if (contentEnd > start) records += 1;
    start = end + 1;
  }
  return records;
};

const normaliseCsvQuotes = (buffer, separator, { maxQuotedFieldBytes }) => {
  if (buffer.indexOf(QUOTE) === -1) return { buffer, repairedFields: 0, records: countQuoteFreeRecords(buffer) };
  const SEP = separator.charCodeAt(0);
  const budget = buffer.length * 3 + 1024 * 1024;
  // Every repair inserts one quote byte, so only the positions are kept (ascending input indexes), in a growable
  // Int32Array: a plain array of 10.5M numbers for 10 MB of '"' took +403 MB of heap. More inserts than half the
  // file cannot be an export (a file of inch marks needs about one in eight), so that is refused.
  const maxInserts = Math.floor(buffer.length / 2) + 1024;
  let inserts = new Int32Array(1024);
  let insertCount = 0;
  const insert = (at) => {
    if (insertCount >= maxInserts) throw unreadableQuotes();
    if (insertCount === inserts.length) {
      const grown = new Int32Array(inserts.length * 2);
      grown.set(inserts);
      inserts = grown;
    }
    inserts[insertCount] = at;
    insertCount += 1;
  };
  const literalOpenings = new Set();
  let visited = 0; let records = 0; let repairedFields = 0;
  let mode = 'start'; // 'start' | 'plain' | 'wrapped' | 'quoted'
  let fieldStart = 0; let lineHasContent = false; let opened = null;
  const endField = (at) => { if (mode === 'wrapped') insert(at); mode = 'start'; };
  const rewindToOpening = () => {
    literalOpenings.add(opened.at);
    insertCount = opened.inserts; records = opened.records; repairedFields = opened.repairedFields;
    fieldStart = opened.fieldStart; lineHasContent = opened.lineHasContent; mode = 'start';
    const at = opened.at; opened = null;
    return at - 1; // the loop's i += 1 lands on the same quote, which is now literal
  };
  for (let i = 0; ; i += 1) {
    visited += 1;
    if (visited > budget) throw unreadableQuotes();
    if (i >= buffer.length) {
      if (mode !== 'quoted') break;
      i = rewindToOpening();
      continue;
    }
    const b = buffer[i];
    if (mode === 'quoted') {
      if (i - opened.at > maxQuotedFieldBytes) { i = rewindToOpening(); continue; }
      // A field that already needed a stray quote repaired is not a real quoted field: it ends at its line, it does
      // not swallow the lines up to the next quote (review of BE-03-T08: `"Big" Breakfast` merged every row up to the
      // next quoted cell). A genuine multi-line cell needs no repair and keeps its newlines.
      if (b === LF && opened.repaired) { i = rewindToOpening(); continue; }
      if (b !== QUOTE) continue;
      const next = buffer[i + 1];
      if (next === QUOTE) { i += 1; continue; }
      if (next === undefined || next === SEP || next === LF || next === CR) { mode = 'plain'; opened = null; continue; }
      insert(i); repairedFields += 1; opened.repaired = true;
      continue;
    }
    if (b === SEP) { endField(i); fieldStart = i + 1; lineHasContent = true; continue; }
    // A record ends at LF, as csv-parser's does. The CR of a CRLF closes the field (so a repaired field's closing
    // quote goes before it); a lone CR is an ordinary byte of its cell, which is how csv-parser reads it too.
    if (b === CR && buffer[i + 1] === LF) { endField(i); continue; }
    if (b === LF) {
      endField(i);
      if (lineHasContent) records += 1;
      lineHasContent = false;
      fieldStart = i + 1;
      continue;
    }
    lineHasContent = true;
    if (b === QUOTE) {
      if (mode === 'start' && !literalOpenings.has(i)) {
        opened = { at: i, inserts: insertCount, records, repairedFields, fieldStart, lineHasContent, repaired: false };
        mode = 'quoted';
        continue;
      }
      if (mode !== 'wrapped') { insert(fieldStart); mode = 'wrapped'; repairedFields += 1; }
      insert(i);
      continue;
    }
    if (mode === 'start') mode = 'plain';
  }
  endField(buffer.length);
  if (lineHasContent) records += 1;
  // A few names that open with a quote are read as literal and the file imports. When most lines needed it, the file's
  // quoting cannot be trusted at all, and it is refused with the export advice rather than guessed at.
  if (literalOpenings.size > LITERAL_OPENINGS_FLOOR && literalOpenings.size * 2 > records) throw unreadableQuotes();
  if (insertCount === 0) return { buffer, repairedFields, records };
  const out = Buffer.allocUnsafe(buffer.length + insertCount);
  let from = 0; let written = 0;
  for (let n = 0; n < insertCount; n += 1) {
    const at = inserts[n];
    written += buffer.copy(out, written, from, at);
    out[written] = QUOTE; written += 1;
    from = at;
  }
  buffer.copy(out, written, from);
  return { buffer: out, repairedFields, records };
};

/** The byte offset of a layout line (LF-separated, as detectCsvLayout splits them). */
const offsetOfLine = (buffer, lineIndex) => {
  let offset = 0;
  for (let line = 0; line < lineIndex && offset < buffer.length; line += 1) {
    const lf = buffer.indexOf(LF, offset);
    offset = lf === -1 ? buffer.length : lf + 1;
  }
  return offset;
};

const prepareCsv = (buffer, limits) => {
  const { buffer: decoded, encoding } = decodeCsvBuffer(buffer);
  if (decoded.subarray(0, 8192).includes(0)) throw createClientInputError('CSV file contains binary data');
  const directive = csvSeparatorDirective(decoded);
  const withoutDirective = stripCsvSeparatorDirective(decoded);
  const head = withoutDirective.toString('utf8', 0, Math.min(withoutDirective.length, LAYOUT_SAMPLE_BYTES));
  const { separator, headerLineIndex } = detectCsvLayout(head, { declaredSeparator: directive?.separator });
  const { buffer: body, repairedFields, records } = normaliseCsvQuotes(
    withoutDirective.subarray(offsetOfLine(withoutDirective, headerLineIndex)),
    separator,
    { maxQuotedFieldBytes: limits.maxCellChars * 4 }
  );
  return {
    body, separator, encoding, repairedFields,
    headerRowNumber: headerLineIndex + 1,
    expectedRecords: Math.max(0, records - 1), // the header is a record too
  };
};

module.exports = {
  SEP_DIRECTIVE_RE, csvSeparatorDirective, stripCsvSeparatorDirective,
  splitCsvLine, looksLikeHeaderRow, findHeaderRowIndex, detectCsvLayout, normaliseCsvQuotes, prepareCsv,
};
