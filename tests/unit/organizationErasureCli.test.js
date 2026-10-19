const mongoose = require('mongoose');
const { spawnSync } = require('child_process');
const erasure = () => require('../../src/migrations/erase-organization');
const orgId = '507f1f77bcf86cd799439011';

test('CLI is dry-run-first, requires an org, and rejects misspelled or duplicate options', () => {
  const { parseArgs } = erasure();
  expect(parseArgs(['--org', orgId])).toEqual({ orgId, apply: false, allowProduction: false, requesterNote: undefined });
  expect(parseArgs(['--org', orgId, '--apply', '--requester-note', 'case-105']).apply).toBe(true);
  expect(() => parseArgs([])).toThrow('--org');
  expect(() => parseArgs(['--org', 'bad'])).toThrow('--org');
  expect(() => parseArgs(['--org', orgId, '--aply'])).toThrow('Unknown');
  expect(() => parseArgs(['--org', orgId, '--org', orgId])).toThrow('Duplicate');
  expect(() => parseArgs(['--org', orgId, '--apply'])).toThrow('case reference');
});

test.each([
  ['mongodb://remote.example/db', 'development'],
  ['mongodb+srv://cluster.example/db', 'production'],
  ['mongodb://localhost.evil.example/db', 'development'],
  ['mongodb://localhost:27199/db', 'production'],
])('unsafe target %s requires both explicit opt-in and exact typed confirmation', (mongoUri, nodeEnv) => {
  const { assertSafeTarget } = erasure();
  const opts = { mongoUri, nodeEnv, orgId };
  expect(() => assertSafeTarget(opts)).toThrow('Refusing');
  expect(() => assertSafeTarget({ ...opts, confirmation: `ERASE ${orgId}` })).toThrow('Refusing');
  expect(() => assertSafeTarget({ ...opts, allowProduction: true })).toThrow('confirmation');
  expect(() => assertSafeTarget({ ...opts, allowProduction: true, confirmation: `ERASE ${orgId}x` })).toThrow('confirmation');
  expect(() => assertSafeTarget({ ...opts, allowProduction: true, confirmation: `ERASE ${orgId}` })).not.toThrow();
});

test('local target uses the seed safety predicate and refuses an absent URI', () => {
  const { assertSafeTarget } = erasure();
  expect(() => assertSafeTarget({ mongoUri: 'mongodb://127.0.0.1:27199/db', nodeEnv: 'development', orgId })).not.toThrow();
  expect(() => assertSafeTarget({ orgId, allowProduction: true, confirmation: `ERASE ${orgId}` })).toThrow('MONGODB_URI');
});

test.each(['local', 'misconfigured'])('remote apply refuses %s storage even with exact confirmation', (mode) => {
  const storage = require('../../src/services/r2.service');
  const status = jest.spyOn(storage, 'getConfigurationStatus').mockReturnValue({ mode });
  const target = {
    mongoUri: 'mongodb://remote.invalid/db', nodeEnv: 'development', orgId,
    allowProduction: true, confirmation: `ERASE ${orgId}`, apply: true,
  };
  try {
    expect(() => erasure().assertSafeTarget(target)).toThrow('Refusing remote/production erasure without R2 storage');
    expect(() => erasure().assertSafeTarget({ ...target, apply: false })).not.toThrow();
    expect(() => erasure().assertSafeTarget({ ...target, mongoUri: 'mongodb://127.0.0.1:27199/db' })).not.toThrow();
    status.mockReturnValue({ mode: 'r2' });
    expect(() => erasure().assertSafeTarget(target)).not.toThrow();
  } finally { status.mockRestore(); }
});

test('startup registry never registers or imports the operator erasure', () => {
  const result = spawnSync(process.execPath, ['-e', [
    "const registry = require('./src/migrations');",
    "const filename = require.resolve('./src/migrations/erase-organization');",
    'console.log(JSON.stringify({names: registry.map(row => row.name), imported: !!require.cache[filename]}));',
  ].join('\n')], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.names).not.toContain('erase-organization');
  expect(report.imported).toBe(false);
});

test('remote CLI apply with typed confirmation refuses local storage before connecting', async () => {
  const storage = require('../../src/services/r2.service');
  const readline = require('readline');
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const terminal = { question: jest.fn((prompt, answer) => answer(`ERASE ${orgId}`)), close: jest.fn() };
  const terminalSpy = jest.spyOn(readline, 'createInterface').mockReturnValue(terminal);
  const status = jest.spyOn(storage, 'getConfigurationStatus').mockReturnValue({ mode: 'local' });
  const connect = jest.spyOn(mongoose, 'connect');
  try {
    await expect(erasure().main([
      '--org', orgId, '--apply', '--allow-production', '--requester-note', 'case-105',
    ], { MONGODB_URI: 'mongodb://remote.invalid/db', NODE_ENV: 'development' }))
      .rejects.toThrow('Refusing remote/production erasure without R2 storage');
    expect(terminal.question).toHaveBeenCalledTimes(1);
    expect(terminal.close).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore(); status.mockRestore(); terminalSpy.mockRestore();
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete process.stdin.isTTY;
  }
});

test('CLI refuses a remote host before opening a Mongo connection', async () => {
  const connect = jest.spyOn(mongoose, 'connect');
  await expect(erasure().main(['--org', orgId], { MONGODB_URI: 'mongodb://remote.invalid/db', NODE_ENV: 'development' }))
    .rejects.toThrow('Refusing');
  expect(connect).not.toHaveBeenCalled();
  connect.mockRestore();
  const result = spawnSync(process.execPath, ['src/migrations/erase-organization.js'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MONGODB_URI: 'mongodb://remote.invalid/db' },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('--org');
  expect(result.stdout).not.toContain('remote.invalid');
  expect(result.stderr).not.toContain('remote.invalid');
});
