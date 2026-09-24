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

/**
 * Report exports put a title, a date range and a blank line above the column names. The header is the first
 * row within the first 20 that looks like labels. CSV (strictWidth) also asks that it fit the table below it: the
 * next non-blank row is at least as wide (an unquoted multi-item cell makes data rows WIDER), or the row is at least
 * as wide as most rows below it (csv-parser accepts SHORT rows, e.g. an empty trailing Note column the till leaves
 * off; without this a data row would win over a real header). A workbook's cells are its own, so label-likeness is
 * enough there: a width test only ever rejected a wide header over sparse rows (review of BE-03-T08), while a title
 * row fails on its single filled cell. 0 when none qualifies, so an ordinary file reads exactly as it did before.
 */
const findHeaderRowIndex = (rows, { scanRows = HEADER_SCAN_LINES, strictWidth = false } = {}) => {
  for (let index = 0; index < Math.min(scanRows, rows.length); index += 1) {
    const cells = rows[index] || [];
    if (!looksLikeHeaderRow(cells)) continue;
    if (!strictWidth) return index;
    const below = rows.slice(index + 1);
    const next = below.find((row) => filledCount(row || []) > 0);
    if (!next) return index;
    if (next.length >= cells.length || cells.length >= modalWidth(below)) return index;
  }
  return 0;
};

/** The share of a row's filled cells that read as labels: 1 for a real header, about a half for a mis-split data row. */
const labelShare = (cells) => {
  const filled = cells.map((cell) => String(cell ?? '').trim()).filter(Boolean);
  if (filled.length === 0) return 0;
  return filled.filter((cell) => /\p{L}/u.test(cell) && !NUMERIC_OR_DATE_RE.test(cell)).length / filled.length;
};

/**
 * The line ending csv-parser will use, decided as it decides it: the first line break of the file, where a CR not
 * followed by LF means CR records ("CSV (Macintosh)") and anything else means LF.
 */
const detectNewline = (buffer) => {
  const lf = buffer.indexOf(LF);
  const cr = buffer.indexOf(CR);
  if (cr !== -1 && (lf === -1 || cr < lf) && buffer[cr + 1] !== LF) return CR;
  return LF;
};

/**
 * The separator is the one whose header row comes first in the file: the real header always sits above any data row
 * a wrong separator can mistake for one (review of BE-03-T08, third round: ranking by label share first let a comma
 * file whose header has a "#" or "2025" cell lose to a data row with ';'-joined items). Then the header that reads
 * most like labels (under the wrong separator the first sale of a ';' file splits into half-label pieces), then the
 * one that fits the most rows below it within one column (tills leave empty trailing columns off, or add a trailing
 * separator to the header only), then the widest, then the candidate order (',' first).
 */
/** Whether rank `a` beats rank `b`: the first key that differs decides, higher wins; equal ranks keep the earlier. */
const outranks = (a, b) => {
  for (let key = 0; key < a.length; key += 1) if (a[key] !== b[key]) return a[key] > b[key];
  return false;
};

const detectCsvLayout = (text, { declaredSeparator, newline = LF } = {}) => {
  // csv-parser ends a record at its newline only (a CR before an LF belongs to the LF), so layout lines do too.
  const lines = text.split(newline === CR ? /\r/ : /\r?\n/, HEADER_SCAN_LINES + 5);
  let best = null;
  for (const separator of declaredSeparator ? [declaredSeparator] : CSV_SEPARATOR_CANDIDATES) {
    const rows = lines.map((line) => (line.trim() === '' ? [] : splitCsvLine(line, separator, MAX_LAYOUT_CELLS)));
    const index = findHeaderRowIndex(rows, { strictWidth: true });
    const header = rows[index] || [];
    if (header.length < 2 || !looksLikeHeaderRow(header)) continue;
    const share = Math.round(labelShare(header) * 100);
    let fit = 0;
    for (let row = index + 1; row < rows.length; row += 1) {
      if (rows[row].length > 0 && Math.abs(rows[row].length - header.length) <= 1) fit += 1;
    }
    const rank = [-index, share, fit, header.length];
    if (!best || outranks(rank, best.rank)) best = { separator, headerLineIndex: index, rank };
  }
  return best
    ? { separator: best.separator, headerLineIndex: best.headerLineIndex }
    : { separator: declaredSeparator || ',', headerLineIndex: 0 };
};

// More than this many quotes that open a field, run past a line and turn out not to close it: the file's quoting
// cannot be trusted, and it is refused rather than guessed at (only when they are also most of its records).
const CROSSED_OPENINGS_FLOOR = 1000;

const unreadableQuotes = () => createClientInputError(
  'This CSV has quotation marks that never close, so its rows cannot be told apart. '
  + 'Export it again, or save it from Excel as "CSV UTF-8", and upload that.'
);

/**
 * Records (non-empty lines) of a file with no quotation marks, found with native searches: nothing needs rewriting,
 * and walking 10 MB byte by byte in JavaScript blocked the event loop. A record ends at the file's newline, as
 * csv-parser's does; in an LF file a line holding only the CR of a CRLF is empty. One indexOf per line, each starting
 * where the last ended: linear.
 */
