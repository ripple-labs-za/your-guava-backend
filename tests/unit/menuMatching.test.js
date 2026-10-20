const { normalizeItemName } = require('../../src/services/menuItems.service');
const {
  MATCH_SCORE_THRESHOLD, createMatchBudget, prepareMatchPool, rankMatchCandidates,
} = require('../../src/services/menuMatching');

// The scorer as it was until this card, kept only as the reference the new
// one must agree with. Never run it on the crafted menu: that is the defect.
const legacyLevenshtein = (a = '', b = '') => {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
};
const legacySimilarity = (a = '', b = '') => {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  if (Math.min(a.length, b.length) / longest < 0.35) return 0;
  return 1 - (legacyLevenshtein(a, b) / longest);
};
const legacyRank = (item, pool, limit = 3) => {
  const key = normalizeItemName(item.name);
  if (!key) return [];
  const tokens = new Set(key.split(' ').filter(Boolean));
  return pool
    .filter((candidate) => String(candidate._id) !== String(item._id))
    .map((candidate) => {
      const candidateKey = normalizeItemName(candidate.name);
      const candidateTokens = new Set(candidateKey.split(' ').filter(Boolean));
      const overlap = [...tokens].filter((token) => candidateTokens.has(token)).length;
      const union = new Set([...tokens, ...candidateTokens]).size || 1;
      const aliasScore = Math.max(0, ...(candidate.aliases || []).map((alias) => legacySimilarity(key, normalizeItemName(alias))));
      return { item: candidate, score: Math.max(overlap / union, legacySimilarity(key, candidateKey), aliasScore) };
    })
    .filter((candidate) => candidate.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

const randomFrom = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const WORDS = [
  'flat', 'white', 'oat', 'latte', 'cappuccino', 'capuccino', 'americano', 'mocha', 'chai', 'iced', 'large', 'small',
  'decaf', 'muffin', 'croissant', 'toastie', 'cheese', 'ham', 'banana', 'bread', 'carrot', 'cake', 'still', 'water',
  'coke', 'zero', 'juice', 'orange', 'scone', 'brownie', '330ml', 'blend',
];
const nameFrom = (random) => {
  const words = Array.from({ length: 1 + Math.floor(random() * 4) }, () => WORDS[Math.floor(random() * WORDS.length)]);
  let name = words.join(' ');
  if (random() < 0.3) { const at = Math.floor(random() * name.length); name = name.slice(0, at) + name.slice(at + 1); }
  if (random() < 0.2) name = name.replace(/ /g, '');
  if (random() < 0.3) name = `${name.toUpperCase()} (Blend)`;
  return name;
};
const menu = (random, count, maxAliases) => Array.from({ length: count }, (_, index) => ({
  _id: `c${index}`,
  name: nameFrom(random),
  aliases: Array.from({ length: Math.floor(random() * (maxAliases + 1)) }, () => nameFrom(random)),
}));
const reviewItems = (random, count) => Array.from({ length: count }, (_, index) => ({ _id: `r${index}`, name: nameFrom(random) }));
const summary = (ranked) => ranked.map((candidate) => ({ id: candidate.item._id, score: candidate.score }));
const OPTIONS = { normalize: normalizeItemName };

describe('bounded fuzzy matching', () => {
  it('keeps the old threshold', () => {
    expect(MATCH_SCORE_THRESHOLD).toBe(0.35);
  });

  it.each([
    ['a page-sized menu with a few aliases', 11, 60, 80, 4],
    ['a small menu with fifty aliases each', 12, 30, 20, 50],
  ])('ranks %s exactly as the old scorer did', (label, seed, itemCount, poolSize, maxAliases) => {
    const random = randomFrom(seed);
    const pool = menu(random, poolSize, maxAliases);
    const prepared = prepareMatchPool(pool, OPTIONS);
    const differences = reviewItems(random, itemCount)
      .map((item) => ({ item: item.name, expected: summary(legacyRank(item, pool)), actual: summary(rankMatchCandidates(item, prepared, OPTIONS)) }))
      .filter((entry) => JSON.stringify(entry.expected) !== JSON.stringify(entry.actual));
    expect(differences).toEqual([]);
    expect(prepared.budget.exhausted).toBe(false);
  });

  it('agrees with the old scorer on the edges the review names', () => {
    // A character outside [a-z0-9 ] after normalisation, empty aliases, an alias equal to the review name, a 50th-alias best score, ties.
    const pool = [
      { _id: 'c1', name: 'Cappuccino', aliases: ['', 'capuccino', 'Cappucino'] },
      { _id: 'c2', name: 'Flat White', aliases: Array.from({ length: 49 }, (_, i) => `zz${i}`).concat(['Flat Whyte']) },
      { _id: 'c3', name: 'Latte', aliases: ['Flat Whyte'] },
      { _id: 'c4', name: 'Caffè Latte', aliases: ['café latte'] },
      { _id: 'c5', name: 'ab', aliases: ['ba', 'aab'] },
      { _id: 'c6', name: 'abb', aliases: [] },
      { _id: 'c7', name: 'Iced Latte', aliases: ['Iced Latte'] },
      { _id: 'c8', name: 'Iced Latte', aliases: [] },
    ];
    const items = [
      { _id: 'r1', name: 'Capuccino' }, { _id: 'r2', name: 'Flat Whyte' }, { _id: 'r3', name: 'Caffè Latte' }, { _id: 'r4', name: 'ba' },
      { _id: 'r5', name: 'abb' }, { _id: 'r6', name: 'Iced Latte' }, { _id: 'c7', name: 'Iced Latte' }, { _id: 'r7', name: '' },
      { _id: 'r8', name: 'zz3' }, { _id: 'r9', name: 'café' }, { _id: 'r10', name: '(Blend)' },
    ];
    const prepared = prepareMatchPool(pool, OPTIONS);
    for (const item of items) {
      expect({ item: item.name, ranked: summary(rankMatchCandidates(item, prepared, OPTIONS)) })
        .toEqual({ item: item.name, ranked: summary(legacyRank(item, pool)) });
    }
    expect(prepared.budget.exhausted).toBe(false);
  });

  it('[budget] ranks 2,000 review items against 2,000 candidates in under 1 s', () => {
    const random = randomFrom(7);
    const pool = menu(random, 2000, 2);
    const items = reviewItems(random, 2000);
    const runs = [];
    let exhausted = false;
    for (let run = 0; run < 3; run += 1) {
      const started = process.hrtime.bigint();
      const prepared = prepareMatchPool(pool, OPTIONS);
      for (const item of items) rankMatchCandidates(item, prepared, OPTIONS);
      runs.push(Number(process.hrtime.bigint() - started) / 1e6);
      exhausted = prepared.budget.exhausted;
    }
    const median = [...runs].sort((a, b) => a - b)[1];
    console.log(`2,000 x 2,000: runs ${runs.map((ms) => ms.toFixed(0)).join(', ')} ms, budget exhausted: ${exhausted}`);
    expect(median).toBeLessThan(1000);
  });

  it('[budget] bounds a crafted menu of 100 candidates with 50 near-identical 200-character aliases', () => {
    const long = (seed) => `${'a'.repeat(190)}${String(seed).padStart(10, '0')}`;
    const pool = Array.from({ length: 100 }, (_, c) => ({
      _id: `c${c}`, name: long(c * 1000), aliases: Array.from({ length: 50 }, (_, a) => long(c * 1000 + a + 1)),
    }));
    const items = Array.from({ length: 100 }, (_, index) => ({ _id: `r${index}`, name: long(900_000 + index) }));
    const started = process.hrtime.bigint();
    const prepared = prepareMatchPool(pool, OPTIONS);
    for (const item of items) rankMatchCandidates(item, prepared, OPTIONS);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`crafted 100 x 100 x 50 aliases x 200 chars: ${ms.toFixed(0)} ms, budget left ${JSON.stringify(prepared.budget)}`);
    expect(ms).toBeLessThan(1000);
    expect(prepared.budget.exhausted).toBe(true);
  });

  it('offers no fuzzy candidate once the budget is spent, and never throws', () => {
    const pool = [{ _id: 'c1', name: 'Cappuccino', aliases: [] }];
    const prepared = prepareMatchPool(pool, { ...OPTIONS, budget: createMatchBudget({ comparisons: 0 }) });
    expect(rankMatchCandidates({ _id: 'r1', name: 'Capuccino' }, prepared, OPTIONS)).toEqual([]);
    expect(prepared.budget.exhausted).toBe(true);
  });
});
