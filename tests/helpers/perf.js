/**
 * Deterministic cost probes for the BE-14 performance tests (tests/perf/*.test.js). They count work, so they do not depend on
 * the machine; wall time, heap and event-loop stalls are measured with tests/helpers/budget.js (measureBudget).
 */
const mongoose = require('mongoose');

// Every driver call while fn runs, as "collection.method" counts plus the raw calls (Mongoose 8 emits operation-start per call).
const countOperations = async (fn) => {
  const counts = {};
  const calls = [];
  const onStart = ({ collectionName, method, params }) => {
    const key = `${collectionName}.${method}`;
    counts[key] = (counts[key] || 0) + 1;
    calls.push({ collectionName, method, params });
  };
  mongoose.connection.on('operation-start', onStart);
  try {
    const result = await fn();
    return { result, counts, calls, total: calls.length };
  } finally {
    mongoose.connection.off('operation-start', onStart);
  }
};

// Intl.DateTimeFormat constructions while fn runs: catches a formatter built per row or per document.
const countIntlFormatters = async (fn) => {
  const Original = Intl.DateTimeFormat;
  let constructed = 0;
  function Counting(...args) {
    constructed += 1;
    return new Original(...args);
  }
  Object.setPrototypeOf(Counting, Original);
  Counting.prototype = Original.prototype;
  Intl.DateTimeFormat = Counting;
  try {
    return { result: await fn(), constructed };
  } finally {
    Intl.DateTimeFormat = Original;
  }
};

// Count zoned formatting work even when DateTimeFormat itself is cached.
const countFormatToParts = async (fn) => {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function countingFormatToParts(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original;
  }
};

// Documents MongoDB's query executor examined while fn ran (the test process is the in-memory server's only client).
const scannedDocuments = async (fn) => {
  const admin = mongoose.connection.db.admin();
  const read = async () => Number((await admin.serverStatus()).metrics.queryExecutor.scannedObjects);
  const before = await read();
  const result = await fn();
  return { result, scanned: (await read()) - before };
};

const YOCO_HEADER = ['Receipt', 'Date', 'Time', 'Status', 'Payment Method', 'Order Number', 'Card Reader', 'Items', 'Note',
  'Currency', 'Tip', 'Discount', 'VAT', 'Total (incl. tax)', 'Fee Amount', 'Net Amount'];
const MENU = [['Latte', 38], ['Cappuccino', 36], ['Flat White', 40], ['Americano', 30], ['Croissant', 34], ['Muffin', 32],
  ['Toastie', 55], ['Brownie', 28], ['Chai Latte', 42], ['Espresso', 25]];
const addDays = (dayKey, days) => new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const pad = (value, width = 2) => String(value).padStart(width, '0');

// Yoco-format sales (the preset the upload recognises): `perDay` a day from startDay, a two-item basket every third sale,
// receipts `${prefix}-000001`... unless `receipt(index)` says otherwise (index % 80 + 1 is a till that restarts each morning).
const yocoRows = (count, { startDay = '2026-01-05', perDay = 80, receipt, prefix = 'B14', menu = MENU } = {}) => {
  const rows = [YOCO_HEADER];
  for (let index = 0; index < count; index += 1) {
    const day = addDays(startDay, Math.floor(index / perDay));
    const [first, firstPrice] = menu[index % menu.length];
    const [second, secondPrice] = menu[(index * 7 + 3) % menu.length];
    const pair = index % 3 === 0 && first !== second;
    const total = pair ? firstPrice + secondPrice : firstPrice;
    rows.push([
      receipt ? receipt(index) : `${prefix}-${pad(index + 1, 6)}`, day.replace(/-/g, '/'),
      `${pad(7 + (index % 11))}:${pad(index % 60)}:${pad((index * 7) % 60)}`, 'Approved', index % 4 === 0 ? 'Cash' : 'Card',
      String(index + 1), 'Reader-01', pair ? `1 x ${first}, 1 x ${second}` : `1 x ${first}`, '', 'ZAR', '0.00', '0.00',
      (total * 0.13).toFixed(2), total.toFixed(2), '0.00', total.toFixed(2),
    ]);
  }
  return rows;
};
const csvCell = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
const yocoCsv = (count, options) => Buffer.from(`${yocoRows(count, options).map((row) => row.map(csvCell).join(',')).join('\n')}\n`);

// Stored history for cost tests, inserted through the model. Africa/Johannesburg has no DST, so cafe-local = UTC+2.
// receipt(dayIndex, i) → receiptId; default `${prefix}${dayIndex}-${i}`, unique per sale.
const SAST_MS = 2 * 3_600_000;
const seedTransactions = async (cafeId, { days = 120, perDay = 40, endDay, endDaysAgo = 1, menu = MENU, prefix = 'S', receipt } = {}) => {
  const Transaction = require('../../src/models/Transaction.model');
  const anchor = endDay
    ? Date.parse(`${endDay}T00:00:00Z`)
    : Date.parse(`${new Date(Date.now() + SAST_MS).toISOString().slice(0, 10)}T00:00:00Z`) - endDaysAgo * 86_400_000;
  const documents = [];
  for (let d = 0; d < days; d += 1) {
    const localMidnight = anchor - d * 86_400_000;
    for (let i = 0; i < perDay; i += 1) {
      const hour = 7 + (i % 12);
      const [a, priceA] = menu[(d + i) % menu.length];
      const [b, priceB] = menu[(d * 3 + i * 7 + 1) % menu.length];
      const items = i % 3 === 0 && a !== b
        ? [{ name: a, quantity: 1, unitPrice: priceA, priceSource: 'exact' }, { name: b, quantity: 1, unitPrice: priceB, priceSource: 'exact' }]
        : [{ name: a, quantity: 1 + (i % 2), unitPrice: priceA, priceSource: 'exact' }];
      documents.push({
        cafeId, receiptId: receipt ? receipt(d, i) : `${prefix}${d}-${i}`,
        date: new Date(localMidnight - SAST_MS + hour * 3_600_000 + (i % 60) * 60_000), hour,
        dayOfWeek: new Date(localMidnight).getUTCDay(), status: 'approved', paymentMethod: i % 4 === 0 ? 'Cash' : 'Card',
        items, total: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0), source: 'csv',
      });
    }
  }
  for (let index = 0; index < documents.length; index += 5000) {
    await Transaction.insertMany(documents.slice(index, index + 5000), { ordered: false });
  }
  return documents.length;
};

// Stage a file and confirm it with the staged mapping, as the portal does.
const stageAndConfirm = async (request, token, buffer, fileName, { idempotencyKey } = {}) => {
  const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', buffer, fileName);
  if (stage.status !== 200) return { stage, confirm: stage };
  const confirm = await request.post(`/api/uploads/${stage.body.uploadId}/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', idempotencyKey || `perf-${stage.body.uploadId}`)
    .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
  return { stage, confirm };
};

module.exports = { MENU, countOperations, countIntlFormatters, countFormatToParts, scannedDocuments, yocoRows, yocoCsv, seedTransactions, stageAndConfirm };
