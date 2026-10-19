const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn().mockResolvedValue(undefined);
const mockWrite = jest.fn();
jest.mock('mongoose', () => ({ connect: mockConnect, disconnect: mockDisconnect }));
jest.mock('../../src/models/Migration.model', () => ({ findOneAndUpdate: mockWrite }));
jest.mock('../../src/migrations/index', () => []);
jest.mock('../../src/utils/logger', () => ({ printLine: jest.fn() }));

it('reports status without enabling Mongoose collection creation or automatic indexes', async () => {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27199/b90-cli-unit';
  const { cli } = require('../../src/migrations/runner');
  await expect(cli([])).resolves.toBe(0);
  expect(mockConnect).toHaveBeenCalledWith(process.env.MONGODB_URI, expect.objectContaining({
    autoCreate: false, autoIndex: false,
  }));
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
});
