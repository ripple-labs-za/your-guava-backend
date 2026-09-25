const zlib = require('zlib');
const { parseBuffer } = require('../../src/services/parser.service');
const { previewBuffer } = require('../../src/services/ingestion.service');

// The in-process parse, not a worker dispatch: a spy in this process cannot see inside a worker (BE-01-T04).
const parseInProcess = (() => {
  try { return require('../../src/services/parser/parse').parseBuffer; } catch { return parseBuffer; }
})();

const ZONE = 'Africa/Johannesburg';
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const csvRows = (count) => Buffer.from(['Receipt,Date,Time,Items,Total', ...Array.from({ length: count }, (_, i) =>
  `R${i},2026-09-${String((i % 28) + 1).padStart(2, '0')},${String(8 + (i % 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},1 x Latte;${(i % 3) + 1} x Muffin,${(40 + i % 50).toFixed(2)}`)].join('\n'));

const countFormatters = async (fn) => {
  const spy = jest.spyOn(Intl, 'DateTimeFormat');
  try { const result = await fn(); return { result, constructed: spy.mock.calls.length }; } finally { spy.mockRestore(); }
};
const countEnvReads = async (name, fn) => {
  const realEnv = process.env; let reads = 0;
  process.env = new Proxy(realEnv, { get(target, key) { if (key === name) reads += 1; return target[key]; } });
  try { return { result: await fn(), reads }; } finally { process.env = realEnv; }
};

// A minimal .xlsx whose five entries are DEFLATED (method 8), so validation must inflate each one.
const deflatedXlsx = (rows) => {
  const ns = 'http://schemas.openxmlformats.org';
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`).join('');
  const rel = (type, target) => `<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const entries = [
    ['[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="${ns}/package/2006/relationships">${rel('officeDocument', 'xl/workbook.xml')}</Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${ns}/package/2006/relationships">${rel('worksheet', 'worksheets/sheet1.xml')}</Relationships>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name); const raw = Buffer.from(text); const d = zlib.deflateRawSync(raw); const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30 + n.length + d.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(d.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    n.copy(local, 30); d.copy(local, 30 + n.length); locals.push(local);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(d.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42); n.copy(central, 46); centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};
const workbook = () => deflatedXlsx([['Receipt', 'Date', 'Items', 'Total'],
  ...Array.from({ length: 200 }, (_, i) => [`X${i}`, '2026-09-01', '1 x Latte', '38.00'])]);

describe('the import parse costs a constant, not a per-row, amount of set-up', () => {
  it('builds a bounded number of date formatters for 2,000 rows', async () => {
    const { result, constructed } = await countFormatters(() =>
      parseInProcess(csvRows(2000), { columnMapping: MAPPING, itemsMode: 'packed', fileExt: 'csv', timezone: ZONE }));
    expect(result.rows).toHaveLength(2000);
    expect(constructed).toBeLessThanOrEqual(5);
  });

  it('reads the upload limits from the environment once per parse, not once per cell', async () => {
    const { result, reads } = await countEnvReads('UPLOAD_MAX_CELL_CHARS', () =>
      parseInProcess(csvRows(2000), { columnMapping: MAPPING, itemsMode: 'packed', fileExt: 'csv', timezone: ZONE }));
    expect(result.rows).toHaveLength(2000);
    expect(reads).toBeLessThanOrEqual(5);
  });

  it('inflates each XLSX entry once per parse', async () => {
    const inflate = jest.spyOn(zlib, 'inflateRawSync');
    const result = await parseInProcess(workbook(), { columnMapping: { receiptId: 'Receipt', date: 'Date', items: 'Items', total: 'Total' }, itemsMode: 'packed', fileExt: 'xlsx', timezone: ZONE });
    expect(result.rows).toHaveLength(200);
    expect(inflate.mock.calls.length).toBe(5);
    inflate.mockRestore();
  });

  it('inflates each XLSX entry once while staging an upload preview', async () => {
    const inflate = jest.spyOn(zlib, 'inflateRawSync');
    const preview = await previewBuffer(workbook(), 'xlsx');
    expect(preview.headers).toEqual(['Receipt', 'Date', 'Items', 'Total']);
    expect(inflate.mock.calls.length).toBe(5);
    inflate.mockRestore();
  });

  it('still refuses a tampered archive every time it is asked', async () => {
    const bad = workbook(); bad[bad.length - 30] ^= 0xff; // corrupt the central directory
    const { assertSupportedFileBuffer } = require('../../src/services/parser.service');
    expect(() => assertSupportedFileBuffer(bad, 'xlsx')).toThrow();
    expect(() => assertSupportedFileBuffer(bad, 'xlsx')).toThrow();
  });
});
