const { ParserPool, runParserTask } = require('../../src/services/parser/runInWorker');
const payloads = require('../helpers/dosPayloads');
const { xlsxWith } = require('../helpers/xlsx');

describe('cheap XLSX refusals before worker dispatch', () => {
  afterEach(() => jest.restoreAllMocks());

  describe.each(['preview', 'parse'])('%s signatures', (task) => {
    it.each([
      ['empty CSV', Buffer.alloc(0), 'csv'],
      ['binary CSV', Buffer.from([65, 0, 66]), 'csv'],
      ['bad XLSX magic', Buffer.from('not a zip'), 'xlsx'],
      ['renamed legacy XLS', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'csv'],
      ['unsupported extension', Buffer.from('Receipt,Total\nA,38\n'), 'txt'],
    ])('%s fails before a full parser pool can queue it', async (_name, buffer, fileExt) => {
      const dispatch = jest.spyOn(ParserPool.prototype, 'run').mockRejectedValue(new Error('worker was dispatched'));
      await expect(runParserTask(task, buffer, { fileExt })).rejects.toMatchObject({ statusCode: 400 });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['dimension', payloads.dimensionBombXlsx],
    ['coordinate', payloads.coordinateBombXlsx],
    ['spaced coordinate', () => payloads.coordinateBombXlsx('XFD 1048576')],
    ['unterminated tags', payloads.unterminatedTagsXlsx],
  ])('%s is refused without paying for a worker', async (_name, build) => {
    const dispatch = jest.spyOn(ParserPool.prototype, 'run').mockRejectedValue(new Error('worker was dispatched'));
    await expect(runParserTask('preview', build(), { fileExt: 'xlsx' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/too large to read safely|could not be read/) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves a real sheet with many cells on the isolated path', async () => {
    const expected = { headers: ['Receipt', 'Total'], sampleRows: [] };
    const dispatch = jest.spyOn(ParserPool.prototype, 'run').mockResolvedValue(expected);
    const workbook = xlsxWith(Array.from({ length: 100 }, (_, i) => [`R${i}`, 38]));
    await expect(runParserTask('preview', workbook, { fileExt: 'xlsx' })).resolves.toBe(expected);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not inflate an archive beyond the bounded main-thread preflight allowance', async () => {
    const workbook = xlsxWith([['Receipt', 'Total'], ['A'.repeat(2 * 1024 * 1024), 38]], { deflate: true });
    const inflate = jest.spyOn(require('node:zlib'), 'inflateRawSync');
    const result = { headers: ['Receipt', 'Total'], sampleRows: [] };
    const dispatch = jest.spyOn(ParserPool.prototype, 'run').mockResolvedValue(result);
    await expect(runParserTask('preview', workbook, { fileExt: 'xlsx' })).resolves.toBe(result);
    expect(inflate).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('cancellation during preflight wins over a parse refusal without starting a worker', async () => {
    const controller = new AbortController();
    const dispatch = jest.spyOn(ParserPool.prototype, 'run').mockRejectedValue(new Error('worker was dispatched'));
    jest.spyOn(require('../../src/services/parser/preflight'), 'preflightXlsx').mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('Bad spreadsheet'), { statusCode: 400 });
    });
    await expect(runParserTask('preview', xlsxWith([['Receipt', 'Total'], ['A', 38]]), { fileExt: 'xlsx', signal: controller.signal }))
      .rejects.toMatchObject({ statusCode: 499, code: 'UPLOAD_ABORTED' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
