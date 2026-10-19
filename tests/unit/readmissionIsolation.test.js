jest.mock('../../src/services/r2.service', () => ({ downloadFile: jest.fn() }));
const Upload = require('../../src/models/Upload.model');
const parser = require('../../src/services/parser.service');
const r2 = require('../../src/services/r2.service');
const { prepareReadmission } = require('../../src/services/readmission.service');

afterEach(() => jest.restoreAllMocks());

it('re-admission parses a stored overlap in the bounded worker, like confirm', async () => {
  const candidate = { _id: 'upload-b', fileName: 'b.csv', r2Key: 'b', columnMapping: { receiptId: 'Receipt' }, itemsMode: 'packed' };
  const query = { select: jest.fn(), sort: jest.fn(), lean: jest.fn().mockResolvedValue([candidate]) };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  jest.spyOn(Upload, 'find').mockReturnValue(query);
  r2.downloadFile.mockResolvedValue(Buffer.from('Receipt,Total\nB,38\n'));
  const parse = jest.spyOn(parser, 'parseBuffer').mockResolvedValue({ rows: [], errors: 0, rowErrors: [], totalRows: 0 });
  const result = await prepareReadmission({ cafeId: 'cafe-a', timezone: 'Africa/Johannesburg',
    range: { firstDateKey: '2026-01-05', lastDateKey: '2026-01-05' } });
  expect(result.prepared).toHaveLength(1);
  expect(parse).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ isolate: true }));
});
