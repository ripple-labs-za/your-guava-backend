// The guard (readFirstSheet) runs read-excel-file 9.2.0's own sheet-1 steps and
// refuses before convertCellsToData2dArray allocates, so that step is the one
// to watch: wrap the internal module before the parser loads it, and the spy
// sees every allocation the parser asks for.
const path = require('path');
const fs = require('fs');

// The package's exports map hides its internals; the parser reaches them the same way.
const ALLOCATE = path.join(path.dirname(require.resolve('read-excel-file/node')), '..', 'commonjs', 'xlsx', 'convertCellsToData2dArray.js');
jest.doMock(ALLOCATE, () => {
  const actual = jest.requireActual(ALLOCATE);
  return { ...actual, default: jest.fn((...args) => actual.default(...args)) };
});
const allocate = require(ALLOCATE).default;
const { previewBuffer } = require('../../src/services/ingestion.service');
const { parseBuffer } = require('../../src/services/parser.service');
const { xlsxWith } = require('../helpers/xlsx');
const { measureBudget } = require('../helpers/budget');

const HEADER = ['Receipt', 'Date', 'Items', 'Total'];
const SALE = ['R1', '2026-04-01', '1 x Latte', '38.00'];
const MAPPING = { receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total' };
const lastRow = (cell) => `<row r="1048576">${cell}</row>`;
const LAST_CELL_ROW = lastRow('<c r="XFD1048576" t="inlineStr"><is><t>x</t></is></c>');
const dimensionBomb = () => xlsxWith([HEADER], { dimension: 'A1:XFD1048576', deflate: true });
const coordinateBomb = () => xlsxWith([HEADER], { extraRowsXml: LAST_CELL_ROW, deflate: true });
const EVIDENCE = process.env.B90_EVIDENCE_DIR; // optional: where to drop the bomb for the size check

describe('an XLSX that declares an impossible size is refused before it is read', () => {
  beforeAll(async () => {
    // Warm the reader: its first use loads modules and JIT code, which would
    // otherwise be counted as the first bomb's heap growth.
    await previewBuffer(xlsxWith([HEADER, SALE]), 'xlsx');
  });
  beforeEach(() => allocate.mockClear());

  it.each([
    ['declares A1:XFD1048576', dimensionBomb],
    ['holds one cell at XFD1048576', coordinateBomb],
  ])('[budget] refuses a 1 KB workbook that %s, before allocation, within 500 ms and 20 MB', async (label, build) => {
    const workbook = build();
    expect(workbook.length).toBeLessThan(2048);
    if (EVIDENCE && label.startsWith('declares')) fs.writeFileSync(path.join(EVIDENCE, 'dos-dimension.xlsx'), workbook);
    const outcome = await measureBudget(() => previewBuffer(workbook, 'xlsx'));
    console.log(`${label}: ${workbook.length} bytes, ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB`);
    expect(outcome.error).toMatchObject({ statusCode: 400 });
    expect(outcome.error.message).toMatch(/limit|rows|size/i);
    expect(allocate).not.toHaveBeenCalled();
    expect(outcome.elapsedMs).toBeLessThan(500);
    expect(outcome.heapGrowthMb).toBeLessThan(20);
  });

  it('refuses the same workbooks at confirm and remap', async () => {
    for (const workbook of [dimensionBomb(), coordinateBomb()]) {
      await expect(parseBuffer(workbook, { columnMapping: MAPPING, fileExt: 'xlsx' })).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(allocate).not.toHaveBeenCalled();
  });

  // Each shape hides XFD1048576 from a regex while the library's XML parser
  // (and parseCellCoordinates) still reads it. The last two are why 5e9c444
  // was reverted or would have been: "XFD 1048576" is trimmed to XFD1048576
  // by the library, and "&#88;" is decoded to "X" by the XML parser. The
  // guard measures with the library's own steps, so it cannot disagree.
  it.each([
    ['a decoy reference inside another attribute', `<c foo=" r='A1'" r="XFD1048576" t="inlineStr"><is><t>x</t></is></c>`],
    ['a ">" inside another attribute\'s value', '<c foo="a>b" r="XFD1048576" t="inlineStr"><is><t>x</t></is></c>'],
    ['a space inside the reference', '<c r="XFD 1048576" t="inlineStr"><is><t>x</t></is></c>'],
    ['an entity-encoded reference', '<c r="&#88;FD1048576" t="inlineStr"><is><t>x</t></is></c>'],
  ])('is not fooled by %s', async (label, cell) => {
    const workbook = xlsxWith([HEADER], { extraRowsXml: lastRow(cell) });
    await expect(previewBuffer(workbook, 'xlsx')).rejects.toMatchObject({ statusCode: 400 });
    expect(allocate).not.toHaveBeenCalled();
  });

  it('[budget] refuses a sheet of unterminated tags in linear time, as a 400', async () => {
    // 5e9c444's [^>]*? ran past "<", so this made its scan quadratic. About 1 MB of tags.
    // The XML parser stops at the first unescaped "<" in an attribute; that is a
    // broken file, which is the owner's problem to hear about, not a 500.
    const workbook = xlsxWith([HEADER], { extraRowsXml: '<c '.repeat(350_000) });
    const outcome = await measureBudget(() => previewBuffer(workbook, 'xlsx'));
    console.log(`unterminated tags (${(workbook.length / 1e6).toFixed(1)} MB): ${outcome.elapsedMs.toFixed(0)} ms`);
    expect(outcome.error).toMatchObject({ statusCode: 400 });
    expect(outcome.error.message).toMatch(/could not be read/i);
    expect(allocate).not.toHaveBeenCalled();
    expect(outcome.elapsedMs).toBeLessThan(100);
  });

  it('refuses a cell with an undeclared namespace prefix as a 400, not a crash', async () => {
    const workbook = xlsxWith([HEADER], { extraRowsXml: lastRow('<x:c r="XFD1048576" t="inlineStr"><is><t>x</t></is></x:c>') });
    await expect(previewBuffer(workbook, 'xlsx')).rejects.toMatchObject({ statusCode: 400 });
    expect(allocate).not.toHaveBeenCalled();
  });

  it('ignores a large second tab, which the import never reads', async () => {
    const workbook = xlsxWith([HEADER, SALE], { secondSheet: { dimension: 'A1:Z20000' } });
    const preview = await previewBuffer(workbook, 'xlsx');
    expect(preview.headers).toEqual(HEADER);
    expect(allocate).toHaveBeenCalledTimes(1);
  });

  it('resolves sheet 1 the way the library does, so a comment in the workbook part changes nothing', async () => {
    // A comment in xl/workbook.xml could hide or fake a <sheet> from a regex;
    // the guard reads it with the library's own XML parser, so the small first
    // sheet is still the one read and the big second tab is still ignored.
    const workbook = xlsxWith([HEADER, SALE], { secondSheet: { dimension: 'A1:XFD1048576' }, workbookComment: true });
    const preview = await previewBuffer(workbook, 'xlsx');
    expect(preview.headers).toEqual(HEADER);
    expect(allocate).toHaveBeenCalledTimes(1);
  });

  it('[budget] accepts a declared size whose cost is exactly the budget', async () => {
    // rows x (columns + 8) = 100,000 x (92 + 8) = 10,000,000 slots: allocated
    // (about 80 MB, then freed); the reader then trims the empty rows, as it
    // does for a real export that overstates its size (A1:Z65536).
    const outcome = await measureBudget(() => previewBuffer(xlsxWith([HEADER, SALE], { dimension: 'A1:CN100000' }), 'xlsx'));
    console.log(`at the budget (A1:CN100000): ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB`);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result.headers).toEqual(HEADER);
    expect(allocate).toHaveBeenCalledTimes(1);
  });

  it('reads an ordinary workbook exactly as before', async () => {
    const preview = await previewBuffer(xlsxWith([HEADER, SALE], { deflate: true }), 'xlsx');
    expect(preview.headers).toEqual(HEADER);
    expect(preview.sampleRows[0]).toMatchObject({ Receipt: 'R1', Items: '1 x Latte', Total: '38.00' });
    expect(allocate).toHaveBeenCalledTimes(1);
  });
});
