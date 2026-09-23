const { previewBuffer } = require('../../src/services/ingestion.service');
const { readCsv } = require('../../src/services/parser.service');
const { parseBuffer } = require('../../src/services/parser.service');

const LF = String.fromCharCode(10);
const csvOf = (lines) => Buffer.from(lines.join(LF));

// The wizard's preview had its own CSV reader, and it drifted from the one the
// import uses. Whatever the owner maps in the wizard has to be the column the
// import reads, so the preview must see a file exactly as the import does.
describe('upload preview reads a CSV the way the import does', () => {
  it('does not take an Excel "sep=" line for the header row', async () => {
    // Production upload 6a3289a4 showed headers ["sep=", ""]. b1d532c taught
    // the import to skip the line; the preview still read it as the header
    // row, so the owner could not map a single column and never got to import.
    const semicolonExport = csvOf([
      'sep=;',
      'Receipt;Date;Time;Status;Items;Total (incl. tax)',
      '1001;2026/09/14;09:00:00;Approved;1 x Flat White;38.00',
    ]);

    const { headers, sampleRows } = await previewBuffer(semicolonExport, 'csv');

    expect(headers).toEqual(['Receipt', 'Date', 'Time', 'Status', 'Items', 'Total (incl. tax)']);
    expect(sampleRows[0]).toMatchObject({ Receipt: '1001', 'Total (incl. tax)': '38.00' });
    expect((await readCsv(semicolonExport)).headers).toEqual(headers);
  });

  it('names a repeated column the way the import will read it', async () => {
    // Two "Total" columns: the preview showed one name with one column's
    // money, and the import read the other column.
    const twoTotals = csvOf([
      'Receipt,Date,Time,Status,Items,Total,Total',
      '1001,2026/09/14,09:00:00,Approved,1 x Flat White,38.00,40.00',
    ]);

    const { headers, sampleRows } = await previewBuffer(twoTotals, 'csv');

    expect(headers).toEqual(['Receipt', 'Date', 'Time', 'Status', 'Items', 'Total', 'Total (2)']);
    expect(sampleRows[0]).toMatchObject({ Total: '38.00', 'Total (2)': '40.00' });
    expect((await readCsv(twoTotals)).headers).toEqual(headers);

    // The column picked in the wizard is the column that is imported.
    const parsed = await parseBuffer(twoTotals, {
      columnMapping: {
        receiptId: 'Receipt', date: 'Date', time: 'Time', status: 'Status', items: 'Items', total: 'Total (2)',
      },
      fileExt: 'csv',
    });
    expect(parsed.rows[0].total).toBe(40);
  });
});
