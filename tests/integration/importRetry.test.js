// Review of BE-03-T12: an import transaction retried after a menu-lock conflict reconciles its rows again. Reconciling
// the previous attempt's output took rawName from that attempt's menu name, so the till's own spelling was lost.
const { setup, teardown, clearDB, createTestUser } = require('../setup');
const Item = require('../../src/models/Item.model');
const { parseBuffer } = require('../../src/services/parser.service');
const { reconcileParsedRows } = require('../../src/services/ingestion.service');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const LF = String.fromCharCode(10);

it('keeps the till spelling in rawName when a retried import reconciles its rows again', async () => {
  const { user } = await createTestUser();
  const cafeId = user.activeCafeId;
  const item = await Item.create({ cafeId, name: 'Flat White', normalizedName: 'flat white', source: 'manual', reviewStatus: 'matched' });
  const parsed = await parseBuffer(Buffer.from(['Receipt,Date,Time,Items,Total', 'R1,2026-09-01,09:00,1 x flat white,38.00'].join(LF)), {
    columnMapping: { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' }, itemsMode: 'packed',
  });

  await reconcileParsedRows(parsed, { cafeId });
  expect(parsed.rows[0].items[0]).toMatchObject({ name: 'Flat White', rawName: 'flat white' });

  // A rename commits between the two attempts, as a menu edit racing the import would.
  await Item.updateOne({ _id: item._id }, { $set: { name: 'Flat White Reg', normalizedName: 'flat white reg', aliases: ['Flat White'], aliasKeys: ['flat white'] } });
  await reconcileParsedRows(parsed, { cafeId });

  expect(parsed.rows[0].items[0]).toMatchObject({ name: 'Flat White Reg', rawName: 'flat white' });
});
