const { SOURCE_ROW_NUMBERS } = require('../../src/services/parser/rowErrors');

// Exercise the real entrypoint in a worker-shaped context so Jest can observe its
// correctness paths. The separate parserIsolation tests still use real threads.
const invoke = (task, result, failure) => new Promise((resolve) => {
  const buffer = Buffer.from('Receipt,Date,Items,Total\nA,2026-01-05,1 x Latte,38\n');
  const options = { fileExt: 'csv', timezone: 'Africa/Johannesburg' };
  const parseBuffer = jest.fn(() => failure ? Promise.reject(failure) : Promise.resolve(result));
  const previewBuffer = jest.fn(() => Promise.resolve(result));
  jest.isolateModules(() => {
    jest.doMock('node:worker_threads', () => ({
      parentPort: { postMessage: (reply) => resolve({ reply, parseBuffer, previewBuffer, buffer, options }) },
      workerData: { task, buffer: new Uint8Array(buffer), options },
    }));
    jest.doMock('../../src/services/parser/parse', () => ({ parseBuffer }));
    jest.doMock('../../src/services/parser/preview', () => ({ previewBuffer }));
    require('../../src/services/parser/worker');
  });
});

afterEach(() => {
  jest.dontMock('node:worker_threads');
  jest.dontMock('../../src/services/parser/parse');
  jest.dontMock('../../src/services/parser/preview');
});

it('the worker transfers parse options and source-row metadata without making it enumerable', async () => {
  const row = { receiptId: 'A' };
  Object.defineProperty(row, SOURCE_ROW_NUMBERS, { value: [2, 3] });
  const result = { rows: [row, { receiptId: 'B' }] };
  const { reply, parseBuffer, previewBuffer, buffer, options } = await invoke('parse', result);
  expect(parseBuffer).toHaveBeenCalledWith(buffer, options);
  expect(Buffer.isBuffer(parseBuffer.mock.calls[0][0])).toBe(true);
  expect(previewBuffer).not.toHaveBeenCalled();
  expect(reply).toEqual({ result, sources: { rows: [[2, 3], null], sampleRows: [] } });
  expect(Object.keys(reply.result.rows[0])).toEqual(['receiptId']);
});

it('the worker sends preview samples and their source rows using the requested file extension', async () => {
  const row = { Receipt: 'A' };
  Object.defineProperty(row, SOURCE_ROW_NUMBERS, { value: [2] });
  const result = { headers: ['Receipt'], sampleRows: [row] };
  const { reply, parseBuffer, previewBuffer, buffer } = await invoke('preview', result);
  expect(previewBuffer).toHaveBeenCalledWith(buffer, 'csv');
  expect(parseBuffer).not.toHaveBeenCalled();
  expect(reply).toEqual({ result, sources: { rows: [], sampleRows: [[2]] } });
});

it('the worker refuses an unknown task without calling either parser', async () => {
  const { reply, parseBuffer, previewBuffer } = await invoke('unknown', {});
  expect(reply.error).toMatchObject({ message: 'Unknown parser task', statusCode: 400 });
  expect(reply).not.toHaveProperty('result');
  expect(parseBuffer).not.toHaveBeenCalled();
  expect(previewBuffer).not.toHaveBeenCalled();
});

it('the worker preserves coded parser refusals across the message boundary', async () => {
  const failure = Object.assign(new Error('Invalid workbook'), {
    statusCode: 400, publicCode: 'UPLOAD_INVALID_FILE', code: 'INVALID_XLSX', privateDetail: 'not forwarded',
  });
  const { reply } = await invoke('parse', null, failure);
  expect(reply).toEqual({ error: {
    message: 'Invalid workbook', statusCode: 400, publicCode: 'UPLOAD_INVALID_FILE', code: 'INVALID_XLSX',
  } });
});
