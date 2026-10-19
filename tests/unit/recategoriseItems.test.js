const { plan, legacyInferItemCategory } = require('../../src/migrations/recategorise-items');

const item = (name, category) => ({ _id: name, cafeId: 'cafe1', name, category });

describe('recategorise-items migration', () => {
  describe('provenance test', () => {
    it('keeps a category the owner set even when it equals what the old rules produced', () => {
      // "House Coffee (Blend)" is a retail bag of beans to this owner. The old rules
      // also said retail, so provenance-by-reproduction alone would overwrite it.
      const { updates, keptManual } = plan([{ ...item('House Coffee (Blend)', 'retail'), manualFields: ['category'] }]);
      expect(updates).toHaveLength(0);
      expect(keptManual).toEqual([
        expect.objectContaining({ name: 'House Coffee (Blend)', stored: 'retail', wouldBecome: 'coffee', reason: 'manualFields' }),
      ]);
    });

    it('still repairs an auto-assigned value when only price or aliases were set by hand', () => {
      const { updates } = plan([{ ...item('House Coffee (Blend)', 'retail'), manualFields: ['expectedPrice', 'aliases'] }]);
      expect(updates).toEqual([expect.objectContaining({ from: 'retail', to: 'coffee' })]);
    });

    it('repairs an item the old classifier misfiled', () => {
      // "House Coffee (Blend)" became retail under the old 'blend' rule.
      const { updates } = plan([item('House Coffee (Blend)', 'retail')]);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ from: 'retail', to: 'coffee' });
    });

    it('never overwrites a category a person set by hand', () => {
      // The old rules would have said "food" for a lemon bake. A stored value of
      // "cold_drink" can only have come from a human, so it must survive.
      const { updates, keptManual } = plan([item('Lemon Poppyseed', 'cold_drink')]);
      expect(updates).toHaveLength(0);
      expect(keptManual).toHaveLength(1);
      expect(keptManual[0].stored).toBe('cold_drink');
    });

    it('leaves items that are already correct alone', () => {
      const { updates, keptManual } = plan([item('Flat White (Blend)', 'coffee')]);
      expect(updates).toHaveLength(0);
      expect(keptManual).toHaveLength(0);
    });

    it('promotes items stranded on "other"', () => {
      const { updates } = plan([item('Toastie', 'other')]);
      expect(updates[0]).toMatchObject({ from: 'other', to: 'food' });
    });

    it('treats a missing category as "other" rather than crashing', () => {
      const { updates } = plan([{ _id: '1', cafeId: 'c', name: 'Quiche' }]);
      expect(updates[0]).toMatchObject({ from: 'other', to: 'food' });
    });
  });

  describe('frozen legacy classifier', () => {
    // These pin the old behaviour. If they ever change, the provenance test
    // silently stops distinguishing human choices from auto-assigned ones.
    it('reproduces the old misfiling exactly', () => {
      expect(legacyInferItemCategory('House Coffee (Blend)')).toBe('retail');
      expect(legacyInferItemCategory('Toastie')).toBe('other');
      expect(legacyInferItemCategory('Lemonade')).toBe('food');
      expect(legacyInferItemCategory('Flat White (Blend)')).toBe('coffee');
    });
  });

  describe('batch behaviour', () => {
    it('separates repairs from preserved choices across a mixed menu', () => {
      const { updates, keptManual } = plan([
        item('House Coffee (Blend)', 'retail'),   // repair
        item('Toastie', 'other'),                 // repair
        item('Flat White (Blend)', 'coffee'),     // already right
        item('Lemonade', 'water'),                // human set it, keep
      ]);
      expect(updates.map((u) => u.name).sort()).toEqual(['House Coffee (Blend)', 'Toastie']);
      expect(keptManual.map((k) => k.name)).toEqual(['Lemonade']);
    });
  });
});
