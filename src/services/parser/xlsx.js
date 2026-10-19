// Workbook reading: the first sheet through the streaming reader, into normalised rows; Excel serial dates.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { DEFAULT_TIMEZONE, zonedDateTimeToUtc } = require('../../utils/timezone');
const { parserLimits, createClientInputError } = require('./limits');
const { SOURCE_ROW_NUMBERS } = require('./rowErrors');
const { headerDeduper, normaliseCell } = require('./headers');
const { findHeaderRowIndex } = require('./csvStructure');
const {
  loadReaderSteps, loadXmldom, assertXlsxPartSize, streamXlsxSharedStrings, streamXlsxSheetCells, xlsxUnreadableError,
  XLSX_MAX_SHEET_COST,
} = require('./xlsxStream');

const excelSerialDateToDate = (serial, timezone = DEFAULT_TIMEZONE) => {
  if (!Number.isFinite(serial) || serial <= 0) return null;

  const wholeDays = Math.floor(serial);
  const dayFraction = serial - wholeDays;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + wholeDays * 86400000 + Math.round(dayFraction * 86400000));

  return zonedDateTimeToUtc({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  }, timezone);
};

/**
 * readSheet(buffer) for sheet 1, as read-excel-file 9.2.0 does it, refusing a
 * sheet whose matrix would be unsafe to allocate. A side of 0 counts as 1:
 * A1:1000000000 has no column letters, and the reader still builds a billion
 * empty rows for it.
 */
const readFirstSheet = async (buffer, limits = parserLimits()) => {
  const {
    unpackXlsxFile, xml: readerXml, parseFilePaths, parseStyles, parseSpreadsheetInfo, convertCellsToData2dArray,
  } = loadReaderSteps();
  loadXmldom();
  // Everything the reader does to a workbook that reached this point is about
  // the file's shape (a missing part, a sheet it cannot parse, an unescaped
  // "<" in an attribute, an undeclared namespace prefix). The reader reports
  // those as bare Errors, which the error middleware turned into a 500 as if
  // the API were at fault; they are 400s that tell the owner what to do.
  let cells;
  let dimensions;
  try {
    const contents = await unpackXlsxFile(buffer);
    const fileContent = (filePath) => {
      if (!contents[filePath]) {
        throw new Error(`"${filePath}" file not found inside the *.xlsx file zip archive`);
      }
      return contents[filePath];
    };
    const options = { sheets: [1] };
    // The parts still built as a DOM are held to xlsxMaxPartBytes first.
    const filePaths = parseFilePaths(assertXlsxPartSize('workbook relationships part', fileContent('xl/_rels/workbook.xml.rels'), limits), readerXml);
    const sharedStrings = filePaths.sharedStrings
      ? streamXlsxSharedStrings(fileContent(filePaths.sharedStrings))
      : [];
    const styles = filePaths.styles
      ? parseStyles(assertXlsxPartSize('styles part', fileContent(filePaths.styles), limits), readerXml)
      : {};
    const { sheets, epoch1904 } = parseSpreadsheetInfo(assertXlsxPartSize('workbook part', fileContent('xl/workbook.xml'), limits), readerXml);
    if (sheets.length < 1) {
      throw new Error('Sheet number out of bounds: 1. Available sheets count: 0');
    }
    const sheetPath = filePaths.sheets[sheets[0].relationId];
    if (!sheetPath) throw new Error('The first sheet of this workbook could not be found');

    ({ cells, dimensions } = streamXlsxSheetCells(fileContent(sheetPath), { sharedStrings, styles, epoch1904, options, limits }));
    dimensions = dimensions || loadReaderSteps().reconstructSheetDimensions(cells);
  } catch (error) {
    throw xlsxUnreadableError(error);
  }
  if (cells.length > 0) {
    const { row, column } = dimensions[1];
    const cost = Math.max(row, 1) * (Math.max(column, 1) + 8);
    if (!(cost <= XLSX_MAX_SHEET_COST)) {
      const error = createClientInputError(
        `This spreadsheet says it spans ${row} rows by ${column} columns, which is too large to read safely. `
        + 'Save it again from Excel, or export it as "CSV UTF-8", and upload that.'
      );
      error.code = 'XLSX_DIMENSION_LIMIT';
      throw error;
    }
  }
  return convertCellsToData2dArray(cells, dimensions);
};

/**
 * Reads a workbook into its header row and its data rows.
 *
 * Headers are taken from the sheet's own first row rather than inferred from a
 * data row, so a spreadsheet exported over a quiet period still reports its
 * columns. Deriving them from `rows[0]` made an empty export look like a file
 * with unreadable headers, which is what the operator was then told.
 */
const readWorkbook = async (buffer, { limits = parserLimits() } = {}) => {
  const matrix = await readFirstSheet(buffer, limits);
  if (!matrix.length) return { headers: [], rows: [] };
  // A report workbook opens with a title and a date range above its column names (BE-03-T08).
  const headerIndex = findHeaderRowIndex(matrix.slice(0, 20).map((row) => row.map((cell) => (cell == null ? '' : String(cell)))));
  const [headerRow, ...dataRows] = matrix.slice(headerIndex);
  if (dataRows.length > limits.maxRows) {
    throw createClientInputError(`File exceeds the ${limits.maxRows} row limit`);
  }
  if (headerRow.length > limits.maxColumns) {
    throw createClientInputError(`File exceeds the ${limits.maxColumns} column limit`);
  }
  const dedupeHeader = headerDeduper();
  const headers = headerRow.map((header, index) => dedupeHeader(header, index));

  const rows = dataRows
    .map((row, index) => ({ row, rowNumber: headerIndex + index + 2 }))
    .filter(({ row }) => row.some((value) => value != null && String(value).trim() !== ''))
    .map(({ row, rowNumber }) => {
      const mapped = {};
      headers.forEach((header, index) => {
        mapped[header] = normaliseCell(row[index] ?? '', limits);
      });
      Object.defineProperty(mapped, SOURCE_ROW_NUMBERS, {
        value: [rowNumber],
        enumerable: false,
        configurable: true,
      });
      return mapped;
    });

  return { headers, rows };
};

const readWorkbookRows = async (buffer, options) => (await readWorkbook(buffer, options)).rows;

module.exports = {
  excelSerialDateToDate, readWorkbook, readWorkbookRows,
};
