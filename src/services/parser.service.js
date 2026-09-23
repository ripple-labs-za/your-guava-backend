/**
 * Re-export barrel (BE-11-T01). The POS parser lives in ./parser/*, the cafe-local
 * date helpers in ../utils/timezone.js. Code outside the parser keeps importing
 * this path: tests spy on this object (jest.spyOn(parserService, 'parseBuffer')),
 * so callers must use parser.parseBuffer through it, never a copy of it.
 */
const {
  safeTimezone, getZonedDateParts, zonedDateTimeToUtc, zonedDayStart, zonedDayEnd,
  addZonedDays, zonedDayOrdinal, zonedDateKey, zonedDayOfWeek, processLocalCalendarDate,
} = require('../utils/timezone');
const { parserLimits, boundedInteger, tooManyColumnsError } = require('./parser/limits');
const {
  requiredFieldsForMode, normaliseHeader, headerDeduper, normaliseCell, normaliseRow, normaliseRows, MAX_HEADER_CHARS,
} = require('./parser/headers');
const { readWorkbook, readWorkbookRows } = require('./parser/xlsx');
const { streamXlsxSharedStrings, streamXlsxSheetCells, xlsxPartTooLargeError } = require('./parser/xlsxStream');
const { assertSupportedFileBuffer } = require('./parser/fileType');
const {
  csvSeparatorDirective, detectCsvSeparator, stripCsvSeparatorDirective, readCsv, csvMaxRowBytes, csvReadError,
} = require('./parser/csv');
const { parsePackedItems } = require('./parser/packedItems');
const { groupLinePerRow } = require('./parser/lineItems');
const { VALID_ITEMS_MODES, parseBuffer } = require('./parser/parse');
const { MAX_ROW_ERRORS } = require('./parser/rowErrors');

module.exports = {
  // The import pipeline
  parseBuffer, groupLinePerRow, parsePackedItems, VALID_ITEMS_MODES, MAX_ROW_ERRORS,
  // Headers and cells
  requiredFieldsForMode, normaliseHeader, headerDeduper, normaliseCell, normaliseRow, normaliseRows, MAX_HEADER_CHARS,
  // Readers and file checks
  csvSeparatorDirective, detectCsvSeparator, stripCsvSeparatorDirective, readCsv, csvMaxRowBytes, csvReadError,
  readWorkbook, readWorkbookRows, assertSupportedFileBuffer,
  streamXlsxSharedStrings, streamXlsxSheetCells, xlsxPartTooLargeError,
  // Limits
  parserLimits, boundedInteger, tooManyColumnsError,
  // Cafe-local dates (home: utils/timezone.js; re-exported until BE-11-T05 moves every caller)
  safeTimezone, getZonedDateParts, zonedDateTimeToUtc, zonedDayStart, zonedDayEnd,
  addZonedDays, zonedDayOrdinal, zonedDateKey, zonedDayOfWeek, processLocalCalendarDate,
};
