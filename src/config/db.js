const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { isDraining } = require('../utils/lifecycle');

// The driver waits 30 s by default before giving up on a server. Ten keeps a
// dead database from holding a request, a readiness probe or a boot for half a minute.
const SERVER_SELECTION_TIMEOUT_MS = 10 * 1000;
const connectionsWithListeners = new WeakSet();

const installConnectionListeners = (connection = mongoose.connection) => {
  if (connectionsWithListeners.has(connection)) return;
  connectionsWithListeners.add(connection);
  connection.on('disconnected', () => {
    const draining = isDraining();
    logger[draining ? 'info' : 'warn']('mongo_disconnected', { draining });
  });
  connection.on('reconnected', () => logger.info('mongo_reconnected', {}));
  connection.on('error', (error) => logger.error('mongo_error', logger.errorFields(error)));
};

const connectDB = async () => {
  installConnectionListeners();
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });
    logger.info('mongo_connected', { host: conn.connection.host });
  } catch (error) {
    logger.error('mongo_connect_failed', logger.errorFields(error));
    throw error;
  }
};

module.exports = connectDB;
module.exports.installConnectionListeners = installConnectionListeners;
