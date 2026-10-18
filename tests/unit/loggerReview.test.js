const logger = require('../../src/utils/logger');
const capture = () => {
  const lines = [];
  return { log: logger.createLogger({ write: (line) => lines.push(JSON.parse(line)), level: 'debug' }), lines };
};

it('preserves caller metadata that collides with the log envelope', () => {
  const { log, lines } = capture();
  log.error('payment_webhook_reconcile_failed', { event: 'charge.success', level: 'upstream', time: 'provider-time' });
  expect(lines[0]).toMatchObject({ event: 'payment_webhook_reconcile_failed', level: 'error',
    caller_event: 'charge.success', caller_level: 'upstream', caller_time: 'provider-time' });
});

it('scrubs e-mail addresses and token or key query parameters inside strings', () => {
  const { log, lines } = capture();
  log.error('failed', { message: 'duplicate owner@cafe.co.za; GET /reset?token=private-token&api_key=private-key&ok=yes' });
  expect(lines[0].message).not.toMatch(/owner@cafe|private-token|private-key/);
  expect(lines[0].message).toContain('ok=yes');
});

it('redacts the entire URL userinfo including at signs and passwordless forms', () => {
  const { log, lines } = capture();
  log.error('failed', { urls: ['mongodb://admin:p@ss@db/app', 'redis://:hunter2@cache:6379', 'https://ghp_private@github.com/x'] });
  expect(lines[0].urls).toEqual(['mongodb://[redacted]@db/app', 'redis://[redacted]@cache:6379', 'https://[redacted]@github.com/x']);
});

it('redacts expanded personal and verification fields at nested levels', () => {
  const { log, lines } = capture();
  const keys = ['ownerEmail', 'mobile', 'verificationCode', 'last4', 'bin', 'pan', 'cvv', 'otp'];
  log.error('failed', { nested: Object.fromEntries(keys.map((key) => [key, 'private'])) });
  expect(lines[0].nested).toEqual(Object.fromEntries(keys.map((key) => [key, '[redacted]'])));
});

it('keeps shared values and healthy fields when another getter throws', () => {
  const { log, lines } = capture();
  const shared = { id: 1 };
  log.info('x', { a: shared, b: shared, get boom() { throw new Error('getter failed'); }, ok: 1 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ a: { id: 1 }, b: { id: 1 }, ok: 1, boom: '[unavailable]' });
});

it('keeps healthy array members when an array getter throws', () => {
  const { log, lines } = capture();
  const rows = [1, 2, 3];
  Object.defineProperty(rows, '1', { get() { throw new Error('array getter'); } });
  log.info('array', { rows });
  expect(lines[0].rows).toEqual([1, '[unavailable]', 3]);
});

it('keeps string limits after expanding short addresses into redaction markers', () => {
  const { log, lines } = capture();
  log.info('bounded', { message: 'a@b.co '.repeat(285) });
  expect(lines[0].message.length).toBeLessThan(2100);
  expect(lines[0].message).not.toContain('a@b.co');
});
