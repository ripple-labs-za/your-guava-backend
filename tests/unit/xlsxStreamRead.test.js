// BE-01-T04: sheet 1 and the shared-string table are read as a stream that stops at the budget, never as a DOM.
// The DOM the reader built cost about 3 KB per cell (450 MB for a real 10,000 x 16 export; a 20 MB sheet entry ~1.5 GB); the
// stream keeps only the cells. Fidelity is proven against the reader's own DOM steps on every shape of workbook.
const path = require('path');
const fs = require('fs');
const {
  readWorkbook, streamXlsxSheetCells, streamXlsxSharedStrings, parserLimits, xlsxPartTooLargeError,
} = require('../../src/services/parser.service');
const { previewBuffer } = require('../../src/services/ingestion.service');
const { xlsxWith, buildZip } = require('../helpers/xlsx');
const { measureBudget } = require('../helpers/budget');

// read-excel-file 9.2.0's own DOM steps, the reference the stream must agree with.
const READER = path.join(path.dirname(require.resolve('read-excel-file/node')), '..', 'commonjs');
const step = (file) => require(path.join(READER, file)).default;
const readerXml = step('xml/xml.js');
const parseCells = step('xlsx/parseCells.js');
const parseSharedStrings = step('xlsx/parseSharedStrings.js');
const parseStyles = step('xlsx/parseStyles.js');
const parseSheetDimensions = step('xlsx/parseSheetDimensions.js');
const unpackXlsxFile = step('export/unpackXlsxFileNode.js');

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OPTIONS = { sheets: [1] };
const HEADER = ['Receipt', 'Date', 'Items', 'Total'];
const SALE = ['R1', '2026-04-01', '1 x Latte', '38.00'];
const CORPUS = process.env.B90_XLSX_CORPUS; // optional: a folder of real Excel-written workbooks

const domReference = async (workbook) => {
  const contents = await unpackXlsxFile(workbook);
  const sharedStrings = contents['xl/sharedStrings.xml'] ? parseSharedStrings(contents['xl/sharedStrings.xml'], readerXml) : [];
  const styles = contents['xl/styles.xml'] ? parseStyles(contents['xl/styles.xml'], readerXml) : {};
  const sheet = readerXml.createDocument(contents['xl/worksheets/sheet1.xml']);
  return {
    sharedStrings,
    cells: parseCells(sheet, sharedStrings, styles, false, OPTIONS),
    dimensions: parseSheetDimensions(sheet),
    sheetXml: contents['xl/worksheets/sheet1.xml'],
    sharedStringsXml: contents['xl/sharedStrings.xml'],
    styles,
  };
};
const streamed = async (workbook) => {
  const reference = await domReference(workbook);
  const sharedStrings = reference.sharedStringsXml ? streamXlsxSharedStrings(reference.sharedStringsXml) : [];
  const { cells, dimensions } = streamXlsxSheetCells(reference.sheetXml, {
    sharedStrings, styles: reference.styles, epoch1904: false, options: OPTIONS, limits: parserLimits(),
  });
  return { reference, sharedStrings, cells, dimensions };
};

