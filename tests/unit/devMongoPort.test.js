const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../scripts/dev-mongo.js'), 'utf8');

it.each([['0', 0, 27199], [undefined, 27017, 27017], ['27199', 27199, 27199]])(
  'CLI port %s starts the requested port and prints the actual replica-set URI',
  async (argument, requestedPort, actualPort) => {
    const uri = `mongodb://127.0.0.1:${actualPort}/your-guava?replicaSet=rs0`;
    const replSet = { getUri: jest.fn(() => uri), stop: jest.fn() };
    const create = jest.fn(async () => replSet);
    const main = { exports: {} };
    const mockRequire = () => ({ MongoMemoryReplSet: { create } });
    mockRequire.main = main;
    const log = jest.fn();
    const exit = jest.fn();
    vm.runInNewContext(source, {
      require: mockRequire, module: main,
      console: { log, error: jest.fn() },
      process: { argv: ['node', 'dev-mongo.js', ...(argument === undefined ? [] : [argument])], on: jest.fn(), exit },
      URL,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(create.mock.calls[0][0].instanceOpts).toEqual([{ port: requestedPort }]);
    expect(replSet.getUri).toHaveBeenCalledWith('your-guava');
    expect(log).toHaveBeenCalledWith(`[dev-mongo] replica set rs0 on 127.0.0.1:${actualPort} (temporary data)`);
    expect(log).toHaveBeenCalledWith(`[dev-mongo] MONGODB_URI=${uri}`);
    expect(exit).not.toHaveBeenCalled();
  },
);
