const Transaction = require('../models/Transaction.model');
const { yieldToEventLoop } = require('../utils/lifecycle');
const {
  safeTimezone, zonedDateKey, getZonedDateParts, zonedDayStart, zonedDayEnd, addZonedDays,
} = require('../utils/timezone');
const { sha256Hex } = require('../utils/authPrimitives');

/**
 * The one rule for "do we already hold this sale?" (BE-11-T05). The write path
 * (ingestion.service) and the remap pre-check (controllers/uploads/remap.js) each
 * had a copy, and they disagreed about the trading day of a row without dateKey.
 *
 * A receipt number is only unique within a cafe-local trading day on tills that
 * restart their numbering, so a receipt identity carries the day. A receipt-less
 * row is identified by its content (contentSignature, counted per occurrence).
 * Stored rows with old file-scoped keys are matched by that same content, so
 * overlapping exports still recognise sales imported before BE-03-T03.
 */
const IDENTITY_QUERY_CHUNK_SIZE = 500;

const chunksOf = (values, size = IDENTITY_QUERY_CHUNK_SIZE) => {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

const CONTENT_KEY_VERSION = 'content-v1';
const pad = (value) => String(value).padStart(2, '0');
const money = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0).toFixed(2);
const quantityText = (value) => String(Math.round(Number(value) * 1000) / 1000);

/**
 * A receipt-less sale's identity (BE-03-T03): what the till recorded, not which file or row carried it. The
 * file-scoped key this replaces counted every overlapping or re-saved export again, silently doubling revenue.
 *
 * Cafe-local day and minute, total, tip, discount, and the basket's shape. Item names are left out on purpose:
 * merge, rename and map_to rewrite the names on stored lines, and an identity must not change after it is stored.
 * Identical sales in one minute are counted, not merged (resolveContentRows), so leaving names out only matters when
 * two overlapping exports disagree about which sales happened.
 */
const contentSignature = (row, timezone) => {
  const parts = getZonedDateParts(row.date, timezone);
  const quantities = (row.items || [])
    .map((item) => quantityText(item.quantity))
    .sort((a, b) => Number(a) - Number(b));
  return [
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    `${pad(parts.hour)}:${pad(parts.minute)}`,
    money(row.total),
    money(row.tip),
    money(row.discount),
    quantities.length,
    quantities.join(','),
  ].join('|');
};

const contentKey = (signature, occurrence) => sha256Hex(`${CONTENT_KEY_VERSION}|${signature}|${occurrence}`);

const withSession = (query, session) => (session ? query.session(session) : query);
const excluding = (excludeUploadId) => (excludeUploadId ? { uploadId: { $ne: excludeUploadId } } : {});

const basketKey = (items = []) => items
  .map((item) => {
    const who = item.salesItemId ? `id:${item.salesItemId}` : `name:${String(item.name || '').trim().toLowerCase()}`;
    return `${who}x${quantityText(item.quantity)}`;
  })
  .sort()
  .join(',');

/** A receipt's full content: when, how much, and which menu items (by id, which merges and renames keep stable). */
const receiptSignature = (row, timezone) => `${contentSignature(row, timezone)}|${basketKey(row.items)}`;
const minuteOf = (signature) => signature.split('|').slice(0, 2).join(' ');
// A signature starts with the cafe-local day, so the day is read from it rather than formatted a second time.
const dayOf = (signature) => signature.slice(0, signature.indexOf('|'));

/**
 * Stored rows that can collide with this file lie on the file's own cafe-local days. A day either side covers a
 * sale near midnight on a host whose clock disagrees. Without the bound, receipts that restart daily matched every
 * day of the cafe's history (219,000 rows for two years) inside the upload transaction (BE-03-T13).
 */
const identityDateWindow = (rows, timezone) => {
  const keys = rows.map((row) => row.dateKey || zonedDateKey(row.date, timezone)).filter(Boolean).sort();
  if (keys.length === 0) return null;
  return {
    $gte: addZonedDays(zonedDayStart(keys[0], timezone), -1, timezone),
    $lte: zonedDayEnd(addZonedDays(zonedDayStart(keys[keys.length - 1], timezone), 1, timezone), timezone),
  };
};

/**
 * A receipt number is unique within a trading day on most tills, but not on all: per-shift numbering and second
 * registers reuse "#0001" in one day (BE-03-T04). Two rows under one number are one sale only when their contents
 * match. Different contents at a different minute are two sales. Different contents at the same minute are a
 * contradiction the owner must see (the unique {cafeId, receiptId, date} index would refuse one of them anyway).
 */
