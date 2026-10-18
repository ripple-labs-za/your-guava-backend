const logger = require('../utils/logger');
const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    logger.info('mongo_connected', { host: conn.connection.host });
  } catch (error) {
    logger.error('mongo_connect_failed', logger.errorFields(error));
    throw error;
  }
};

module.exports = connectDB;
