const { yocoSyncTotalMs } = require('../../src/services/yoco.service');
const previous = process.env.YOCO_SYNC_TOTAL_MS;
afterEach(() => {
  if (previous === undefined) delete process.env.YOCO_SYNC_TOTAL_MS;
  else process.env.YOCO_SYNC_TOTAL_MS = previous;
});
it.each([
  [undefined, 120000], ['120000', 120000], ['0', 100], ['9999999', 600000],
  ['30s', 120000], ['1e5', 120000], ['-1', 120000],
])('bounds the separate manual-sync budget for %s', (raw, expected) => {
  if (raw === undefined) delete process.env.YOCO_SYNC_TOTAL_MS;
  else process.env.YOCO_SYNC_TOTAL_MS = raw;
  expect(yocoSyncTotalMs()).toBe(expected);
});
