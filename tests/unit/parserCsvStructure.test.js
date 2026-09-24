const zlib = require('zlib');
const { performance } = require('perf_hooks');
const { parseBuffer, readWorkbook, parserLimits } = require('../../src/services/parser.service');
const { previewBuffer } = require('../../src/services/ingestion.service');

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const PACKED = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const parse = (buffer, columnMapping = PACKED) =>
  parseBuffer(buffer, { columnMapping, itemsMode: 'packed', fileExt: 'csv' });

// Windows-1252 bytes built by hand. 0x92 (’) does not exist in Latin-1, so passing proves real 1252 decoding.
const cp1252 = (text) => Buffer.from([...text].map((ch) => (ch === '’' ? 0x92 : ch.charCodeAt(0))));

// A minimal stored-ZIP .xlsx, the same construction as `xlsxWith` in parser.service.test.js.
const storedZip = (entries) => {
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name); const d = Buffer.from(data); const crc = zlib.crc32(d) >>> 0;
    const local = Buffer.alloc(30 + n.length + d.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    n.copy(local, 30); d.copy(local, 30 + n.length); locals.push(local);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(d.length, 20); central.writeUInt32LE(d.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42); n.copy(central, 46); centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};
const xlsxWith = (rows) => {
  const ns = 'http://schemas.openxmlformats.org';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) =>
    `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('');
  const rel = (type, target) => `<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  return storedZip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0"?><Relationships xmlns="${ns}/package/2006/relationships">${rel('officeDocument', 'xl/workbook.xml')}</Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships xmlns="${ns}/package/2006/relationships">${rel('worksheet', 'worksheets/sheet1.xml')}</Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0"?><worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` },
  ]);
};

describe('encodings a till actually writes', () => {
  it('reads a Windows-1252 export without mojibake and keeps its × quantities', async () => {
    const result = await parse(cp1252([
      'Receipt,Date,Time,Items,Total',
      'R1,2026-09-01,09:00,1 x Crème brûlée,45.00',
      'R2,2026-09-01,09:05,2 × Latte,76.00',
      'R3,2026-09-01,09:10,1 x Mama’s Muffin,32.00',
    ].join(CRLF)));

    expect(result.encoding).toBe('windows-1252');
    expect(result.errors).toBe(0);
    expect(result.rows.map((row) => row.items[0])).toEqual([
      expect.objectContaining({ name: 'Crème brûlée', quantity: 1 }),
      expect.objectContaining({ name: 'Latte', quantity: 2 }),
      expect.objectContaining({ name: 'Mama’s Muffin', quantity: 1 }),
    ]);
  });

  it('previews the same Windows-1252 names the import will store', async () => {
    const preview = await previewBuffer(cp1252(['Receipt,Date,Items,Total', 'R1,2026-09-01,1 x Crème brûlée,45.00'].join(LF)), 'csv');
    expect(preview.sampleRows[0].Items).toBe('1 x Crème brûlée');
  });

  it('leaves a valid UTF-8 file alone', async () => {
    const result = await parse(Buffer.from(['Receipt,Date,Time,Items,Total', 'R1,2026-09-01,09:00,1 x Crème brûlée,45.00'].join(LF)));
    expect(result.encoding).toBe('utf-8');
    expect(result.rows[0].items[0].name).toBe('Crème brûlée');
  });

  it('reads a UTF-16LE export with a BOM instead of calling it binary', async () => {
    const text = ['Receipt,Date,Time,Items,Total', 'R1,2026-09-01,09:00,2 × Latte,76.00'].join(CRLF);
    const result = await parse(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    expect(result.encoding).toBe('utf-16le');
    expect(result.rows[0].items[0]).toMatchObject({ name: 'Latte', quantity: 2 });
  });
});

describe('BOM and quoted headers', () => {
  it('finds a quoted first header behind a UTF-8 BOM', async () => {
    const body = ['"Receipt","Date","Time","Items","Total"', '"R1","2026-09-01","09:00","1 x Latte","38.00"'].join(LF);
    const file = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]);
    expect((await previewBuffer(file, 'csv')).headers).toEqual(['Receipt', 'Date', 'Time', 'Items', 'Total']);
    expect((await parse(file)).rows[0].receiptId).toBe('R1');
  });
});

describe('a stray inch mark does not swallow the rows after it', () => {
  it('imports every row and keeps the inch mark in the name', async () => {
    const result = await parse(Buffer.from([
      'Receipt,Date,Time,Items,Total',
      'P1,2026-09-01,12:00,1 x 12" Margherita,120.00',
      'P2,2026-09-01,12:05,1 x Latte,38.00',
      'P3,2026-09-01,12:10,1 x 9" Four Seasons,95.00',
      'P4,2026-09-01,12:15,2 x Cappuccino,70.00',
    ].join(LF)));
    expect(result.totalRows).toBe(4);
    expect(result.errors).toBe(0);
    expect(result.rows.map((row) => row.receiptId)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(result.rows[0].items[0].name).toBe('12" Margherita');
  });

  it('still reads a correctly quoted cell with a doubled quote and a newline inside', async () => {
    const result = await parse(Buffer.from([
      'Receipt,Date,Time,Items,Total',
      `Q1,2026-09-01,12:00,"1 x 12"" Margherita${LF}1 x Latte",158.00`,
      'Q2,2026-09-01,12:05,1 x Latte,38.00',
    ].join(LF)));
    expect(result.rows.map((row) => row.items.map((item) => item.name))).toEqual([['12" Margherita', 'Latte'], ['Latte']]);
  });

  it('recovers the rows behind an opening quote that never closes, and accounts for every line', async () => {
    const result = await parse(Buffer.from([
      'Receipt,Date,Time,Items,Total',
      'U1,2026-09-01,12:00,"1 x Latte,38.00',
      'U2,2026-09-01,12:05,1 x Latte,38.00',
      'U3,2026-09-01,12:10,1 x Latte,38.00',
    ].join(LF)));
    expect(result.totalRows).toBe(3);
    expect(result.rows.length + result.errors).toBe(3);
    expect(result.rows.map((row) => row.receiptId)).toEqual(expect.arrayContaining(['U2', 'U3']));
  });

  it('prepares 10 MB of inch marks in linear time', () => {
    const { prepareCsv } = require('../../src/services/parser/csvStructure');
    const line = `X1,2026-09-01,12:00,1 x 12" "Pizza" 9",120.00${LF}`;
    const file = Buffer.from(`Receipt,Date,Time,Items,Total${LF}${line.repeat(Math.floor(10e6 / line.length))}`);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const prepared = prepareCsv(file, parserLimits());
    expect(performance.now() - started).toBeLessThan(1500);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
    expect(prepared.expectedRecords).toBe(Math.floor(10e6 / line.length));
  });

  it('refuses 10 MB of never-closing quotes in linear time with a 400', () => {
    const { prepareCsv } = require('../../src/services/parser/csvStructure');
    const line = `"abc,def${LF}`;
    const file = Buffer.from(`A,B${LF}${line.repeat(Math.floor(10e6 / line.length))}`);
    const started = performance.now();
    expect(() => prepareCsv(file, parserLimits())).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('blank lines', () => {
  it('skips blank and separator-only lines without errors and keeps file line numbers', async () => {
    const text = ['Date,Items,Total', '2026-09-01,1 x Latte,38', '', '2026-09-02,1 x Latte,38', ',,', ''].join(LF);
    const result = await parse(Buffer.from(text), { date: 'Date', items: 'Items', total: 'Total' });
    expect(result.errors).toBe(0);
    expect(result.totalRows).toBe(2);
    expect(result.rows.map((row) => row.__sourceRowNumbers)).toEqual([[2], [4]]);
  });
});

