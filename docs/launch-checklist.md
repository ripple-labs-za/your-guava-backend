# Your Guava Launch Checklist

Use this before each production release.

## Required Verification

- Backend tests: `npm test -- --runInBand`
- Portal tests: `npm test`
- Portal build: `npm run build`
- Dependency audit in both repos: `npm audit`
- Whitespace check in both repos: `git diff --check`

## Backend Production Environment

Production startup intentionally fails when critical settings are missing or unsafe.

- `NODE_ENV=production`
- `MONGODB_URI` pointing to a MongoDB replica set or sharded cluster. Standalone MongoDB is not supported because import replacement and account operations use transactions.
- `CLIENT_URL`
- `JWT_SECRET` with at least 32 characters
- `JWT_REFRESH_SECRET` with at least 32 characters
- `TOKEN_ENCRYPTION_KEY` with at least 32 characters, independent from `JWT_SECRET`
- `PAYMENT_PROVIDER=onegate`
- `ONEGATE_ORGANISATION_ID` or `ONEGATE_ORG_ID`
- `ONEGATE_API_SALT`
- `API_PUBLIC_URL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `ANTHROPIC_API_KEY`
- `WEATHER_API_KEY`
- `WEATHER_API_URL` using HTTPS

## Explicit MVP Gates

- `YOCO_INTEGRATION_ENABLED=false`
- `ACCOUNTING_INTEGRATIONS_ENABLED=false`
- `BILLING_MOCK_ENABLED=false`

These gates are enforced by production environment validation.

The readiness probe also verifies that MongoDB is transaction-capable and that durable R2 storage is configured. Do not route traffic until `/api/ready` returns `200`.

CSV and XLSX upload bounds are configurable through the `UPLOAD_*` and `XLSX_*` variables in `.env.example`. Keep them bounded: XLSX files are rejected before workbook parsing when ZIP expansion, entry count, or compression-ratio limits are exceeded, and each supported ZIP entry is decompressed under an output cap with size and CRC validation.

The included local `docker-compose.yml` starts a single-node `rs0` replica set. Use `MONGODB_URI=mongodb://localhost:27017/your-guava?replicaSet=rs0` for local development.

## Portal Production Environment

- `VITE_API_URL` is required for production builds and must be an absolute HTTPS backend URL, for example `https://api.example.com/api`. There is no production fallback.

## Manual Smoke Pass

1. Sign up a new owner account.
2. Log out and log back in.
3. Upload a CSV/XLSX sales export.
4. Confirm column mapping and verify imported totals, skipped rows, and row errors.
5. Open upload history and upload detail.
6. View dashboard, forecasts, analytics, factors, insights, menu items, account, settings, and team pages.
7. Invite a manager and confirm no User exists before acceptance, only a SHA-256 token digest is stored, the email link uses `/accept-invite#token=...`, and accepting it creates exactly one account with the chosen password.
8. Confirm replaying, revoking, or using an expired invitation produces the same non-sensitive invalid/expired response; resend must invalidate the prior link.
9. Change password and confirm the old session is signed out.
10. Start a checkout or credit purchase and confirm OneGate redirects/callbacks work.
11. Confirm `/api/health`, `/api/ready`, and JSON 404 responses.

## Local Seed Scripts

The seed scripts are destructive and refuse production databases. Configure local demo data with:

- `SEED_IMPORT_FILE`
- `SEED_USER_NAME`
- `SEED_USER_EMAIL`
- `SEED_USER_PASSWORD`
- `SEED_ORG_NAME`
- `SEED_CAFE_NAME`
- `SEED_CAFE_CITY`
- `SEED_CAFE_ADDRESS`

## Single instance (D-005)

`railway.json` pins `numReplicas: 1`. Three things live in process memory and a second instance would silently split them: the
rate-limit counters (`src/middleware/rateLimit.middleware.js`), the response cache (`src/middleware/cache.middleware.js`) and multer's
temporary upload files under `uploads/`. Scale out only after that state moves to MongoDB.

`restartPolicyType: ALWAYS` restarts the API after any exit; a crash writes one `process_unhandled_rejection` or
`process_uncaught_exception` JSON line first. `drainingSeconds: 15` gives the graceful shutdown (`SHUTDOWN_TIMEOUT_MS`, default 10 s) time
to finish in-flight requests and registered background work before the platform sends SIGKILL.
