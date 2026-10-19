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
  expect(result.stderr).toContain('--org');
  expect(result.stderr).not.toContain('remote.invalid');
});
