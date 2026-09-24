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
