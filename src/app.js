
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { ensureRequestBody } = require('./middleware/requestBody.middleware');
const helmet = require('helmet');
const { globalLimiter } = require('./middleware/rateLimit.middleware');
const { configureTrustProxy } = require('./config/proxy');
const { workforceEnabled } = require('./config/flags');
const {
  requestContext,
  requestLogger,
} = require('./middleware/requestContext.middleware');

const authRoutes = require('./routes/auth.routes');
const cafeRoutes = require('./routes/cafe.routes');
const transactionsRoutes = require('./routes/transactions.routes');
const forecastsRoutes = require('./routes/forecasts.routes');
const eventsRoutes = require('./routes/events.routes');
const teamRoutes = require('./routes/team.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const staffRoutes = require('./routes/staff.routes');
const shiftsRoutes = require('./routes/shifts.routes');
const leaveRoutes = require('./routes/leave.routes');
const uploadsRoutes = require('./routes/uploads.routes');
const insightChatsRoutes = require('./routes/insightChats.routes');
const accountRoutes = require('./routes/account.routes');
const integrationsRoutes = require('./routes/integrations.routes');
const itemsRoutes = require('./routes/items.routes');
const improvementsRoutes = require('./routes/improvements.routes');
const { health, readiness } = require('./controllers/health.controller');
const errorMiddleware = require('./middleware/error.middleware');
const notFoundMiddleware = require('./middleware/notFound.middleware');

const app = express();
const yocoIntegrationEnabled = () =>
  String(process.env.YOCO_INTEGRATION_ENABLED || '').toLowerCase() === 'true';

// TRUST_PROXY_HOPS (default 1): how many reverse proxies sit in front of the API.
configureTrustProxy(app);

app.use(requestContext);
app.use(requestLogger);
app.use(helmet());

// CORS — mounted before the rate limiter so a 429 still carries
// Access-Control-Allow-Origin; otherwise the browser hides the JSON body
// behind an opaque network error.
app.use(
  cors({
    // Evaluated per request; with CLIENT_URL unset no origin is allowed (validateEnv refuses that outside tests anyway).
    origin: (requestOrigin, callback) => callback(null, process.env.CLIENT_URL || false),
    credentials: true,
    exposedHeaders: ['Retry-After'],
  })
);

app.use(globalLimiter);

// Body parsers — rawBody is kept for webhook signature verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(ensureRequestBody);
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/cafe', cafeRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/forecasts', forecastsRoutes);
if (yocoIntegrationEnabled()) {
  app.use('/api/yoco', require('./routes/yoco.routes'));
}
app.use('/api/events', eventsRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/analytics', analyticsRoutes);
if (workforceEnabled()) {
  app.use('/api/staff', staffRoutes);
  app.use('/api/shifts', shiftsRoutes);
  app.use('/api/leave', leaveRoutes);
}
app.use('/api/uploads', uploadsRoutes);
app.use('/api/insight-chats', insightChatsRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/items', itemsRoutes);
app.use('/api/improvements', improvementsRoutes);

// Health check
app.get('/api/health', health);
app.get('/api/ready', readiness);

app.use('/api', notFoundMiddleware);
// Global error handler (must be last)
app.use(errorMiddleware);

module.exports = app;
