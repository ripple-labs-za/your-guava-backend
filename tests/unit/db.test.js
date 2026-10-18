const { EventEmitter } = require('events');

const mockConnection = new EventEmitter();
const mockConnect = jest.fn();
jest.mock('mongoose', () => ({ connection: mockConnection, connect: (...args) => mockConnect(...args) }));

const logger = require('../../src/utils/logger');
const lifecycle = require('../../src/utils/lifecycle');
const connectDB = require('../../src/config/db');

describe('connectDB', () => {
  const URI = 'mongodb://127.0.0.1:27199/db-unit?replicaSet=rs0';
  let previousUri;

  beforeEach(() => {
    previousUri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = URI;
    mockConnect.mockReset();
    mockConnect.mockResolvedValue({ connection: { host: '127.0.0.1' } });
  });
  afterEach(() => {
    if (previousUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousUri;
    lifecycle.resetLifecycleForTests();
    jest.restoreAllMocks();
  });

  it('bounds server selection so a dead database fails in seconds, not 30', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    await connectDB();
    expect(mockConnect).toHaveBeenCalledWith(URI, expect.objectContaining({ serverSelectionTimeoutMS: 10000 }));
  });

  it('logs a mid-life disconnect as a warning and the reconnect as info', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    await connectDB();
    mockConnection.emit('disconnected');
    mockConnection.emit('reconnected');
    expect(warn).toHaveBeenCalledWith('mongo_disconnected', expect.objectContaining({ draining: false }));
    expect(info).toHaveBeenCalledWith('mongo_reconnected', expect.any(Object));
  });

  it('logs the disconnect of a graceful shutdown as info, not a warning', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    await connectDB();
    lifecycle.markDraining();
    mockConnection.emit('disconnected');
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('mongo_disconnected', expect.objectContaining({ draining: true }));
  });

  it('logs driver errors with the error fields', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await connectDB();
    mockConnection.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    expect(error).toHaveBeenCalledWith(
      'mongo_error',
      expect.objectContaining({ errorMessage: 'connection reset', errorCode: 'ECONNRESET' })
    );
  });

  it('registers the listeners once however often it is called', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    await connectDB();
    await connectDB();
    expect(mockConnection.listenerCount('disconnected')).toBe(1);
  });
});
