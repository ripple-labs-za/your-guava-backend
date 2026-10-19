/**
 * Live smoke test of the core product loop against a running backend:
 *   register → upload POS CSV → confirm mapping → week forecast → history.
 *
 * Usage: node scripts/smoke-pipeline.js [apiBaseUrl]
 * Exits non-zero on the first failed expectation.
 */
const fs = require('fs');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const API = (args[0] || 'http://localhost:5155/api').replace(/\/$/, '');
const ORIGIN = option('--origin') || 'http://localhost:5185';
const VERIFY_LOG = option('--verify-log');
const LOGIN = option('--login');

const PRICES = { 'Flat White': 40, Cappuccino: 38, Croissant: 35 };
const flatWhiteQtyFor = (dayOfWeek) => 5 + dayOfWeek;
const pad = (n) => String(n).padStart(2, '0');
const yocoDate = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

const buildHistoryCsv = (days = 56) => {
  const header =
    'Receipt,Date,Time,Status,Payment Method,Order Number,Card Reader,Items,Note,Currency,Tip,Discount,VAT,Total (incl. tax),Fee Amount,Net Amount';
  const rows = [header];
  let receipt = 1;
  for (let daysAgo = days; daysAgo >= 1; daysAgo--) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - daysAgo);
    for (const [item, qty] of [
      ['Flat White', flatWhiteQtyFor(date.getDay())],
      ['Cappuccino', 4],
      ['Croissant', 3],
    ]) {
      const total = (qty * PRICES[item]).toFixed(2);
      rows.push(
        `S-${String(receipt++).padStart(6, '0')},${yocoDate(date)},09:30:00,Approved,Credit Card,#${receipt},,${qty} x ${item},,ZAR,0.0,0.0,0.0,${total},0.0,${total}`
      );
    }
  }
  return rows.join('\n');
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  if (!ok) throw new Error(label);
};

const signIn = async () => {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  let email;
  let password;
  if (LOGIN) {
    const colon = LOGIN.indexOf(':');
    if (colon < 1) throw new Error('--login must be email:password');
    email = LOGIN.slice(0, colon);
    password = LOGIN.slice(colon + 1);
  } else {
    if (!VERIFY_LOG) throw new Error('Pass --verify-log <backend log> or --login email:password for email verification');
    email = `smoke-${Date.now()}@yourguava.test`;
    password = 'smoke-test-password-1';
    const offset = fs.statSync(VERIFY_LOG).size;
    const registered = await fetch(`${API}/auth/register`, {
      method: 'POST', headers,
      body: JSON.stringify({ email, password, name: 'Smoke Tester', cafeName: 'Smoke Cafe' }),
    });
    check('register account (verification required)', registered.status === 202);
    let token;
    for (let attempt = 0; attempt < 30 && !token; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const fresh = fs.readFileSync(VERIFY_LOG).subarray(offset).toString('utf8');
      const at = fresh.indexOf(email);
      if (at !== -1) token = fresh.slice(at).match(/verify-email#token=([A-Za-z0-9_-]{43})/)?.[1];
    }
    check('verification link written to the backend log', Boolean(token));
    const verified = await fetch(`${API}/auth/verify-email`, {
      method: 'POST', headers, body: JSON.stringify({ token, password }),
    });
    check('verify email', verified.status === 201);
  }
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST', headers, body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  check('log in', response.status === 200 && Boolean(body.accessToken));
  return body.accessToken;
};

(async () => {
  console.log(`Smoke-testing ${API}\n`);

  const auth = { Authorization: `Bearer ${await signIn()}`, Origin: ORIGIN };

  // 2. Upload a POS export (Yoco format, 56 days of history)
  const csv = buildHistoryCsv(56);
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'smoke-yoco-export.csv');
  const stageRes = await fetch(`${API}/transactions/upload`, {
    method: 'POST',
    headers: auth,
    body: form,
  });
  const stage = await stageRes.json();
  check('stage upload', stageRes.status === 200 && Boolean(stage.uploadId));
  check('Yoco format auto-detected', stage.needsConfirmation === false);

  // 3. Confirm — triggers parsing, ingestion, forecast generation
  const confirmRes = await fetch(`${API}/uploads/${stage.uploadId}/confirm`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnMapping: stage.columnMapping, itemsMode: stage.itemsMode }),
  });
  const confirm = await confirmRes.json();
  check('confirm + ingest', confirmRes.status === 200, `imported ${confirm.stats?.imported}`);
  check('all rows imported', confirm.stats?.imported === 56 * 3);

  // 4. Week forecast with per-item predictions
  const weekRes = await fetch(`${API}/forecasts/week`, { headers: auth });
  const week = await weekRes.json();
  check('week forecast returns 7 days', week.forecasts?.length === 7);

  const allDaysHaveItems = (week.forecasts || []).every(
    (f) => f.items?.length > 0 && f.items.every((i) => i.predictedQty > 0)
  );
  check('every day has positive per-item predictions', allDaysHaveItems);

  const tomorrow = week.forecasts?.[1];
  const flatWhite = tomorrow?.items?.find((i) => i.itemName === 'Flat White');
  const expected = flatWhiteQtyFor(new Date(tomorrow?.date).getDay());
  check(
    'prediction tracks weekday pattern',
    flatWhite && Math.abs(flatWhite.predictedQty - expected) <= Math.ceil(expected * 0.6),
    `Flat White predicted ${flatWhite?.predictedQty}, weekday baseline ${expected}`
  );

  // 5. History with predicted-vs-actual accuracy
  const historyRes = await fetch(
    `${API}/forecasts/history?days=3&backfill=sync&backfillLimit=3`,
    { headers: auth }
  );
  const history = await historyRes.json();
  const rows = history.rows || [];
  check('history rows generated', rows.length > 0, `${rows.length} rows`);
  check(
    'accuracy computed on history',
    rows.every((r) => r.revenueAccuracy != null && r.revenueAccuracy > 50),
    `overall ${history.meta?.overallRevenueAccuracy}%`
  );

  // 6. Dashboard stats endpoint
  const statsRes = await fetch(`${API}/transactions/stats`, { headers: auth });
  const stats = await statsRes.json();
  check('transaction stats served', stats.stats?.totalTransactions === 56 * 3);

  console.log(`\n${failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures} checks)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Smoke run crashed:', err.message);
  process.exit(1);
});
