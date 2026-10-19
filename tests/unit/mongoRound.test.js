// BE-14-T02: getItems' avgPerDay moves out of the pipeline (it needs the open-day count, which the same scan now yields), so it must
// round exactly as MongoDB's $round did. This compares the helper with the server on 4,400 quotients and the awkward edges.
const mongoose = require('mongoose');
const { setup, teardown } = require('../setup');
const { mongoRound } = require('../../src/services/analytics/windows');

beforeAll(setup);
afterAll(teardown);

it('rounds every quotient exactly as MongoDB $round does', async () => {
  const cases = [];
  for (let qty = 0; qty <= 400; qty += 1) for (const days of [1, 3, 6, 7, 13, 20, 29, 30, 90, 364, 365]) cases.push({ qty, days });
  cases.push({ qty: -7, days: 20 }, { qty: 2.5, days: 1 }, { qty: 0.35, days: 1 }, { qty: 1.005, days: 1 }, { qty: -0.25, days: 1 });
  const collection = mongoose.connection.db.collection('mongoRoundProbe');
  await collection.insertMany(cases.map((c, i) => ({ i, ...c })));
  const server = await collection.aggregate([
    { $project: { i: 1, rounded: { $round: [{ $divide: ['$qty', '$days'] }, 1] } } }, { $sort: { i: 1 } },
  ]).toArray();
  expect(server).toHaveLength(cases.length);
  // === on purpose: -0 and 0 serialise to the same JSON.
  const mismatches = server.filter((row) => mongoRound(cases[row.i].qty / cases[row.i].days, 1) !== row.rounded)
    .map((row) => ({ ...cases[row.i], server: row.rounded, helper: mongoRound(cases[row.i].qty / cases[row.i].days, 1) }));
  expect(mismatches.slice(0, 5)).toEqual([]);
});