describe('report-style exports with title lines', () => {
  const REPORT = [
    'Sales Report', 'From 01/09/2026 to 14/09/2026', '',
    'Receipt;Date;Time;Items;Total', 'R1;2026-09-01;09:00;1 x Latte;38,00', 'R2;2026-09-01;09:30;1 x Muffin;30,00',
  ].join(LF);

  it('finds the header row below the title lines and takes the separator from it', async () => {
    expect((await previewBuffer(Buffer.from(REPORT), 'csv')).headers).toEqual(['Receipt', 'Date', 'Time', 'Items', 'Total']);
    const result = await parse(Buffer.from(REPORT));
    expect(result.rows.map((row) => row.total)).toEqual([38, 30]);
    expect(result.rows[0].__sourceRowNumbers).toEqual([5]);
  });

  it('finds the header row of a workbook that opens with a title', async () => {
    const { headers, rows } = await readWorkbook(xlsxWith([
      ['Sales Report'], ['From 01/09/2026 to 14/09/2026'], [],
      ['Receipt', 'Date', 'Items', 'Total'], ['R1', '2026-09-01', '1 x Latte', '38.00'],
    ]));
    expect(headers).toEqual(['Receipt', 'Date', 'Items', 'Total']);
    expect(rows[0]).toMatchObject({ Receipt: 'R1', Total: '38.00' });
    expect(rows[0].__sourceRowNumbers).toEqual([5]);
  });

  it('reads an ordinary file whose first line is the header exactly as before', async () => {
    const result = await parse(Buffer.from(['Receipt,Date,Time,Items,Total', 'R1,2026-09-01,09:00,1 x Latte,38.00'].join(LF)));
    expect(result.rows[0].__sourceRowNumbers).toEqual([2]);
  });
});

