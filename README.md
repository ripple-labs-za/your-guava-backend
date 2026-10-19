# Your Guava backend

Verified against: `0896312` on 19 October 2026.

This API imports cafe sales and provides forecasts, analytics and account management for the Your Guava portal.
The steps below run a local replica set and seed ten weeks of sales so Today can show a forecast.

## Prerequisites and installation

Use Node 24 (see `.nvmrc`) and check out the portal repository beside this repository.
MongoDB must support transactions: use Docker, or the in-memory replica set below.
On a clean machine, install the locked dependencies with `npm ci` in each repository.
There is no direct-node equivalent for installing dependencies. On the owner's incident workstation, never run npm,
npx, pnpm or yarn; use the existing dependencies and the direct-node commands below.

## MongoDB

With Docker, run `docker compose up -d mongo` and wait until
`docker inspect -f '{{.State.Health.Status}}' your-guava-mongo` prints `healthy`.
The container binds only to loopback and initializes the one-member replica set `rs0`.

Without Docker, keep `node scripts/dev-mongo.js` running in a separate terminal.
Its default port is 27017; an explicit port is supported, for example `node scripts/dev-mongo.js 27199`.
It prints the replica-set URI to use. Data is temporary unless you add `--dbpath <dir>`; create that directory first.

## Environment

Copy `.env.example` to `.env` (`cp .env.example .env`, or `Copy-Item .env.example .env` in PowerShell), then set:

```dotenv
PORT=5055
CLIENT_URL=http://localhost:5175
MONGODB_URI=mongodb://127.0.0.1:27017/your-guava?replicaSet=rs0
NODE_ENV=development
WORKFORCE_ENABLED=false
```

Generate a different fresh value for each of `JWT_SECRET`, `JWT_REFRESH_SECRET`, `TOKEN_ENCRYPTION_KEY` and
`DOWNLOAD_SIGNING_SECRET` with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
The first two placeholders are refused at startup. The download signing secret is required for local storage and must
differ from all three other secrets. Keep the encryption key stable between runs or reconnect stored integrations.

Clear `ANTHROPIC_API_KEY` and `WEATHER_API_KEY` rather than retaining their example placeholders; leave every other provider key
empty, including `PAYMENT_PROVIDER`, `PAYSTACK_SECRET_KEY`, `RESEND_API_KEY` and all `R2_*` credentials.
Email uses the console (`EMAIL_CONSOLE_LINKS=true` prints local verification links), storage uses local disk, and payments are unavailable.
Without an AI key, AI features are unavailable. Optionally set `BILLING_MOCK_ENABLED=true` for local plan/credit changes without
a provider. Production refuses mock billing (D-010). Keep accounting, Yoco and workforce flags false.

## Demo data

This is destructive: the seed deletes users, cafes and organisations in the loopback database it targets.
Use a dedicated local database. It refuses production, remote hosts and multi-host URIs.

```sh
node scripts/gen-demo-sales.js --out demo-sales.csv
node src/seed.js demo-sales.csv
```

The deterministic export ends yesterday, contains ten weeks of history, and uses Yoco's `Approved` status.
Use `--end YYYY-MM-DD --weeks 10` for a fixed date; omit `--out` to write CSV to stdout.
The default seed login is `demo@yourguava.local` / `password123`.
For a scratch owner, set `SEED_USER_EMAIL`, `SEED_CAFE_NAME` and optionally `SEED_USER_PASSWORD` before running the seed.

## API and portal

Run `npm run dev`, or directly `node src/server.js`, in the backend repository.
Check `curl http://localhost:5055/api/ready` (PowerShell: `curl.exe`): expect HTTP 200 with `"status":"ready"`.
Nodemon does not watch `.env`: type `rs` after changing it. With the direct command, stop and restart the process.

In the portal repository, set `VITE_API_URL=http://localhost:5055/api` in `.env.local`, then run `npm run dev`,
or `node node_modules/vite/bin/vite.js`. The portal pins port 5175 with strictPort; open `http://localhost:5175`.
For a different local stack, set `VITE_API_URL` in the terminal and pass `--port <port> --strictPort` to Vite.
In PowerShell use `$env:VITE_API_URL='http://localhost:5055/api'`; in a POSIX shell prefix the node command with that assignment.
Log in with the seeded owner and open `/today`: expect menu items including Flat White and a positive revenue forecast.

## Tests and checks

Run `npm test` or `node node_modules/jest/bin/jest.js --runInBand`.
For coverage use `node node_modules/jest/bin/jest.js --runInBand --coverage`.
Tests never load `.env`, pin `Africa/Johannesburg`, refuse outbound network, and start their own in-memory MongoDB.
`MONGOMS_RUNTIME_DOWNLOAD=false` prevents an incidental MongoDB binary download when using a pre-cached binary.
Run `git diff --check` for whitespace and `node --check <file.js>` for changed JavaScript files.
CI currently runs the `verify` job with tests, dependency audit, JavaScript syntax, raw-control-character checks and whitespace.
Coverage/static-check and image jobs are pending BE-12-T04; there is currently no `scripts/static-checks.mjs` command to run.

## Troubleshooting

- A standalone MongoDB makes `/api/ready` return 503 and transaction-based signup/imports fail: use the replica set above.
- A CORS error or 403 “Request origin is not allowed” means `CLIENT_URL` must match the portal's origin exactly, without a trailing slash.
- Login 429 can mean the per-network limit (20 attempts per 15 minutes, `AUTH_LIMITS.login` in
  `src/middleware/rateLimit.middleware.js`) or the MongoDB per-account throttle. Restarting the API resets only the in-memory network
  counter; the account throttle survives a restart. Wait for the time the response names.
- For pending migrations, inspect `node src/migrations/runner.js`; use `--apply` to run automatic migrations by hand.
  Read the launch checklist before running a named manual migration.
- If startup refuses a placeholder or missing download-signing key, finish the Environment section above.

See [the launch checklist](docs/launch-checklist.md) and [accounting integration status](docs/integrations.md).
