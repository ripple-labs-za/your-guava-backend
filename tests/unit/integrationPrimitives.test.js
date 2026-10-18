const { singleFlight } = require('../../src/utils/singleFlight');
const { syncWindow } = require('../../src/services/integrations/salesSummary');
const { pickAccount, isValidAccountId } = require('../../src/services/integrations/common');
const { toUpstreamError, OutboundTimeoutError, outboundPolicy } = require('../../src/utils/http');

describe('integration account verification', () => {
  it.each([{}, [], '', '__proto__', 'constructor_', 'a'.repeat(65), 'tenant\n'])('refuses malformed account id %j', (id) => {
    expect(isValidAccountId(id)).toBe(false);
  });

  it('accepts bounded provider-issued account identifiers', () => {
    expect(isValidAccountId('A-b-123')).toBe(true);
    expect(isValidAccountId('a'.repeat(64))).toBe(true);
  });

  it('refuses an empty account list and does not guess among several accounts', () => {
    const args = { providerLabel: 'Sage', accountNoun: 'business' };
    expect(() => pickAccount({ ...args, ids: [] })).toThrow(expect.objectContaining({ publicCode: 'INTEGRATION_NO_ACCOUNT' }));
    expect(() => pickAccount({ ...args, ids: ['one', 'two'] }))
      .toThrow(expect.objectContaining({ publicCode: 'INTEGRATION_ACCOUNT_CHOICE_REQUIRED' }));
    expect(pickAccount({ ...args, ids: ['one'] })).toBe('one');
    expect(pickAccount({ ...args, ids: ['one', 'two'], requestedId: 'two' })).toBe('two');
    expect(() => pickAccount({ ...args, ids: ['one'], requestedId: 'two' }))
      .toThrow(expect.objectContaining({ publicCode: 'INTEGRATION_ACCOUNT_MISMATCH' }));
  });
});

describe('closed local day windows', () => {
  it('uses the cafe-local midnight across the spring DST transition', () => {
    expect(syncWindow({ timezone: 'America/New_York', now: new Date('2026-03-09T13:00:00Z') })).toEqual({
      timezone: 'America/New_York',
      periodStart: new Date('2026-03-02T05:00:00Z'),
      periodEnd: new Date('2026-03-09T04:00:00Z'),
    });
  });

  it('takes catch-up work in 31 local-day steps', () => {
    const first = syncWindow({
      timezone: 'Africa/Johannesburg', lastSyncedThrough: new Date('2026-01-01T22:00:00Z'),
      now: new Date('2026-04-02T13:00:00Z'),
    });
    expect(first.periodStart).toEqual(new Date('2026-01-01T22:00:00Z'));
    expect(first.periodEnd).toEqual(new Date('2026-02-01T22:00:00Z'));
    const second = syncWindow({ timezone: first.timezone, lastSyncedThrough: first.periodEnd, now: new Date('2026-04-02T13:00:00Z') });
    expect(second.periodStart).toEqual(first.periodEnd);
    expect(second.periodEnd).toEqual(new Date('2026-03-04T22:00:00Z'));
  });

  it('stops at the start of today and skips a fully synced cafe', () => {
    const args = { timezone: 'Africa/Johannesburg', now: new Date('2026-10-18T22:00:01Z') };
    expect(syncWindow(args).periodEnd).toEqual(new Date('2026-10-18T22:00:00Z'));
    expect(syncWindow({ ...args, lastSyncedThrough: new Date('2026-10-18T22:00:00Z') })).toBeNull();
  });
});

describe('single flight lifecycle', () => {
  it('queues exclusive work after a failed refresh and keeps later refreshes separate', async () => {
    let rejectFirst;
    let finishExclusive;
    const order = [];
    const first = singleFlight('exclusive-order', () => new Promise((_, reject) => { rejectFirst = reject; }));
    const failed = first.catch(() => {});
    await Promise.resolve();
    const exclusive = singleFlight('exclusive-order', () => {
      order.push('disconnect');
      return new Promise((resolve) => { finishExclusive = resolve; });
    }, { exclusive: true });
    const refresh = singleFlight('exclusive-order', () => { order.push('refresh'); return 'access-token'; });
    expect(singleFlight('exclusive-order', () => 'should not run')).toBe(refresh);
    expect(exclusive).not.toBe(first);
    expect(refresh).not.toBe(exclusive);
    rejectFirst(new Error('old grant failed'));
    await failed;
    // Wait until the queued lifecycle operation starts, without a timing budget.
    while (!finishExclusive) await Promise.resolve();
    expect(order).toEqual(['disconnect']);
    finishExclusive('revoked');
    await expect(exclusive).resolves.toBe('revoked');
    await expect(refresh).resolves.toBe('access-token');
    expect(order).toEqual(['disconnect', 'refresh']);
    await expect(singleFlight('exclusive-order', () => 'next')).resolves.toBe('next');
  });
  it('releases a failed flight so the next attempt can succeed', async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce('second');
    const first = singleFlight('test-failure', run);
    expect(singleFlight('test-failure', run)).toBe(first);
    await expect(first).rejects.toThrow('first');
    await expect(singleFlight('test-failure', run)).resolves.toBe('second');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('separates tenants and providers', async () => {
    const run = jest.fn(async () => 'ok');
    await Promise.all(['cafe1:xero', 'cafe2:xero', 'cafe1:sage'].map((key) => singleFlight(key, run)));
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('provider error conversion', () => {
  it.each([[401, 'UPSTREAM_AUTH_FAILED'], [403, 'UPSTREAM_AUTH_FAILED'], [429, 'UPSTREAM_ERROR'], [500, 'UPSTREAM_ERROR']])(
    'maps provider %i to fixed 502 text with code %s', (status, code) => {
      const raw = Object.assign(new Error('sensitive provider text'), { response: { status, data: { error_description: 'secret merchant configuration' } } });
      const wrapped = toUpstreamError('onegate', raw);
      expect(wrapped).toMatchObject({ statusCode: 502, publicCode: code, upstreamStatus: status, cause: raw, exposeMessage: true });
      expect(wrapped.message).not.toMatch(/sensitive|secret merchant/);
    }
  );

  it('retains the whole-request timeout identity and limits logged provider text', () => {
    const timeout = new OutboundTimeoutError(outboundPolicy('xero'), 'total');
    expect(toUpstreamError('xero', timeout)).toBe(timeout);
    const wrapped = toUpstreamError('sage', { response: { status: 500, data: { message: 'x'.repeat(500) } } });
    expect(wrapped.upstreamMessage).toHaveLength(200);
    expect(toUpstreamError('sage', null)).toMatchObject({ statusCode: 502, publicCode: 'UPSTREAM_UNREACHABLE' });
  });
});
