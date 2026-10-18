const fs = require('fs');
const path = require('path');
const logger = require('../../src/utils/logger');

const capture = (level = 'debug') => {
  const lines = [];
  const log = logger.createLogger({ write: (line) => lines.push(line), level });
  return { log, lines, entries: () => lines.map((line) => JSON.parse(line)) };
};

describe('logger', () => {
  it('bounds event names and error metadata as well as ordinary fields', () => {
    const { log, entries } = capture();
    const error = Object.assign(new Error('failed'), { name: 'n'.repeat(5000), code: 'c'.repeat(5000) });
    log.error('e'.repeat(5000), error);
    const [entry] = entries();
    for (const key of ['event', 'errorName', 'errorCode']) {
      expect(entry[key].length).toBeLessThan(2100);
      expect(entry[key]).toMatch(/\.\.\.\[3000 more chars\]$/);
    }
  });

  it('limits arrays and deep objects and keeps the reserved envelope intact', () => {
    const { log, entries } = capture();
    let nested = { password: 'hidden' };
    for (let i = 0; i < 20; i += 1) nested = { nested };
    log.info('bounded', { event: 'forged', level: 'fatal', time: 'forged', rows: Array.from({ length: 100 }, (_, i) => i), nested });
    const [entry] = entries();
    expect(entry.event).toBe('bounded');
    expect(entry.level).toBe('info');
    expect(entry.time).not.toBe('forged');
    expect(entry.rows).toHaveLength(51);
    expect(entry.rows[50]).toBe('[50 more items]');
    expect(JSON.stringify(entry.nested)).toContain('[depth limit]');
    expect(JSON.stringify(entry)).not.toContain('hidden');
  });

  it('redacts credentials in a mongoose document and never serializes an axios error config', () => {
    const { Schema, model, models } = require('mongoose');
    const Probe = models.LogProbe || model('LogProbe', new Schema({ email: String, password: String, name: String }));
    const { log, entries } = capture();
    log.error('document', { document: new Probe({ email: 'private@example.invalid', password: 'private-password', name: 'probe' }) });
    log.error('axios', Object.assign(new Error('provider unavailable'), { config: { headers: { Authorization: 'Bearer private-key' } } }));
    const text = JSON.stringify(entries());
    expect(text).not.toMatch(/private@example|private-password|private-key/);
    expect(text).toContain('provider unavailable');
  });
  it('writes one JSON line with time, level, event and the fields', () => {
    const { log, lines, entries } = capture();
    log.info('upload_cleanup_summary', { deleted: 2, failed: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(entries()[0]).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      level: 'info',
      event: 'upload_cleanup_summary',
      deleted: 2,
      failed: 0,
    });
  });

  it('redacts secrets and personal data by key at any depth', () => {
    const { log, entries } = capture();
    log.error('provider_failed', {
      password: 'hunter2',
      headers: { authorization: 'Bearer abc', cookie: 'rt=1' },
      nested: { apiKey: 'sk_live_x', resetToken: 't' },
      email: 'owner@cafe.co.za',
      reference: 'ref-1',
      checksPassed: 3,
    });
    const [entry] = entries();
    expect(entry.password).toBe('[redacted]');
    expect(entry.headers).toEqual({ authorization: '[redacted]', cookie: '[redacted]' });
    expect(entry.nested).toEqual({ apiKey: '[redacted]', resetToken: '[redacted]' });
    expect(entry.email).toBe('[redacted]');
    expect(entry.reference).toBe('ref-1');
    expect(entry.checksPassed).toBe(3);
  });

  it('scrubs credentials out of URLs inside strings', () => {
    const { log, entries } = capture();
    log.error('mongo_error', { errorMessage: 'connection to mongodb://admin:hunter2@db.internal:27017/app closed' });
    expect(entries()[0].errorMessage).toBe('connection to mongodb://[redacted]@db.internal:27017/app closed');
  });

  it('caps long strings so one event cannot flood the log', () => {
    const { log, entries } = capture();
    log.warn('big', { body: 'x'.repeat(5000) });
    const { body } = entries()[0];
    expect(body.startsWith('x'.repeat(2000))).toBe(true);
    expect(body.endsWith('...[3000 more chars]')).toBe(true);
  });

  it('survives circular objects, BigInt, ObjectId-like values and undefined', () => {
    const { log, entries } = capture();
    const loop = { name: 'loop' };
    loop.self = loop;
    log.info('odd_values', { loop, big: 10n, id: { toHexString: () => '64b000000000000000000001' }, gone: undefined });
    const [entry] = entries();
    expect(entry).toMatchObject({ loop: { name: 'loop', self: '[circular]' }, big: '10', id: '64b000000000000000000001' });
    expect(entry).not.toHaveProperty('gone');
  });

  it('drops events below LOG_LEVEL and writes nothing when silent', () => {
    const warnOnly = capture('warn');
    warnOnly.log.info('quiet', {});
    warnOnly.log.warn('loud', {});
    expect(warnOnly.entries().map((entry) => entry.event)).toEqual(['loud']);
    const silent = capture('silent');
    silent.log.fatal('nothing', {});
    expect(silent.lines).toEqual([]);
  });

  it('never throws, even when the sink does', () => {
    const log = logger.createLogger({ write: () => { throw new Error('EPIPE'); }, level: 'debug' });
    expect(() => log.error('x', {})).not.toThrow();
  });

  it('reduces an error to name, message and code, with the stack only on request', () => {
    const error = Object.assign(new Error('boom'), { code: 'E_BOOM', statusCode: 502 });
    expect(logger.errorFields(error)).toEqual({ errorName: 'Error', errorMessage: 'boom', errorCode: 'E_BOOM', statusCode: 502 });
    expect(logger.errorFields(error, { stack: true }).stack).toMatch(/boom/);
    expect(logger.errorFields('a string reason')).toEqual({ errorName: 'NonError', errorMessage: 'a string reason' });
  });
});

describe('logging discipline in src', () => {
  const SRC_ROOT = path.resolve(__dirname, '../../src');
  const SEEDS = new Set(['seed.js', 'seed-bulk.js']);
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  const offenders = (pattern, allowed = () => false) =>
    walk(SRC_ROOT)
      .filter((file) => !SEEDS.has(path.basename(file)) && !allowed(file))
      .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
        .map((line, index) => (pattern.test(line) ? `${path.relative(SRC_ROOT, file)}:${index + 1}` : null))
        .filter(Boolean));

  it('has no console.log in src outside the seed scripts', () => {
    expect(offenders(/console\.log\(/)).toEqual([]);
  });

  it('writes to the console only from the development email transport', () => {
    const emailService = path.join('services', 'email.service.js');
    expect(offenders(/console\.(info|warn|error|debug)\(/, (file) => file.endsWith(emailService))).toEqual([]);
  });

  it('writes to stdout directly only from the logger', () => {
    const loggerFile = path.join('utils', 'logger.js');
    expect(offenders(/process\.stdout\.write\(/, (file) => file.endsWith(loggerFile))).toEqual([]);
  });
});