const resolveReceiptRows = async (rows, { cafeId, session, timezone, excludeUploadId }) => {
  const held = new Map();
  const hold = (key, entry) => held.set(key, [...(held.get(key) || []), entry]);
  const window = identityDateWindow(rows, timezone);
  for (const chunk of chunksOf([...new Set(rows.map((row) => row.receiptId))])) {
    const stored = await withSession(
      // $type: 'string' lets the planner use the partial unique {cafeId, receiptId, date} index.
      Transaction.find({
        cafeId, receiptId: { $in: chunk, $type: 'string' }, ...(window ? { date: window } : {}), ...excluding(excludeUploadId),
      })
        .select('receiptId date total tip discount items.salesItemId items.name items.quantity uploadId'),
      session
    ).lean();
    for (const [index, doc] of stored.entries()) {
      if (index > 0 && index % 250 === 0) await yieldToEventLoop();
      const signature = receiptSignature(doc, timezone);
      hold(`${doc.receiptId}|${dayOf(signature)}`, {
        signature, minute: minuteOf(signature), total: doc.total, uploadId: doc.uploadId || null, inFile: false,
      });
    }
  }
  const importable = [];
  const duplicates = [];
  const conflicts = [];
  let inFileDuplicates = 0;
  for (const [index, row] of rows.entries()) {
    if (index > 0 && index % 250 === 0) await yieldToEventLoop();
    const signature = receiptSignature(row, timezone);
    const dayKey = row.dateKey || dayOf(signature);
    const key = `${row.receiptId}|${dayKey}`;
    const entries = held.get(key) || [];
    const same = entries.find((entry) => entry.signature === signature);
    if (same) {
      if (same.inFile) inFileDuplicates += 1;
      else duplicates.push({ row, uploadId: same.uploadId });
      continue;
    }
    const clash = entries.find((entry) => entry.minute === minuteOf(signature));
    if (clash) {
      const [, at] = minuteOf(signature).split(' ');
      conflicts.push({
        row,
        reason: `Receipt ${row.receiptId} appears twice on ${dayKey} at ${at} with different contents `
          + `(R${Number(clash.total).toFixed(2)} and R${Number(row.total).toFixed(2)}); only the first was imported. `
          + 'Check the till for an edited or voided sale.',
      });
      continue;
    }
    hold(key, { signature, minute: minuteOf(signature), total: row.total, uploadId: null, inFile: true });
    importable.push({ row, identity: { type: 'receiptId', value: row.receiptId, dayKey } });
  }
  return { importable, duplicates, inFileDuplicates, conflicts };
};

/**
 * A file with k copies of a sale the cafe already holds m times adds max(0, k - m). Stored rows are compared by
 * their content too, so rows written under the old file-scoped keys are matched as well. New keys skip any
 * occurrence number an existing row of that sale already uses, so the unique {cafeId, dedupKey} index never trips.
 */
const resolveContentRows = async (rows, { cafeId, session, timezone, excludeUploadId }) => {
  if (rows.length === 0) return { importable: [], duplicates: [] };
  const dayKeys = rows.map((row) => row.dateKey || zonedDateKey(row.date, timezone)).sort();
  const stored = await withSession(
    Transaction.find({
      cafeId,
      dedupKey: { $type: 'string' },
      date: { $gte: zonedDayStart(dayKeys[0], timezone), $lte: zonedDayEnd(dayKeys[dayKeys.length - 1], timezone) },
      ...excluding(excludeUploadId),
    }).select('date total tip discount items.quantity uploadId dedupKey'),
    session
  ).lean();
  const held = new Map();
  for (const [index, doc] of stored.entries()) {
      if (index > 0 && index % 250 === 0) await yieldToEventLoop();
    const signature = contentSignature(doc, timezone);
    const entry = held.get(signature) || { remaining: 0, keys: new Set(), uploads: [] };
    entry.remaining += 1;
    entry.keys.add(doc.dedupKey);
    entry.uploads.push(doc.uploadId || null);
    held.set(signature, entry);
  }
  const importable = [];
  const duplicates = [];
  const nextOccurrence = new Map();
  for (const [index, row] of rows.entries()) {
    if (index > 0 && index % 250 === 0) await yieldToEventLoop();
    const signature = contentSignature(row, timezone);
    const entry = held.get(signature);
    if (entry && entry.remaining > 0) {
      entry.remaining -= 1;
      duplicates.push({ row, uploadId: entry.uploads[entry.remaining] });
      continue;
    }
    let occurrence = nextOccurrence.get(signature) || 1;
    while (entry && entry.keys.has(contentKey(signature, occurrence))) occurrence += 1;
    nextOccurrence.set(signature, occurrence + 1);
    importable.push({ row, identity: { type: 'dedupKey', value: contentKey(signature, occurrence) } });
  }
  return { importable, duplicates };
};

/** The one identity rule: commit, remap pre-check and re-admission all come through here. */
const resolveIdentities = async (rows, options) => {
  const scoped = { ...options, timezone: safeTimezone(options.timezone) };
  const receipts = await resolveReceiptRows(rows.filter((row) => row.receiptId), scoped);
  const content = await resolveContentRows(rows.filter((row) => !row.receiptId), scoped);
  return {
    importable: [...receipts.importable, ...content.importable],
    duplicates: [...receipts.duplicates, ...content.duplicates],
    inFileDuplicates: receipts.inFileDuplicates,
    conflicts: receipts.conflicts,
  };
};

const tallyDuplicatesByUpload = (duplicates) => {
  const counts = new Map();
  for (const { uploadId } of duplicates) {
    const key = uploadId ? String(uploadId) : null;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([uploadId, rows]) => ({ uploadId, rows }))
    .sort((a, b) => b.rows - a.rows);
};

module.exports = {
  IDENTITY_QUERY_CHUNK_SIZE,
  chunksOf,
  contentSignature,
  contentKey,
  receiptSignature,
  identityDateWindow,
  resolveIdentities,
  tallyDuplicatesByUpload,
};
