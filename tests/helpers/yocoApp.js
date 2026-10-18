const express = require('express');
const errorMiddleware = require('../../src/middleware/error.middleware');

/**
 * app.js mounts /api/yoco only when YOCO_INTEGRATION_ENABLED is true at load time, and tests/setup.js
 * deletes that flag. Tests mount the real router on a bare app instead, with the same rawBody capture
 * the webhook signature check needs.
 */
const buildYocoApp = () => {
  const yocoRoutes = require('../../src/routes/yoco.routes');
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/yoco', yocoRoutes);
  app.use(errorMiddleware);
  return app;
};

module.exports = { buildYocoApp };
