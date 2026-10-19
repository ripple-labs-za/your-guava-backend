# Your Guava launch checklist

Verified against: `0896312` on 19 October 2026. Use this before each production release.

## Required verification

| Check | Command | Where |
|---|---|---|
| Backend tests | `node node_modules/jest/bin/jest.js --runInBand` | CI job `verify`, locally |
| Coverage report | `node node_modules/jest/bin/jest.js --runInBand --coverage` | locally; CI coverage gate pending BE-12-T04 |
| Syntax | `node --check <file.js>` (CI checks every JavaScript file under src) | CI job `verify`, locally |
| Whitespace | `git diff --check` | CI job `verify`, locally |
| Dependency audit | `npm audit` (clean CI host only; no npm on incident workstation) | CI job `verify` |
| Raw control characters | tracked-source scan in `.github/workflows/ci.yml` | CI job `verify` |
| Portal tests, typecheck and build | portal's own CI commands | portal CI |

The current workflow has only `verify`. The coverage/static-check gates and non-root image HEALTHCHECK verification planned in
BE-12-T04 are pending; do not infer that they already run. There is no `scripts/static-checks.mjs` yet.

## Backend production environment

`src/config/validateEnv.js` refuses missing and unsafe settings. Never use example placeholders.

- `NODE_ENV=production` (posture trims and lowercases it).
- `MONGODB_URI`: a replica set or sharded cluster supporting transactions; standalone is not supported.
- `CLIENT_URL`: HTTPS, bare origin, no path or trailing slash; exactly the portal origin.
- `API_PUBLIC_URL`: HTTPS, no trailing slash; payment return and webhook base URL.
- `JWT_SECRET`, `JWT_REFRESH_SECRET`: at least 32 characters each.
- `TOKEN_ENCRYPTION_KEY`: at least 32 characters and different from `JWT_SECRET`.
- `TOKEN_ENCRYPTION_KEY_PREVIOUS`: optional rotation key, at least 32 characters and different from the current key when set.
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`: required, non-placeholder; sender must be verified with Resend.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`: all required for durable upload storage.
- `ANTHROPIC_API_KEY`, `WEATHER_API_KEY`, `WEATHER_API_URL`: required, non-placeholder; weather URL must use HTTPS.
- `DOWNLOAD_SIGNING_SECRET`: required only when R2 is not fully configured (local development); at least 32 characters,
  different from session and encryption secrets. Missing R2 still refuses production.
- `READINESS_TOKEN`: optional, at least 32 characters if set; required to inspect detailed capability results.
- `TRUST_PROXY_HOPS`: whole number 0–5; match actual trusted proxy count (default 1).
- `BCRYPT_ROUNDS`: may not be below 10 outside development/test (numeric range 4–15).
- `ANTHROPIC_MODEL` and `AI_MODEL_CHAT`, `AI_MODEL_INSIGHTS`, `AI_MODEL_COLUMN_MAPPING`, `AI_MODEL_MENU_REVIEW`:
  overrides must be in `src/config/ai.js`'s model catalog; they are optional.
- `ANTHROPIC_BASE_URL`: optional, production permits only the official `https://api.anthropic.com` origin.

Optional numeric settings must be whole numbers within `src/config/envSpec.js`'s `NUMERIC_ENV` ranges, with no units.
Configured URL settings must use HTTP(S), without embedded credentials; production imposes the HTTPS/origin rules above.

## Payments: Paystack

- `PAYMENT_PROVIDER=paystack`
- `PAYSTACK_SECRET_KEY`: live key beginning `sk_live_`; test keys are refused in production.
- `PAYSTACK_API_URL`: optional, only the HTTPS origin `https://api.paystack.co` (an optional trailing slash is accepted),
  no credentials, path, query, fragment or non-default port.
- `PAYSTACK_CURRENCY`: optional, defaults to `ZAR`; any other currency is refused.
- Settlement uses an outbound verify on the customer's return through `API_PUBLIC_URL`. The optional
  `/api/account/payments/paystack/webhook` also covers a customer closing the tab before redirect.

## Explicit gates

| Variable | Production value | Enforced by |
|---|---|---|
| `YOCO_INTEGRATION_ENABLED=false` | false or unset | validateEnv; MVP |
| `ACCOUNTING_INTEGRATIONS_ENABLED=false` | false or unset | validateEnv; provider posting absent |
| `BILLING_MOCK_ENABLED=false` | false or unset | validateEnv; D-010 |
| `WORKFORCE_ENABLED=false` | false or unset | validateEnv; D-003 |
| `RATE_LIMITS_ENABLED` | unset or true; false refused | validateEnv |
| `BACKGROUND_JOBS_INLINE` | unset or false; true refused | validateEnv |
| `ORIGIN_CHECKS_ENABLED` | unset or true; false refused outside development/test | validateEnv |

The workforce refusal is: “WORKFORCE_ENABLED must remain false in production until the workforce feature is complete (D-003)”.
`EMAIL_CONSOLE_LINKS` prints development email links; leave it unset on hosted environments.

## Readiness