const countQuoteFreeRecords = (buffer, newline = LF) => {
  let records = 0;
  let start = 0;
  while (start < buffer.length) {
    const found = buffer.indexOf(newline, start);
    const end = found === -1 ? buffer.length : found;
    const contentEnd = newline === LF && end > start && buffer[end - 1] === CR ? end - 1 : end;
    if (contentEnd > start) records += 1;
    start = end + 1;
  }
  return records;
};

const normaliseCsvQuotes = (buffer, separator, { maxQuotedFieldBytes, newline = LF }) => {
  if (buffer.indexOf(QUOTE) === -1) return { buffer, repairedFields: 0, records: countQuoteFreeRecords(buffer, newline) };
  const SEP = separator.charCodeAt(0);
  const NL = newline;
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
  // Only the opening just rewound to can ever be met again (the scan moves forward from it), so one position is
  // enough; a Set of every literal opening grew past the heap guard on a file of them.
  let literalOpening = -1;
  let crossedOpenings = 0;
  let visited = 0; let records = 0; let repairedFields = 0;
  let mode = 'start'; // 'start' | 'plain' | 'wrapped' | 'quoted'
  let fieldStart = 0; let lineHasContent = false; let opened = null;
  const endField = (at) => { if (mode === 'wrapped') insert(at); mode = 'start'; };
  const rewindToOpening = () => {
    if (opened.crossedLine) {
      crossedOpenings += 1;
      if (crossedOpenings > CROSSED_OPENINGS_FLOOR && crossedOpenings * 2 > opened.records) throw unreadableQuotes();
    }
    literalOpening = opened.at;
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
      if (b === NL) {
        // A field that already needed a stray quote repaired is not a real quoted field: it ends at its line, it does
        // not swallow the lines up to the next quote. A genuine multi-line cell needs no repair and keeps its newlines.
        if (opened.repaired) { i = rewindToOpening(); continue; }
        opened.crossedLine = true;
        continue;
      }
      if (b !== QUOTE) continue;
      const next = buffer[i + 1];
      if (next === QUOTE) { i += 1; continue; }
      if (next === undefined || next === SEP || next === LF || next === CR) { mode = 'plain'; opened = null; continue; }
      // A quote that would need repair after the field already ran past a line: the opening quote was stray, and the
      // lines it crossed are separate records (review of BE-03-T08: `"1 x Latte,38.00` merged the rows up to a quoted
      // cell three lines later, and booked that cell's sale on its own receipt).
      if (opened.crossedLine) { i = rewindToOpening(); continue; }
      insert(i); repairedFields += 1; opened.repaired = true;
      continue;
    }
    if (b === SEP) { endField(i); fieldStart = i + 1; lineHasContent = true; continue; }
    // A record ends at the file's newline, as csv-parser's does. In an LF file the CR of a CRLF closes the field (so a
    // repaired field's closing quote goes before it); any other CR, or an LF in a CR file, is an ordinary cell byte.
    if (NL === LF && b === CR && buffer[i + 1] === LF) { endField(i); continue; }
    if (b === NL) {
      endField(i);
      if (lineHasContent) records += 1;
      lineHasContent = false;
      fieldStart = i + 1;
      continue;
    }
    lineHasContent = true;
    if (b === QUOTE) {
      if (mode === 'start' && i !== literalOpening) {
        opened = {
          at: i, inserts: insertCount, records, repairedFields, fieldStart, lineHasContent, repaired: false, crossedLine: false,
        };
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

/** The byte offset of a layout line (split at the file's newline, as detectCsvLayout splits them). */
const offsetOfLine = (buffer, lineIndex, newline = LF) => {
  let offset = 0;
  for (let line = 0; line < lineIndex && offset < buffer.length; line += 1) {
    const found = buffer.indexOf(newline, offset);
    offset = found === -1 ? buffer.length : found + 1;
  }
  return offset;
};

const prepareCsv = (buffer, limits) => {
  const { buffer: decoded, encoding } = decodeCsvBuffer(buffer);
  if (decoded.subarray(0, 8192).includes(0)) throw createClientInputError('CSV file contains binary data');
  const directive = csvSeparatorDirective(decoded);
  const withoutDirective = stripCsvSeparatorDirective(decoded);
  const newline = detectNewline(withoutDirective);
  const head = withoutDirective.toString('utf8', 0, Math.min(withoutDirective.length, LAYOUT_SAMPLE_BYTES));
  const { separator, headerLineIndex } = detectCsvLayout(head, { declaredSeparator: directive?.separator, newline });
  const { buffer: body, repairedFields, records } = normaliseCsvQuotes(
    withoutDirective.subarray(offsetOfLine(withoutDirective, headerLineIndex, newline)),
    separator,
    { maxQuotedFieldBytes: limits.maxCellChars * 4, newline }
  );
  return {
    body, separator, encoding, repairedFields,
    headerRowNumber: headerLineIndex + 1,
    expectedRecords: Math.max(0, records - 1), // the header is a record too
  };
};

module.exports = {
  SEP_DIRECTIVE_RE, csvSeparatorDirective, stripCsvSeparatorDirective,
  splitCsvLine, looksLikeHeaderRow, findHeaderRowIndex, detectNewline, detectCsvLayout, normaliseCsvQuotes, prepareCsv,
};
