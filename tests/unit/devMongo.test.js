const mockCreate = jest.fn(async ({ instanceOpts: [{ port }] }) => ({
  stop: jest.fn(), getUri: (database) => `mongodb://127.0.0.1:${port}/${database}?replicaSet=rs0`,
}));
jest.mock('mongodb-memory-server', () => ({ MongoMemoryReplSet: { create: (...args) => mockCreate(...args) } }));

const { startDevMongo } = require('../../scripts/dev-mongo');

it('starts a one-member replica set the app URI can use (BE-11-T06)', async () => {
  const { uri } = await startDevMongo({ port: 27555 });
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    replSet: expect.objectContaining({ name: 'rs0', count: 1 }),
    instanceOpts: [{ port: 27555 }],
  }));
  expect(uri).toBe('mongodb://127.0.0.1:27555/your-guava?replicaSet=rs0');
});
