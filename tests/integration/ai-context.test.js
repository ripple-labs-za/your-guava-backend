const mockAnthropicMessageCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicMessageCreate } })));
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const request = require('supertest')(app);
const Cafe = require('../../src/models/Cafe.model');
const Transaction = require('../../src/models/Transaction.model');
const Forecast = require('../../src/models/Forecast.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const ai = require('../../src/services/anthropic.service');
const { buildBusinessContext, invalidateInsights } = ai;
const { clearApiCache, onApiCacheCleared } = require('../../src/middleware/cache.middleware');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.useRealTimers(); jest.restoreAllMocks(); mockAnthropicMessageCreate.mockReset();
  ai._resetBusinessContextCache?.(); await clearDB();
  delete process.env.ANTHROPIC_API_KEY;
});

const seedTwoLocations = async () => {
  const owner = await createTestUser();
  const cafeId = owner.user.activeCafeId;
  await Cafe.updateOne({ _id: cafeId }, { $set: { timezone: 'Africa/Johannesburg' } });
  const london = await Cafe.create({ name: 'London Branch', orgId: owner.user.orgId, timezone: 'Europe/London' });
  const morning = new Date(Date.now() - 2 * 86_400_000);
  morning.setUTCHours(10, 0, 0, 0);
  const late = new Date(morning); late.setUTCHours(22, 30, 0, 0);
  const sale = (location, receiptId, date, total, quantity, hour, dayOfWeek) => ({
    cafeId: location, receiptId, date, total, status: 'approved', paymentMethod: 'card', hour, dayOfWeek,
    items: [{ name: 'Flat White', quantity, unitPrice: total / quantity }],
  });
  await Transaction.create([
    sale(cafeId, 'ctx-morning', morning, 50, 2, 12, 1),
    sale(cafeId, 'ctx-late', late, 30, 1, 0, 2),
    sale(london._id, 'ctx-london', late, 40, 1, 23, 1),
    sale(cafeId, 'ctx-refund', morning, -10, -1, 12, 1),
  ]);
  const tomorrow = new Date(Date.now() + 86_400_000);
  await Forecast.create({
    cafeId, date: tomorrow, dateKey: tomorrow.toISOString().slice(0, 10), modelVersion: 'test', trainingCutoff: tomorrow,
    totalPredictedRevenue: 4200,
    items: Array.from({ length: 12 }, (_, index) => ({
      itemName: `Item ${index}`, predictedQty: 100 - index, factors: [{ key: 'dayOfWeek', label: 'Day', multiplier: 1.1 }],
    })),
  });
  return { owner, cafeId, london };
};