describe('overflow cells are folded into Items only when they look like items', () => {
  const MAP = { date: 'Date', items: 'Items', total: 'Total' };

  it('repairs an unquoted multi-item cell', async () => {
    const result = await parse(Buffer.from(['Date,Items,Total', '2026-09-14,1 x Latte,2 x Muffin,88.00'].join(LF)), MAP);
    expect(result.rows[0].total).toBe(88);
    expect(result.rows[0].items.map((item) => item.name)).toEqual(['Latte', 'Muffin']);
  });

  it('refuses to guess when the extra cell is a number, and names the row', async () => {
    const result = await parse(Buffer.from(['Date,Items,Total', '2026-09-14,1 x Latte,38,50'].join(LF)), MAP);
    expect(result.rows).toHaveLength(0);
    expect(result.errors).toBe(1);
    expect(result.rowErrors[0]).toMatchObject({
      rowNumber: 2,
      reason: expect.stringMatching(/1 more cell than there are column headings/),
    });
  });
});

describe('a file with no quotation marks at all', () => {
  const { normaliseCsvQuotes } = require('../../src/services/parser/csvStructure');
  const opts = { maxQuotedFieldBytes: 1024 };

  it.each([
    ['a,b\n1,2\n3,4\n', 3],
    ['a,b\r\n1,2\r\n\r\n3,4', 3],
    ['a,b\n\n\n1,2\n,,\n', 3],
    // csv-parser ends a record at LF only, so a CR-only file is one record to it and must be one here (review of BE-03-T08).
    ['a,b\r1,2\r3,4\r', 1],
    ['', 0],
    ['\n\n', 0],
  ])('counts the records of %j exactly as the full scan does, and returns the bytes untouched', (text, records) => {
    const buffer = Buffer.from(text);
    const result = normaliseCsvQuotes(buffer, ',', opts);
    expect(result).toEqual({ buffer, repairedFields: 0, records });
    // The full scan, forced by a quoted cell prefixed to the first line, agrees (that prefix fills an empty first line).
    const firstLineEmpty = text.split(/\r\n|\r|\n/)[0] === '';
    expect(normaliseCsvQuotes(Buffer.from(`"x",${text}`), ',', opts).records).toBe(records + (firstLineEmpty ? 1 : 0));
  });

  it('scans 10 MB of one quote-free line quickly', () => {
    const buffer = Buffer.alloc(10 * 1024 * 1024, 'a');
    const started = performance.now();
    expect(normaliseCsvQuotes(buffer, ',', opts).records).toBe(1);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

// Review of BE-03-T08 (BLOCK): shapes the first tests and fixtures could not reach.
describe('review of BE-03-T08', () => {
  const { normaliseCsvQuotes, prepareCsv } = require('../../src/services/parser/csvStructure');
  const { decodeCsvBuffer } = require('../../src/services/parser/encoding');
  const MAP3 = { date: 'Date', items: 'Items', total: 'Total' };

  it('counts the records of 2 MB of short LF-only lines in linear time', () => {
    const buffer = Buffer.from('a,b\n'.repeat(512 * 1024));
    const started = performance.now();
    expect(normaliseCsvQuotes(buffer, ',', { maxQuotedFieldBytes: 1024 }).records).toBe(512 * 1024);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it.each([
    ['a ; file whose first sale has two unquoted-comma items', ['Date;Items;Total', '2026-09-01;"1 x Latte, 1 x Muffin";76,00', '2026-09-02;1 x Latte;38,00']],
    ['a tab file whose first sale has unquoted comma items', ['Date\tItems\tTotal', '2026-09-01\t1 x Latte, 1 x Muffin, 1 x Tea\t106.00', '2026-09-02\t1 x Latte\t38.00']],
    ['a comma file whose items are joined with |', ['Date,Items,Total', '2026-09-01,1 x Latte|1 x Muffin|1 x Tea,106.00', '2026-09-02,1 x Latte,38.00']],
  ])('keeps the header of %s', async (name, lines) => {
    const buffer = Buffer.from(lines.join(LF));
    expect((await previewBuffer(buffer, 'csv')).headers).toEqual(['Date', 'Items', 'Total']);
  });

  it('does not let a name that opens with a quote swallow the rows up to the next quoted cell', async () => {
    const result = await parse(Buffer.from([
      'Receipt,Date,Time,Items,Total',
      'U1,2026-09-01,12:00,"Big" Breakfast,85.00',
      'U2,2026-09-01,12:05,1 x Latte,38.00',
      'U3,2026-09-01,12:10,1 x Latte,38.00',
      'U4,2026-09-01,12:15,"1 x Latte, 1 x Muffin",68.00',
      'U5,2026-09-01,12:20,1 x Latte,38.00',
    ].join(LF)));
    expect(result.totalRows).toBe(5);
    expect(result.rows.map((row) => [row.receiptId, row.total])).toEqual([
      ['U1', 85], ['U2', 38], ['U3', 38], ['U4', 68], ['U5', 38],
    ]);
  });

  it('imports a 10,000-row file where 1 row in 100 names an item in quotes, instead of refusing it', async () => {
    const lines = ['Receipt,Date,Time,Items,Total'];
    for (let i = 0; i < 10000; i += 1) {
      lines.push(i % 100 === 0 ? `S${i},2026-09-01,12:00,"Special" Latte,40.00` : `S${i},2026-09-01,12:00,1 x Latte,38.00`);
    }
    const result = await parse(Buffer.from(lines.join(LF)));
    expect(result.totalRows).toBe(10000);
    expect(result.rows).toHaveLength(10000);
  });

  it('decodes a UTF-8 file with one stray Windows-1252 byte as UTF-8, mapping only that byte', () => {
    const file = Buffer.concat([Buffer.from('Items\n1 x Crème brûlée\n2 × Latte\n1 x Caf'), Buffer.from([0xe9]), Buffer.from('\n')]);
    const decoded = decodeCsvBuffer(file);
    expect(decoded.buffer.toString('utf8')).toBe('Items\n1 x Crème brûlée\n2 × Latte\n1 x Café\n');
  });

  it('refuses 10 MB of quotation marks inside the heap guard', () => {
    const buffer = Buffer.alloc(10 * 1024 * 1024, '"');
    const heapBefore = process.memoryUsage().heapUsed;
    let thrown = null;
    try { prepareCsv(Buffer.concat([Buffer.from('A,B\n'), buffer]), parserLimits()); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ statusCode: 400 });
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
  });

  it('finds a workbook header whose first data row is sparse', async () => {
    const { headers, rows } = await readWorkbook(xlsxWith([
      ['Receipt', 'Date', 'Item', 'Category', 'Payment', 'Status'],
      ['R0'],
      ['R1', '2026-09-01', 'Flat White', 'Coffee', 'Card', 'Approved'],
      ['R2', '2026-09-01', 'Latte', 'Coffee', 'Card', 'Approved'],
    ]));
    expect(headers).toEqual(['Receipt', 'Date', 'Item', 'Category', 'Payment', 'Status']);
    expect(rows).toHaveLength(3);
  });

  it('does not report a merged line for a stray carriage return inside a cell', async () => {
    const CR = String.fromCharCode(13);
    const result = await parse(Buffer.from(['Date,Items,Total', `2026-09-01,1 x Latte${CR}x,38.00`, '2026-09-02,1 x Latte,38.00'].join(LF)), MAP3);
    expect(result.errors).toBe(0);
    expect(result.totalRows).toBe(2);
  });

  it('stops reading a flood of blank lines at the row limit', async () => {
    const { readCsv } = require('../../src/services/parser/csv');
    const limits = { ...parserLimits(), maxRows: 100 };
    const buffer = Buffer.from(`A,B${LF}${`,${LF}`.repeat(1000)}1,2${LF}`);
    await expect(readCsv(buffer, { limit: 5, limits })).rejects.toMatchObject({ statusCode: 400, message: /100 row limit/ });
  });
});

// Second review of BE-03-T08 (WARN).
describe('second review of BE-03-T08', () => {
  const { prepareCsv } = require('../../src/services/parser/csvStructure');
  const { decodeCsvBuffer } = require('../../src/services/parser/encoding');
  const MAP4 = { receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total' };
  const rowsOf = (count, build) => Array.from({ length: count }, (_, index) => build(index));

  it.each([
    ['a ; file whose rows leave off the empty trailing Note column', ['Receipt;Date;Items;Total;Note', ...rowsOf(6, (i) => `R${i};2026-09-01;1 x Latte;38,00`)], ';'],
    ['a ; file with a trailing ; on the header only', ['Receipt;Date;Items;Total;', ...rowsOf(6, (i) => `R${i};2026-09-01;1 x Latte;38,00`)], ';'],
    ['a tab file with the trailing column left off and comma items', ['Receipt\tDate\tItems\tTotal\tNote', ...rowsOf(6, (i) => `R${i}\t2026-09-01\t1 x Latte, 1 x Muffin\t68.00`)], '\t'],
  ])('imports %s', async (name, lines) => {
    const result = await parse(Buffer.from(lines.join(LF)), MAP4);
    expect(result.errors).toBe(0);
    expect(result.rows).toHaveLength(6);
  });

  it('does not let a lone opening quote merge rows up to a quoted cell several lines later', async () => {
    const result = await parse(Buffer.from([
      'Receipt,Date,Time,Items,Total',
      'U1,2026-09-01,12:00,"1 x Latte,38.00',
      'U2,2026-09-01,12:05,1 x Latte,38.00',
      'U3,2026-09-01,12:10,"1 x Latte, 1 x Muffin",68.00',
    ].join(LF)));
    expect(result.totalRows).toBe(3);
    expect(result.rows.length + result.errors).toBe(3);
    const byReceipt = Object.fromEntries(result.rows.map((row) => [row.receiptId, row.total]));
    expect(byReceipt).toMatchObject({ U2: 38, U3: 68 });
  });

  it('imports a CR-only ("CSV (Macintosh)") ; file', async () => {
    const CR = String.fromCharCode(13);
    const lines = ['Receipt;Date;Items;Total', ...rowsOf(1500, (i) => `M${i};2026-09-01;1 x Latte;38,00`)];
    const result = await parse(Buffer.from(lines.join(CR)), MAP4);
    expect(result.errors).toBe(0);
    expect(result.rows).toHaveLength(1500);
  });

  it('decodes 10 MB of stray bytes around one UTF-8 pair inside the heap guard', () => {
    const file = Buffer.concat([Buffer.alloc(10 * 1024 * 1024, 0xe9), Buffer.from('é')]);
    const heapBefore = process.memoryUsage().heapUsed;
    const decoded = decodeCsvBuffer(file);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
    expect(decoded.buffer.subarray(-4).toString('utf8')).toBe('éé');
  });

  it('keeps the heap guard on 10 MB of "a"b lines', () => {
    const file = Buffer.from(`A,B${LF}${`"a"b${LF}`.repeat(2 * 1024 * 1024)}`);
    const heapBefore = process.memoryUsage().heapUsed;
    try { prepareCsv(file, parserLimits()); } catch (error) { expect(error).toMatchObject({ statusCode: 400 }); }
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
  });

  it('keeps a wide workbook header over rows that fill only some of its columns', async () => {
    const header = ['Receipt', 'Date', 'Item', 'Category', 'Payment', 'Status', 'Note', 'Staff', 'Table', 'Till', 'Shift',
      'Customer', 'Channel', 'Voucher', 'Tip', 'Total'];
    const sparse = (i) => [`R${i}`, '2026-09-01', 'Flat White', 'Coffee', 'Card', 'Approved', ...Array(9).fill(''), '38.00'];
    const { headers, rows } = await readWorkbook(xlsxWith([header, sparse(0), sparse(1), sparse(2)]));
    expect(headers).toEqual(header);
    expect(rows).toHaveLength(3);
  });

  it('does not refuse a file where most names open with a quote but every line reads cleanly', async () => {
    const lines = ['Receipt,Date,Time,Items,Total',
      ...rowsOf(3000, (i) => (i % 5 < 3 ? `B${i},2026-09-01,09:00,"Big" Breakfast,85.00` : `B${i},2026-09-01,09:00,1 x Latte,38.00`))];
    const result = await parse(Buffer.from(lines.join(LF)));
    expect(result.totalRows).toBe(3000);
    expect(result.rows).toHaveLength(3000);
  });

  it('holds a flood of empty lines to the row limit', async () => {
    const { readCsv } = require('../../src/services/parser/csv');
    const limits = { ...parserLimits(), maxRows: 100 };
    const buffer = Buffer.from(`A,B${LF}${LF.repeat(1000)}1,2${LF}`);
    await expect(readCsv(buffer, { limit: 5, limits })).rejects.toMatchObject({ statusCode: 400, message: /100 row limit/ });
  });
});

describe('reading never changes the uploaded bytes', () => {
  it('leaves a buffer with escaped quotes exactly as it was after preview and parse', async () => {
    const text = ['Receipt,Date,Time,Items,Total', 'Q1,2026-09-01,12:00,"1 x 12"" Pizza",120.00', 'Q2,2026-09-01,12:05,1 x Latte,38.00'].join(LF);
    const buffer = Buffer.from(text);
    await previewBuffer(buffer, 'csv');
    expect(buffer.toString()).toBe(text);
    const result = await parse(buffer);
    expect(buffer.toString()).toBe(text);
    expect(result.rows[0].items[0].name).toBe('12" Pizza');
  });
});