// A hand-written sheet with every cell shape the reader understands, plus the
// shapes its DOM helpers ignore (a cell not directly under its row, a prefixed
// element with a declared prefix, a formula, rich-text inline strings).
const SHAPES_SHEET = [
  XML_HEAD, `<worksheet xmlns="${MAIN_NS}" xmlns:x="${MAIN_NS}"><dimension ref="A1:H4"/><sheetData>`,
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t xml:space="preserve">  spaced &amp; escaped &#88;  </t></is></c>',
  '<c r="C1"><v>38.5</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="str"><f>A1&amp;B1</f><v>formula text</v></c>',
  '<c r="F1" t="e"><v>#DIV/0!</v></c><c r="G1" t="z"/><c r="H1" s="1"><v>45000</v></c></row>',
  '<row r="2"><x:c r="A2" t="s"><x:v>1</x:v></x:c><c r="B2"/><c r="C2"><v></v></c><foo><c r="D2"><v>9</v></c></foo><c r="E2" t="d"><v>2026-04-01T00:00:00.000Z</v></c></row>',
  '<row r="4"><c r="C4" t="inlineStr"><is><t>plain</t></is></c></row>',
  '</sheetData></worksheet>',
].join('');
const SHAPES_SST = `${XML_HEAD}<sst xmlns="${MAIN_NS}" count="2" uniqueCount="2"><si><t>first</t></si><si><r><rPr><b/></rPr><t>rich </t></r><r><t xml:space="preserve">run </t></r></si><si><t xml:space="preserve"> pad </t></si></sst>`;
const SHAPES_STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
const workbookFromParts = ({ sheet, sst, styles }) => buildZip([
  { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
  { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
  { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${sst ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : ''}${styles ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : ''}</Relationships>` },
  { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ...(sst ? [{ name: 'xl/sharedStrings.xml', data: sst }] : []),
  ...(styles ? [{ name: 'xl/styles.xml', data: styles }] : []),
], { deflate: true });

describe('sheet 1 is streamed, not built as a DOM', () => {
  afterEach(() => {
    delete process.env.UPLOAD_MAX_ROWS;
    delete process.env.UPLOAD_MAX_COLUMNS;
    delete process.env.XLSX_MAX_PART_BYTES;
  });

  it('agrees with the reader on every cell shape, shared strings and the dimension', async () => {
    const { reference, sharedStrings, cells, dimensions } = await streamed(workbookFromParts({ sheet: SHAPES_SHEET, sst: SHAPES_SST, styles: SHAPES_STYLES }));
    expect(sharedStrings).toEqual(reference.sharedStrings);
    expect(cells).toEqual(reference.cells);
    expect(dimensions).toEqual(reference.dimensions);
    expect(cells.map((c) => `${c.row}:${c.column}`)).toEqual(['1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:8', '2:1', '2:2', '2:3', '2:5', '4:3']);
    expect(cells[7].value).toBeInstanceOf(Date); // s="1" is the yyyy-mm-dd style
  });

  it('agrees with the reader on generated workbooks with and without shared strings', async () => {
    for (const options of [{}, { sharedStrings: true }, { dimension: 'A1:Z65536' }, { sharedStrings: true, deflate: true }]) {
      const { reference, cells, dimensions, sharedStrings } = await streamed(xlsxWith([HEADER, SALE, ['R2', '2026-04-02', '2 x Flat White', '76.00']], options));
      expect(cells).toEqual(reference.cells);
      expect(dimensions).toEqual(reference.dimensions);
      expect(sharedStrings).toEqual(reference.sharedStrings);
    }
  });

  it('agrees with the reader on every real workbook in the corpus, when one is given', async () => {
    if (!CORPUS) { console.log('B90_XLSX_CORPUS not set; corpus parity skipped'); return; }
    const files = fs.readdirSync(CORPUS).filter((f) => /\.xlsx$/i.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const workbook = fs.readFileSync(path.join(CORPUS, file));
      const { reference, cells, dimensions, sharedStrings } = await streamed(workbook);
      expect({ file, n: cells.length, cells, dimensions, sharedStrings }).toEqual({ file, n: reference.cells.length, cells: reference.cells, dimensions: reference.dimensions, sharedStrings: reference.sharedStrings });
    }
    console.log(`corpus parity: ${files.length} workbooks`);
  });

  it('[budget] reads a 10,000 x 25 inline-string sheet (16 MB of XML) inside 250 MB of heap', async () => {
    // The DOM the reader built for this sheet grew the heap by ~1,100 MB (evidence/BE-01-T04/stream-vs-dom.txt); what is
    // measured here includes the 250,000-cell result itself and whatever garbage the collector has not yet reclaimed.
    const rows = [Array.from({ length: 25 }, (_, index) => `C${index}`)];
    for (let r = 0; r < 9_999; r += 1) rows.push(Array.from({ length: 25 }, () => 'x'));
    const workbook = xlsxWith(rows, { deflate: true });
    await readWorkbook(xlsxWith([HEADER, SALE])); // warm the reader
    const outcome = await measureBudget(() => readWorkbook(workbook));
    console.log(`10,000 x 25 inline: ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB`);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result.rows).toHaveLength(9_999);
    expect(outcome.result.headers).toHaveLength(25);
    expect(outcome.heapGrowthMb).toBeLessThan(250);
    // Memory is this card's budget; the time is mostly readWorkbook's per-cell normalisation (BE-03-T13, ISSUES #8).
    // The stream itself reads these 250,000 cells in ~3.3 s against the DOM's 3.9 s (evidence/BE-01-T04/stream-vs-dom.txt).
    expect(outcome.elapsedMs).toBeLessThan(20_000);
  });

  it('[budget] reads a 10,000 x 16 shared-string export, the shape of a real Excel file, inside 100 MB of heap', async () => {
    const rows = [Array.from({ length: 16 }, (_, index) => `Column ${index}`)];
    for (let r = 0; r < 10_000; r += 1) rows.push(Array.from({ length: 16 }, (_, c) => (c % 3 ? `text ${r % 50}` : String(r * c))));
    const workbook = xlsxWith(rows, { sharedStrings: true, deflate: true });
    const outcome = await measureBudget(() => readWorkbook(workbook));
    console.log(`10,000 x 16 shared: ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB`);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result.rows).toHaveLength(10_000);
    expect(outcome.heapGrowthMb).toBeLessThan(100);
  });

  it('[budget] reads a workbook whose shared-string table is 600,000 entries (a large second tab would make one) inside 150 MB', async () => {
    const items = Array.from({ length: 600_000 }, (_, i) => `<si><t>s${i}</t></si>`).join('');
    const sst = `${XML_HEAD}<sst xmlns="${MAIN_NS}" count="600000" uniqueCount="600000">${items}</sst>`;
    const sheet = `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>599999</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c></row></sheetData></worksheet>`;
    const workbook = workbookFromParts({ sheet, sst });
    const outcome = await measureBudget(() => readWorkbook(workbook));
    console.log(`600,000 shared strings (${(sst.length / 1e6).toFixed(1)} MB): ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB`);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual({ headers: ['s0', 's599999'], rows: [expect.objectContaining({ s0: 's1', s599999: 's2' })] });
    expect(outcome.heapGrowthMb).toBeLessThan(150);
  });

  it('stops at the cell budget with the row-limit wording the portal turns into split advice', async () => {
    process.env.UPLOAD_MAX_ROWS = '10';
    process.env.UPLOAD_MAX_COLUMNS = '5';
    const rows = [['A', 'B', 'C', 'D', 'E']];
    for (let r = 0; r < 12; r += 1) rows.push(['1', '2', '3', '4', '5']);
    await expect(readWorkbook(xlsxWith(rows))).rejects.toMatchObject({ statusCode: 400, message: 'File exceeds the 10 row limit' });
  });

  it('stops at the cell budget with the column-limit wording when the width is the problem', async () => {
    process.env.UPLOAD_MAX_ROWS = '10';
    process.env.UPLOAD_MAX_COLUMNS = '5';
    const rows = [];
    for (let r = 0; r < 9; r += 1) rows.push(['1', '2', '3', '4', '5', '6', '7']);
    await expect(readWorkbook(xlsxWith(rows))).rejects.toMatchObject({ statusCode: 400, message: 'File exceeds the 5 column limit' });
  });

  it('refuses a styles part too large to build as a DOM before building it', async () => {
    const styles = SHAPES_STYLES.replace('</styleSheet>', `${'<!-- padding -->'.repeat(300_000)}</styleSheet>`);
    expect(styles.length).toBeGreaterThan(4 * 1024 * 1024);
    const workbook = workbookFromParts({ sheet: SHAPES_SHEET, sst: SHAPES_SST, styles });
    await expect(readWorkbook(workbook)).rejects.toMatchObject({ statusCode: 400, code: 'XLSX_PART_TOO_LARGE' });
    process.env.XLSX_MAX_PART_BYTES = String(8 * 1024 * 1024);
    await expect(readWorkbook(workbook)).resolves.toMatchObject({ headers: expect.arrayContaining(['first']) });
  });

  it('still refuses the declared-size bombs before allocation, and a broken sheet as a 400', async () => {
    for (const options of [{ dimension: 'A1:XFD1048576' }, { extraRowsXml: '<row r="1048576"><c r="XFD 1048576" t="inlineStr"><is><t>x</t></is></c></row>' }]) {
      await expect(readWorkbook(xlsxWith([HEADER], options))).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/too large to read safely/) });
    }
    await expect(readWorkbook(xlsxWith([HEADER], { extraRowsXml: '<c '.repeat(350_000) }))).rejects.toMatchObject({ statusCode: 400, code: 'XLSX_UNREADABLE' });
    await expect(readWorkbook(xlsxWith([HEADER], { extraRowsXml: '<row r="2"><y:c r="A2"><v>1</v></y:c></row>' }))).rejects.toMatchObject({ statusCode: 400, code: 'XLSX_UNREADABLE' });
  });

  it("borrows the SAX reader from the @xmldom/xmldom line it was written against", () => {
    // loadXmldom loads lib/sax.js, entities.js, conventions.js and errors.js by path and duck-types them; read-excel-file allows
    // ^0.9.10, so a lockfile refresh onto another line must fail here, loudly, before it reaches production.
    const lib = path.dirname(require.resolve('@xmldom/xmldom', { paths: [path.dirname(require.resolve('read-excel-file/node'))] }));
    const { version } = JSON.parse(fs.readFileSync(path.join(lib, '..', 'package.json'), 'utf8'));
    expect(version).toMatch(/^0\.9\./);
  });

  it('previews an ordinary workbook exactly as before', async () => {
    const preview = await previewBuffer(xlsxWith([HEADER, SALE], { sharedStrings: true, deflate: true }), 'xlsx');
    expect(preview.headers).toEqual(HEADER);
    expect(preview.sampleRows[0]).toMatchObject({ Receipt: 'R1', Items: '1 x Latte', Total: '38.00' });
    expect(typeof xlsxPartTooLargeError).toBe('function');
  });
});
