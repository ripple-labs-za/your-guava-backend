const fs = require('fs');
const path = require('path');

const compose = fs.readFileSync(path.resolve(__dirname, '../../docker-compose.yml'), 'utf8');

describe('local docker compose', () => {
  it('publishes MongoDB on loopback only, never on every host interface', () => {
    // The block runs until the first line that is neither a list item nor a comment.
    const blocks = [...compose.matchAll(/^[ \t]*ports:[ \t]*\r?\n((?:[ \t]*(?:#.*|-[ \t]*.+)\r?\n?)+)/gm)].map((match) => match[1]);
    const mappings = blocks.flatMap((block) => block.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('-')));
    expect(mappings.length).toBeGreaterThan(0);
    for (const mapping of mappings) {
      expect(mapping).toMatch(/^-\s*"?127\.0\.0\.1:\d+:\d+"?$/);
    }
  });

  it('still runs a replica set, which uploads and billing need for transactions', () => {
    expect(compose).toMatch(/--replSet', 'rs0'/);
  });
});