`railway.json` gates deployment on `/api/ready`. It returns 200 when all checks are ok, otherwise 503;
shutdown immediately answers 503 with `status: draining`. Public results contain only `success`, `status`, `requestId`.
Anonymous computations are shared for five seconds, so a database change may take that long to appear publicly.
`X-Readiness-Token` equal to the configured `READINESS_TOKEN` (32+ characters) gets fresh detailed results.
An unset token never grants details. `/api/health` is liveness and continues to answer 200.

| Check | ok means |
|---|---|
| `database` | connected and transaction-capable: replica_set or sharded, not standalone |
| `environment` | validateEnv passes and required names are populated |
| `storage` | R2 fully configured; local disk only outside production |
| `email` | delivery capability configured (Resend in production, console accepted locally) |
| `payments` | selected provider configured; no provider accepted only outside production |
| `eventLoop` | informational, always ok; last complete window p99 above 200 ms marks degraded without failing readiness |
| `migrations` | automatic migrations have passed their checks; none pending/running/failed |

## Migrations

The API runs pending automatic migrations at startup, after Mongoose has built every declared index and before it accepts traffic
(`src/migrations/runner.js`). Each run is recorded in the `migrations` collection. Additive work runs before data rewrites, and index drops
run last, only once their replacement exists. A failed or unfinished migration keeps `/api/ready` at 503, so a deploy never goes live
half-migrated. Watch the deploy log for `migration_applied`, `migration_verified` or `migration_failed` lines.
If a previous process died holding a lease, startup retries every five seconds until the lease expires (at most ten minutes after its
last heartbeat), then completes the migrations without another deploy. The entire retry loop stays registered as background work;
after the 60-second startup deadline the API listens but readiness stays 503 until the migration checks pass.
SIGTERM stops lease retries within 100 ms so shutdown can drain normally. Each migration's first locked lease is logged at warn;
repeat attempts in that startup are debug logs and still wait five seconds between lease checks.

- Status, nothing written: `node src/migrations/runner.js`
- Run pending automatic migrations by hand: `node src/migrations/runner.js --apply`
- Run a manual one after reading its dry run: `node src/migrations/runner.js --apply recategorise-items`

Startup waits at most `MIGRATION_STARTUP_TIMEOUT_MS` (default 60000) before listening; readiness stays 503 until migrations are applied.

## Single instance (D-005)

`railway.json` pins `numReplicas: 1`. Three things live in process memory and a second instance would silently split them: the
rate-limit counters (`src/middleware/rateLimit.middleware.js`), the response cache (`src/middleware/cache.middleware.js`) and multer's
temporary upload files under `uploads/`. Scale out only after that state moves to MongoDB.

`restartPolicyType: ALWAYS` restarts the API after any exit; a crash writes one `process_unhandled_rejection` or
`process_uncaught_exception` JSON line first. `drainingSeconds: 15` gives the graceful shutdown (`SHUTDOWN_TIMEOUT_MS`, default 10 s) time
to finish in-flight requests and registered background work before the platform sends SIGKILL.

## Uploads

Supported formats are `.csv` and `.xlsx`. A legacy `.xls` is refused with instructions to Save As
**CSV UTF-8 (Comma delimited)** (D-002). Keep `UPLOAD_*` and `XLSX_*` bounds in `.env.example` bounded.
ZIP expansion, entry count, compression ratio, decompressed size and CRC checks run before workbook ingestion.

## Portal production environment

`VITE_API_URL` is required for production builds: an absolute HTTPS backend URL, for example `https://api.example.com/api`.

## Manual smoke pass

1. Sign up a new owner account.
2. Log out and log back in.
3. Upload a CSV/XLSX sales export.
4. Confirm column mapping and verify imported totals, skipped rows, and row errors.
5. Open upload history and upload detail.
6. View dashboard, forecasts, analytics, factors, insights, menu items, account, settings, and team pages.
7. Invite a manager and confirm no User exists before acceptance, only a SHA-256 token digest is stored, the email link uses `/accept-invite#token=...`, and accepting it creates exactly one account with the chosen password.
8. Confirm replaying, revoking, or using an expired invitation produces the same non-sensitive invalid/expired response; resend must invalidate the prior link.
9. Change password and confirm the old session is signed out.
10. Start a plan checkout and a credit-pack purchase. Confirm the Paystack redirect and return to `/settings?section=billing`
    with `payment=success`, the session paid in `GET /api/account/payments/<reference>`, and the plan or credits applied once.
11. Confirm `/api/health` (200), `/api/ready` (200, status only without the token), and a JSON 404 for an unknown `/api` route.

## Dormant alternative: OneGate

OneGate stays behind the provider seam and is not the launch provider. Selecting it needs `PAYMENT_PROVIDER=onegate`,
`ONEGATE_ORGANISATION_ID` (or `ONEGATE_ORG_ID`), `ONEGATE_API_SALT`, and the official `ONEGATE_API_URL`
origin `https://payments.onegate.co.za`, without a path, credentials, query, fragment or non-default port.

## Local seed scripts

`node src/seed.js <file>` deletes users, cafes and organisations. It always refuses production and requires one parsed loopback host.
See README for a dedicated local database. Overrides: `SEED_IMPORT_FILE`, `SEED_USER_NAME`, `SEED_USER_EMAIL`,
`SEED_USER_PASSWORD`, `SEED_ORG_NAME`, `SEED_CAFE_NAME`, `SEED_CAFE_CITY`, `SEED_CAFE_ADDRESS`.
