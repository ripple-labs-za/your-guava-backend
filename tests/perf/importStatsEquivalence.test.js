// Adopted from reviewer-b90-3 for BE-14-T01: incremental item sums against a full rebuild on
// randomised import sequences with duplicates, case variants, derived basket prices, merges, ignores, manual items,
// deletes and remaps in between. After every import the incremental state must equal a full rebuild of the same data.
jest.mock('../../src/services/r2.service', () => {
  const files = new Map();
  return {
    uploadFile: async (buffer, key) => { files.set(key, buffer); },
    downloadFile: async (key) => files.get(key),
    getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
    deleteFile: async (key) => { files.delete(key); },
    _resetClient: () => {},
  };
});
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Item = require('../../src/models/Item.model');
const { rebuildItemsForCafe } = require('../../src/services/menuItems.service');
const { stageAndConfirm, countOperations } = require('../helpers/perf');

const request = supertest(app);
jest.setTimeout(600_000);
beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const NAMES = ['Latte', 'Cappuccino', 'Flat White', 'Americano', 'Croissant', 'Muffin', 'Toastie', 'Brownie', 'Chai Latte',
  'Espresso', 'Rooibos Latte', 'Scone'];
const HEADER = 'Receipt,Date,Time,Status,Payment Method,Order Number,Card Reader,Items,Note,Currency,Tip,Discount,VAT,Total (incl. tax),Fee Amount,Net Amount';
const pad = (v) => String(v).padStart(2, '0');

// A Yoco file: random baskets of 1-3 lines, quantities 1-3, case-variant spellings, prices that drift per file.
const yocoFile = (r, { count, prefix, dayOffset }) => {
  const price = Object.fromEntries(NAMES.map((n, i) => [n, 20 + i * 3 + Math.floor(r() * 4)]));
  const lines = [HEADER];
  for (let i = 0; i < count; i += 1) {
    const size = 1 + Math.floor(r() * 3);
    const basket = [];
    for (let k = 0; k < size; k += 1) {
      const name = NAMES[Math.floor(r() * NAMES.length)];
      if (basket.some((b) => b.name.toLowerCase() === name.toLowerCase())) continue;
      const spelled = r() < 0.15 ? name.toUpperCase() : name;
      basket.push({ name: spelled, qty: 1 + Math.floor(r() * 3), unit: price[name] });
    }
    const total = basket.reduce((s, b) => s + b.qty * b.unit, 0);
    const day = new Date(Date.UTC(2026, 0, 5 + dayOffset + Math.floor(i / 30)));
    const items = basket.map((b) => `${b.qty} x ${b.name}`).join(', ');
    lines.push([`${prefix}-${i + 1}`, `${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}`,
      `${pad(7 + (i % 11))}:${pad(i % 60)}:00`, r() < 0.05 ? 'Declined' : 'Approved', 'Card', String(i + 1), 'R1',
      `"${items}"`, '', 'ZAR', '0.00', '0.00', '0.00', total.toFixed(2), '0.00', total.toFixed(2)].join(','));
  }
  return Buffer.from(`${lines.join('\n')}\n`);
};

const round6 = (value) => JSON.parse(JSON.stringify(value, (key, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)));
const snapshot = async (cafeId) => round6((await Item.find({ cafeId }).select('+salesStats').lean())
  .map(({ _id, createdAt, updatedAt, __v, ...rest }) => ({ id: String(_id), ...rest }))
  .sort((a, b) => a.id.localeCompare(b.id)));

