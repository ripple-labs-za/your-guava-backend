const fs = require('fs');
const path = require('path');

const SRC_ROOT = path.resolve(__dirname, '../../src');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return entry.name.endsWith('.js') ? [full] : [];
});
const sources = walk(SRC_ROOT).map((file) => ({ file: path.relative(SRC_ROOT, file), source: fs.readFileSync(file, 'utf8') }));

// The text of `const <name> = ...` up to the next top-level `const`.
const bodyOf = (source, name) => {
  const start = source.indexOf(`const ${name} =`);
  if (start === -1) return null;
  const next = source.indexOf('\nconst ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
};

describe('API cache callers', () => {
  it('always name the cafe or organisation they evict', () => {
    const unscoped = sources.flatMap(({ file, source }) =>
      [...source.matchAll(/clearApiCache\(\s*(\{\s*\})?\s*\)/g)].map((match) => `${file}: ${match[0]}`));
    expect(unscoped).toEqual([]);
  });

  it('never evict anything from an unauthenticated payment callback', () => {
    const handlers = ['handleOneGateWebhook', 'handlePaystackReturn', 'handlePaystackWebhook'];
    const found = [];
    const offenders = [];
    for (const { file, source } of sources) {
      for (const name of handlers) {
        const body = bodyOf(source, name);
        if (body === null) continue;
        found.push(name);
        if (body.includes('clearApiCache')) offenders.push(`${file}: ${name}`);
      }
    }
    expect(found.sort()).toEqual([...handlers].sort());
    expect(offenders).toEqual([]);
  });
});
