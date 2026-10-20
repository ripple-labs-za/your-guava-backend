const { parsePackedItems } = require('../../src/services/parser.service');

// The grammar as it was until this card, kept only as the reference the
// linear scanner must agree with on every input. Never call it on long input.
const LEGACY_QUANTITY = String.raw`-?\d+(?:[.,]\d+)?`;
const LEGACY_MARKER = String.raw`\s+[x×]\s+`;
const LEGACY_PACKED_ITEM_RE = new RegExp(
  `(${LEGACY_QUANTITY})${LEGACY_MARKER}([^\\n]+?)(?:[,;\\n](?=\\s*${LEGACY_QUANTITY}${LEGACY_MARKER})|$)`,
  'gi'
);
const LEGACY_LOOSE_RE = new RegExp(`^(${LEGACY_QUANTITY})\\s*[x\\u00d7]\\s+(.+)$`, 'i');
const legacyQuantity = (raw) => {
  const quantity = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(quantity) && quantity !== 0 ? quantity : null;
};
const legacyParsePackedItems = (str) => {
  if (!str) return [];
  const items = [];
  const regex = new RegExp(LEGACY_PACKED_ITEM_RE.source, LEGACY_PACKED_ITEM_RE.flags);
  let match;
  while ((match = regex.exec(str)) !== null) {
    const quantity = legacyQuantity(match[1]);
    const name = match[2].trim();
    if (name && quantity != null) items.push({ name, quantity });
  }
  if (items.length > 0) return items;
  return String(str)
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const loose = part.match(LEGACY_LOOSE_RE);
      if (loose) return { name: loose[2].trim(), quantity: legacyQuantity(loose[1]) };
      if (!/\p{L}/u.test(part)) return null;
      return { name: part, quantity: 1 };
    })
    .filter((item) => item && item.name && item.quantity != null && item.quantity !== 0);
};

// Deterministic generator (mulberry32) so a failure reproduces from its seed.
const randomFrom = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Built from char codes where a raw character would be a control byte or a line separator.
const NBSP = String.fromCharCode(0xa0);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const CHARS = ['1', '2', '0', '9', '-', '.', ',', ';', '\n', '\r', ' ', ' ', '\t', 'x', 'X', '×', 'a', 'B', 'é', '(', ')', NBSP, LINE_SEPARATOR];
const TOKENS = ['1 x ', '-2 × ', '0,5 x ', '1.5 X ', 'Flat White', 'Latte (Oat)', ',', ';', '\n', ' ', 'x', '12', '3 ', '\r\n', ' x '];

const ADVERSARIAL = `${'1'.repeat(4995)} x ${'a'.repeat(4995)}\nz`;
const REPEATED_MARKERS = `${'1 x '.repeat(2495)}\nz`;

const timedMs = (fn) => {
  const started = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
};

describe('packed item grammar is linear', () => {
  it.each([
    ['a 10,000-character digit run before a newline', ADVERSARIAL],
    ['2,495 repeated "1 x " markers before a newline', REPEATED_MARKERS],
  ])('[budget] parses %s in under 20 ms', (label, cell) => {
    expect(cell.length).toBeLessThanOrEqual(10_000);
    parsePackedItems(cell); // warm-up: the budget is for steady state, not compilation
    const { value, ms } = timedMs(() => parsePackedItems(cell));
    console.log(`${label}: ${ms.toFixed(2)} ms, ${value.length} item(s)`);
    expect(ms).toBeLessThan(20);
  });

  it('returns what the legacy grammar returned for the adversarial cells', () => {
    expect(parsePackedItems(ADVERSARIAL)).toEqual([{ name: 'z', quantity: 1 }]);
    expect(legacyParsePackedItems(ADVERSARIAL)).toEqual([{ name: 'z', quantity: 1 }]);
    // The plan expected two items here; the grammar as shipped returns one (the
    // reference, run on the old code, says so), and the scanner must agree.
    const repeated = parsePackedItems(REPEATED_MARKERS);
    console.log(`repeated markers: ${JSON.stringify(repeated.map((item) => ({ ...item, name: item.name.slice(0, 20) })))}`);
    expect(repeated).toEqual(legacyParsePackedItems(REPEATED_MARKERS));
  });

  it('agrees with the legacy grammar on 20,000 generated cells', () => {
    const random = randomFrom(20260922);
    const differences = [];
    for (let caseIndex = 0; caseIndex < 20_000; caseIndex += 1) {
      const useTokens = caseIndex % 2 === 0;
      const length = Math.floor(random() * (useTokens ? 8 : 30));
      let cell = '';
      for (let position = 0; position < length; position += 1) {
        const pool = useTokens ? TOKENS : CHARS;
        cell += pool[Math.floor(random() * pool.length)];
      }
      const expected = legacyParsePackedItems(cell);
      const actual = parsePackedItems(cell);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) differences.push({ cell, expected, actual });
      if (differences.length >= 5) break;
    }
    expect(differences).toEqual([]);
  });

  it('agrees with the legacy grammar at the edges the review names, long cells first', () => {
    const edges = [
      '1 x A,', '1 x A,  2 x B', '1 x A\r\n2 x B', `1${NBSP}x${NBSP}A`, `1${LINE_SEPARATOR}x A`, '- x A', '1.x A', '1,5x A', '2×Latte',
      '1 x Latte, 2 x Brownie; 3 x Muffin', '1 x , 2 x B', '1 x A;\n', '', ' ', '-1 x Refund', '0 x Nothing', '1,5 x Half', '1.5 x Half',
      ','.repeat(200), ' '.repeat(200), '-'.repeat(200), `${'1 x a,'.repeat(300)}`,
    ];
    for (const cell of edges) {
      expect({ cell, items: parsePackedItems(cell) }).toEqual({ cell, items: legacyParsePackedItems(cell) });
    }
  });
});