const runSequence = async (seed, steps) => {
  const r = rng(seed);
  const { token, user } = await createTestUser();
  const cafeId = user.activeCafeId;
  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const uploads = [];
  const log = [];
  let incrementalImports = 0;
  for (let step = 0; step < steps; step += 1) {
    const roll = r();
    const items = await Item.find({ cafeId }).lean();
    if (roll < 0.55 || uploads.length === 0) {
      // An import: sometimes a re-export overlapping an earlier file (duplicates skipped), sometimes new days.
      const overlap = uploads.length > 0 && r() < 0.3 ? uploads[Math.floor(r() * uploads.length)] : null;
      const spec = overlap ? { count: overlap.count + 10, prefix: overlap.prefix, dayOffset: overlap.dayOffset }
        : { count: 20 + Math.floor(r() * 80), prefix: `S${seed}U${step}`, dayOffset: step * 7 };
      const { result, calls } = await countOperations(() => stageAndConfirm(request, token, yocoFile(r, spec), `f${step}.csv`));
      if (overlap && result.confirm.status === 409) { log.push(`import overlap: 409 every row already held`); continue; }
      expect(result.confirm.status).toBe(200);
      const scoped = calls.some((c) => c.collectionName === 'transactions' && c.method === 'aggregate' && c.params[0][0]?.$match?.uploadId);
      if (scoped) incrementalImports += 1;
      uploads.push({ id: result.stage.body.uploadId, mapping: result.stage.body.columnMapping, itemsMode: result.stage.body.itemsMode, ...spec });
      const incremental = await snapshot(cafeId);
      const rawBefore = await Item.find({ cafeId }).select('+salesStats').lean();
      await rebuildItemsForCafe(cafeId, { pruneOrphans: true });
      const full = await snapshot(cafeId);
      const rawAfter = await Item.find({ cafeId }).select('+salesStats').lean();
      if (process.env.REVIEW_RAW && JSON.stringify(incremental) !== JSON.stringify(full)) {
        for (const a of rawBefore) {
          const b = rawAfter.find((x) => String(x._id) === String(a._id));
          if (b && a.avgPrice !== b.avgPrice) {
            console.log(`RAW ${a.name}: incremental revenue ${a.salesStats.totalRevenue} qty ${a.salesStats.totalQty} avg ${a.avgPrice} `
              + `exact ${a.salesStats.totalRevenue / a.salesStats.totalQty} | full revenue ${b.salesStats.totalRevenue} qty ${b.salesStats.totalQty} `
              + `avg ${b.avgPrice} exact ${b.salesStats.totalRevenue / b.salesStats.totalQty}`);
          }
        }
      }
      log.push(`import ${overlap ? 'overlap' : 'new'} ${spec.count} rows ${scoped ? 'incremental' : 'full'}`);
      if (JSON.stringify(incremental) !== JSON.stringify(full)) {
        // Name the first differing item and field for the report.
        const byId = new Map(full.map((i) => [i.id, i]));
        const diff = incremental.map((i) => [i, byId.get(i.id)]).find(([a, b]) => JSON.stringify(a) !== JSON.stringify(b));
        const fields = diff && diff[1] ? Object.keys({ ...diff[0], ...diff[1] }).filter((k) => JSON.stringify(diff[0][k]) !== JSON.stringify(diff[1][k])) : ['(item set differs)'];
        throw new Error(`seed ${seed} step ${step} (${log.at(-1)}): incremental != full on ${diff ? diff[0].name : '?'} fields ${fields.join(',')}\n`
          + `incremental ${JSON.stringify(diff?.[0] && Object.fromEntries(fields.map((f) => [f, diff[0][f]])))}\n`
          + `full ${JSON.stringify(diff?.[1] && Object.fromEntries(fields.map((f) => [f, diff[1][f]])))}\n${log.join('\n')}`);
      }
    } else if (roll < 0.65 && items.length >= 2) {
      const [source, target] = [items[Math.floor(r() * items.length)], items[Math.floor(r() * items.length)]];
      if (String(source._id) === String(target._id)) continue;
      const res = await auth(request.post(`/api/items/${source._id}/resolve`)).send({ action: 'map_to', targetItemId: String(target._id) });
      log.push(`merge ${source.name} -> ${target.name}: ${res.status}`);
    } else if (roll < 0.72 && items.length > 0) {
      const item = items[Math.floor(r() * items.length)];
      const res = await auth(request.put(`/api/items/${item._id}`)).send({ reviewStatus: 'ignored' });
      log.push(`ignore ${item.name}: ${res.status}`);
    } else if (roll < 0.78 && items.length > 0) {
      const item = items[Math.floor(r() * items.length)];
      const res = await auth(request.put(`/api/items/${item._id}`)).send({ expectedPrice: 10 + Math.floor(r() * 50) });
      log.push(`price ${item.name}: ${res.status}`);
    } else if (roll < 0.83) {
      const res = await auth(request.post('/api/items')).send({ name: `Manual ${seed}-${step}` });
      log.push(`manual item: ${res.status}`);
    } else if (roll < 0.93) {
      const victim = uploads.splice(Math.floor(r() * uploads.length), 1)[0];
      const res = await auth(request.delete(`/api/uploads/${victim.id}`));
      log.push(`delete upload: ${res.status}`);
    } else {
      const item = items[Math.floor(r() * items.length)];
      if (!item) continue;
      const res = await auth(request.put(`/api/items/${item._id}`)).send({ name: `${item.name} Renamed${step}` });
      log.push(`rename ${item.name}: ${res.status}`);
    }
    // Every fourth step, re-confirm an existing upload through a remap with its own mapping: commitParsedUpload
    // deletes the upload's rows and writes them again, so it must not add them on top of the stored sums.
    if (step % 4 === 3 && uploads.length > 0) {
      const target = uploads[Math.floor(r() * uploads.length)];
      const res = await auth(request.patch(`/api/uploads/${target.id}/mapping`)).set('Idempotency-Key', `remap-${seed}-${step}`)
        .send({ columnMapping: target.mapping, itemsMode: target.itemsMode });
      log.push(`remap: ${res.status}`);
      expect(res.status).toBe(200);
      const incremental = await snapshot(cafeId);
      await rebuildItemsForCafe(cafeId, { pruneOrphans: true });
      if (JSON.stringify(incremental) !== JSON.stringify(await snapshot(cafeId))) {
        throw new Error(`seed ${seed} step ${step}: items after a remap differ from a full rebuild\n${log.join('\n')}`);
      }
    }
  }
  return { log, incrementalImports };
};

it.each([11, 23, 37, 101, 2026])('seed %i: every import leaves items equal to a full rebuild', async (seed) => {
  const { log, incrementalImports } = await runSequence(seed, 24);
  // The incremental path must actually have run for this to mean anything.
  expect(incrementalImports).toBeGreaterThan(2);
  expect(log.length).toBeGreaterThan(10);
});