describe('Ask Guava business context', () => {
  it.each(['cafeId', 'orgId'])('keeps org A warm when an API clear targets org B by %s', async (scopeKey) => {
    const ownerA = await createTestUser({ email: 'context-a@example.com' });
    const ownerB = await createTestUser({ email: 'context-b@example.com' });
    const argsA = { cafeId: ownerA.user.activeCafeId, orgId: ownerA.user.orgId };
    const argsB = { cafeId: ownerB.user.activeCafeId, orgId: ownerB.user.orgId };
    const firstA = await buildBusinessContext(argsA);
    const firstB = await buildBusinessContext(argsB);
    clearApiCache({ [scopeKey]: argsB[scopeKey] });
    expect(await buildBusinessContext(argsA)).toBe(firstA);
    expect(await buildBusinessContext(argsB)).not.toBe(firstB);
  });

  it('still publishes org A in-flight context when only org B was invalidated', async () => {
    const ownerA = await createTestUser({ email: 'context-build-a@example.com' });
    const ownerB = await createTestUser({ email: 'context-build-b@example.com' });
    const original = Transaction.aggregate.bind(Transaction);
    jest.spyOn(Transaction, 'aggregate').mockImplementationOnce(async (...args) => {
      const rows = await original(...args);
      clearApiCache({ cafeId: ownerB.user.activeCafeId });
      return rows;
    });
    const args = { cafeId: ownerA.user.activeCafeId, orgId: ownerA.user.orgId };
    const first = await buildBusinessContext(args);
    expect(await buildBusinessContext(args)).toBe(first);
  });
  it('refreshes the context after a cafe rename that does not change forecast inputs', async () => {
    const owner = await createTestUser();
    const args = { cafeId: owner.user.activeCafeId, orgId: owner.user.orgId };
    const before = await buildBusinessContext(args);
    const response = await request.put('/api/cafe/me').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Renamed cafe' });
    expect(response.status).toBe(200);
    expect(before.activeLocation.name).not.toBe('Renamed cafe');
    expect((await buildBusinessContext(args)).activeLocation.name).toBe('Renamed cafe');
  });

  it('refreshes the context after a menu item is created', async () => {
    const owner = await createTestUser();
    const args = { cafeId: owner.user.activeCafeId, orgId: owner.user.orgId };
    expect((await buildBusinessContext(args)).menuItems).toHaveLength(0);
    const response = await request.post('/api/items').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Fresh coffee', category: 'coffee', expectedPrice: 25 });
    expect(response.status).toBe(201);
    expect((await buildBusinessContext(args)).menuItems.map((item) => item.name)).toContain('Fresh coffee');
  });

  it('refreshes the owner-wide context after a location is created', async () => {
    const owner = await createTestUser();
    const args = { cafeId: owner.user.activeCafeId, orgId: owner.user.orgId };
    expect((await buildBusinessContext(args)).locations).toHaveLength(1);
    const response = await request.post('/api/team/add-cafe').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Second branch' });
    expect(response.status).toBe(201);
    expect((await buildBusinessContext(args)).locations.map((cafe) => cafe.name)).toContain('Second branch');
  });

  it('refreshes and excludes an archived location from the context', async () => {
    const { owner, cafeId, london } = await seedTwoLocations();
    const args = { cafeId, orgId: owner.user.orgId };
    expect((await buildBusinessContext(args)).locations).toHaveLength(2);
    const response = await request.post(`/api/team/cafes/${london._id}/archive`)
      .set('Authorization', `Bearer ${owner.token}`).send({});
    expect(response.status).toBe(200);
    const after = await buildBusinessContext(args);
    expect(after.locations).toHaveLength(1);
    expect(after.dataset.totalRevenue).toBe(70);
  });

  it('refreshes the context when an archived location is restored', async () => {
    const { owner, cafeId, london } = await seedTwoLocations();
    await Cafe.updateOne({ _id: london._id }, { $set: { archivedAt: new Date() } });
    const args = { cafeId, orgId: owner.user.orgId };
    const aggregate = jest.spyOn(Transaction, 'aggregate');
    const before = await buildBusinessContext(args);
    const response = await request.post(`/api/team/cafes/${london._id}/restore`)
      .set('Authorization', `Bearer ${owner.token}`).send({});
    expect(response.status).toBe(200);
    const after = await buildBusinessContext(args);
    expect(aggregate).toHaveBeenCalledTimes(4);
    expect(before.locations).toHaveLength(1);
    expect(after.locations).toHaveLength(2);
    expect(after.dataset.totalRevenue).toBe(110);
  });
  it('notifies dependent caches even when the response cache has no entries and supports unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = onApiCacheCleared(listener);
    try {
      expect(clearApiCache({ cafeId: { toString: () => 'cafe-listener' }, keyPrefix: 'events' })).toBe(0);
      expect(listener).toHaveBeenCalledWith({ cafeId: 'cafe-listener', orgId: null, keyPrefix: 'events' });
      unsubscribe();
      clearApiCache({ orgId: 'org-listener' });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(() => clearApiCache()).toThrow(TypeError);
    } finally { unsubscribe(); }
  });

  it('keeps the newest 120 location-days and the previous cafe ordering on equal dates', async () => {
    const { owner, cafeId, london } = await seedTwoLocations();
    await Transaction.deleteMany({});
    const rows = [];
    for (let day = 0; day < 65; day += 1) {
      for (const location of [cafeId, london._id]) {
        const date = new Date(Date.now() - (day + 1) * 86_400_000);
        date.setUTCHours(10, 0, 0, 0);
        rows.push({ cafeId: location, receiptId: `cap-${location}-${day}`, date, total: day + 1, status: 'approved',
          hour: 12, dayOfWeek: 1, items: [{ name: 'Coffee', quantity: 1, unitPrice: day + 1 }] });
      }
    }
    await Transaction.create(rows);
    const cafes = await Cafe.find({ orgId: owner.user.orgId }).lean();
    const names = new Map(cafes.map((cafe) => [String(cafe._id), cafe.name]));
    const expected = cafes.flatMap((cafe) => rows.filter((row) => String(row.cafeId) === String(cafe._id)).map((row) => ({
      location: names.get(String(row.cafeId)), date: row.date.toISOString().slice(0, 10), revenue: row.total, transactions: 1,
    }))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 120).reverse();
    const context = await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    expect(context.dailyRevenue90d).toEqual(expected);
  });

  it('groups London late-night sales on each side of DST using the location timezone', async () => {
    const { owner, cafeId, london } = await seedTwoLocations();
    await Transaction.deleteMany({});
    await Transaction.create(['2026-03-28T23:30:00Z', '2026-03-29T23:30:00Z'].map((date, i) => ({
      cafeId: london._id, receiptId: `dst-${i}`, date: new Date(date), status: 'approved', total: 10,
      hour: 23, dayOfWeek: 1, items: [{ name: 'Coffee', quantity: 1, unitPrice: 10 }],
    })));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'hrtime'] });
    jest.setSystemTime(new Date('2026-04-03T12:00:00Z'));
    const context = await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    expect(context.dailyRevenue90d.map((row) => row.date)).toEqual(['2026-03-28', '2026-03-30']);
  });
  it('records the real stream cache read and write counters in the charged ledger', async () => {
    const { owner } = await seedTwoLocations();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockAnthropicMessageCreate.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { id: 'msg_ctx', model: 'test-model',
          usage: { input_tokens: 50, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300 } } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fine.' } };
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } };
        yield { type: 'message_stop' };
      },
    }));
    const response = await request.post('/api/forecasts/insights/chat/stream')
      .set('Authorization', `Bearer ${owner.token}`).set('Idempotency-Key', 't05-cache-stream')
      .send({ messages: [{ role: 'user', content: 'How was the week?' }] });
    expect(response.status).toBe(200);
    const ledger = await UsageLedger.findOne({ idempotencyKey: 't05-cache-stream' }).lean();
    expect(ledger.status).toBe('committed');
    expect(ledger.providerDiagnostics).toMatchObject({
      inputTokens: 50, outputTokens: 40, cacheReadInputTokens: 1200, cacheCreationInputTokens: 300,
    });
  });
  it('uses at most two parallel transaction aggregates for two locations, including unknown-hour coverage', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    const aggregate = jest.spyOn(Transaction, 'aggregate');
    const count = jest.spyOn(Transaction, 'countDocuments');
    await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    expect(aggregate).toHaveBeenCalledTimes(2);
    expect(count).not.toHaveBeenCalled();
  });

  it('reuses a warm context without querying and drops it on imports and scoped API writes', async () => {
    const { owner, cafeId, london } = await seedTwoLocations();
    const args = { cafeId, orgId: owner.user.orgId };
    const aggregate = jest.spyOn(Transaction, 'aggregate');
    const cafeFind = jest.spyOn(Cafe, 'findOne');
    const first = await buildBusinessContext(args);
    const cold = aggregate.mock.calls.length;
    const reads = cafeFind.mock.calls.length;
    expect(await buildBusinessContext(args)).toEqual(first);
    expect(aggregate).toHaveBeenCalledTimes(cold);
    expect(cafeFind).toHaveBeenCalledTimes(reads);
    await invalidateInsights(london._id);
    await buildBusinessContext(args);
    expect(aggregate).toHaveBeenCalledTimes(cold * 2);
    clearApiCache({ cafeId });
    await buildBusinessContext(args);
    expect(aggregate).toHaveBeenCalledTimes(cold * 3);
  });

  it('expires after five minutes and at the cafe-local midnight even within the TTL', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    const args = { cafeId, orgId: owner.user.orgId };
    const aggregate = jest.spyOn(Transaction, 'aggregate');
    // Real IO with only Date mocked: Mongo connection timers must keep running.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'hrtime'] });
    jest.setSystemTime(new Date('2026-10-17T21:59:00Z'));
    const first = await buildBusinessContext(args);
    const cold = aggregate.mock.calls.length;
    jest.setSystemTime(new Date('2026-10-17T22:01:00Z'));
    const second = await buildBusinessContext(args);
    expect(first.currentDate.date).toBe('2026-10-17');
    expect(second.currentDate.date).toBe('2026-10-18');
    expect(aggregate).toHaveBeenCalledTimes(cold * 2);
    jest.setSystemTime(new Date('2026-10-17T22:06:01Z'));
    await buildBusinessContext(args);
    expect(aggregate).toHaveBeenCalledTimes(cold * 3);
  });

  it('normalizes equivalent scopes and checks a revoked scope before reading its cache', async () => {
    const { owner, cafeId, london } = await seedTwoLocations();
    const aggregate = jest.spyOn(Transaction, 'aggregate');
    const args = { cafeId, orgId: owner.user.orgId };
    const first = await buildBusinessContext({ ...args, authorizedCafeIds: [String(cafeId), String(london._id)] });
    const cold = aggregate.mock.calls.length;
    expect(await buildBusinessContext({ ...args, authorizedCafeIds: [String(london._id), String(cafeId), String(cafeId)] })).toEqual(first);
    expect(aggregate).toHaveBeenCalledTimes(cold);
    await expect(buildBusinessContext({ ...args, authorizedCafeIds: [String(london._id)] })).rejects.toMatchObject({ code: 'CAFE_ACCESS_REVOKED' });
    expect(aggregate).toHaveBeenCalledTimes(cold);
  });

  it('does not cache a snapshot invalidated while its database reads are still running', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    const original = Transaction.aggregate.bind(Transaction);
    const aggregate = jest.spyOn(Transaction, 'aggregate').mockImplementationOnce(async (...args) => {
      const rows = await original(...args);
      await Transaction.updateOne({ cafeId, receiptId: 'ctx-morning' }, { $set: { total: 150 } });
      await invalidateInsights(cafeId);
      return rows;
    });
    const args = { cafeId, orgId: owner.user.orgId };
    expect((await buildBusinessContext(args)).dataset.totalRevenue).toBe(110);
    expect((await buildBusinessContext(args)).dataset.totalRevenue).toBe(210);
    expect(aggregate).toHaveBeenCalledTimes(4);
  });

  it('keeps unrelated cafes warm when an imported location invalidates an organisation view', async () => {
    const { owner, cafeId, london } = await seedTwoLocations();
    const args = { cafeId, orgId: owner.user.orgId };
    const aggregate = jest.spyOn(Transaction, 'aggregate');
    const managerArgs = { ...args, authorizedCafeIds: [String(cafeId)] };
    await buildBusinessContext(args);
    const manager = await buildBusinessContext(managerArgs);
    await invalidateInsights(london._id);
    expect(await buildBusinessContext(managerArgs)).toEqual(manager);
    expect(aggregate).toHaveBeenCalledTimes(4);
    await buildBusinessContext(args);
    expect(aggregate).toHaveBeenCalledTimes(6);
  });
  it('preserves the two-location timezone, refund and forecast characterization before performance changes', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    const context = await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    expect(context.dataset).toMatchObject({ transactionCount: 3, totalRevenue: 110, avgBasket: 40 });
    expect(context.dailyRevenue90d).toHaveLength(3);
    expect(context.locationPerformance90d.map(({ transactions, revenue }) => ({ transactions, revenue })))
      .toEqual([{ transactions: 2, revenue: 70 }, { transactions: 1, revenue: 40 }]);
    expect(context.dayOfWeekPattern90d).toEqual([
      { day: 'Monday', revenue: 80, transactions: 2, avgRevenuePerTransaction: 45 },
      { day: 'Tuesday', revenue: 30, transactions: 1, avgRevenuePerTransaction: 30 },
    ]);
    expect(context.topItems90d).toEqual([{ name: 'Flat White', quantity: 3, revenue: 110 }]);
    expect(context.upcomingForecasts[0].topItems).toHaveLength(10);
    expect(JSON.stringify(context)).not.toContain('factors');
  });

  it('loads only forecast fields that become model input', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    const find = jest.spyOn(Forecast, 'find');
    await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    expect(Object.keys(find.mock.results[0].value.projection()).sort()).toEqual([
      'accuracy', 'date', 'items.itemName', 'items.predictedQty', 'signals', 'totalPredictedRevenue',
    ]);
  });

  it('never gives the owner-wide context to a manager scoped to the active cafe', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    const scoped = await buildBusinessContext({ cafeId, orgId: owner.user.orgId, authorizedCafeIds: [String(cafeId)] });
    expect(scoped.locations).toHaveLength(1);
    expect(scoped.dataset.transactionCount).toBe(2);
    expect(scoped.dataset.totalRevenue).toBe(70);
  });
});
