const { inferItemCategory } = require('../../src/utils/itemCategory');

/**
 * The category drives the weather factor: on a cold day coffee gets +15% and
 * cold drinks -20%, while every other category gets no temperature response at
 * all. A misfiled item therefore silently loses its weather adjustment, so this
 * classifier is worth holding to a real menu rather than one cafe's wording.
 */
describe('inferItemCategory', () => {
  const expectCategory = (cases, expected) =>
    cases.forEach((name) =>
      it(`classifies "${name}" as ${expected}`, () =>
        expect(inferItemCategory(name)).toBe(expected))
    );

  describe('coffee and hot drinks', () => {
    expectCategory(
      [
        'Flat White (Blend)', 'Long White (Blend)', 'Cappuccino', 'Cortado (Blend)',
        'Americano', 'Espresso', 'Doppio', 'Ristretto', 'Macchiato', 'Piccolo',
        'Babyccino', 'House Coffee (Blend)', 'Filter Coffee', 'Coffee of the Day',
        'Drip Coffee', 'Batch Brew', 'Mocha', 'Hot Chocolate', 'Rooibos Latte',
        'Chai Latte', 'Matcha Latte (Hot)', 'Pour Over',
      ],
      'coffee'
    );
  });

  // Tea is a top-selling hot line in every South African cafe and moves with
  // cold weather exactly as coffee does, but the list had no term for it: 'Pot
  // of Tea' and 'Green Tea' fell through to "other" (no temperature response at
  // all) and 'English Breakfast Tea' matched FOOD's 'breakfast'.
  describe('tea and other hot drinks', () => {
    expectCategory(
      [
        'Tea', 'Pot of Tea', 'Green Tea', 'Ceylon Tea', 'Herbal Tea',
        'English Breakfast Tea', 'Five Roses Tea', 'Rooibos Tea', 'Milo',
      ],
      'coffee'
    );

    // 'tea' is a substring of 'steamed', so the term has to match on a word
    // boundary the way cola/ice/shake do.
    it('does not read "tea" inside "steamed"', () => {
      expect(inferItemCategory('Steamed Milk')).not.toBe('coffee');
    });

    it('still reads iced tea as a cold drink', () => {
      expect(inferItemCategory('Iced Tea')).toBe('cold_drink');
      expect(inferItemCategory('Ice Tea Peach')).toBe('cold_drink');
    });
  });

  describe('cold drinks', () => {
    expectCategory(
      [
        'Iced Coffee', 'Iced Latte', 'Cold Brew', 'Iced Tea', 'Lemonade',
        'Fresh Orange Juice', 'Smoothie - Berry', 'Milkshake Vanilla',
        'Coke', 'Fanta Orange', 'Sprite', 'Frappe',
      ],
      'cold_drink'
    );

    // The bare 'sparkling' marker was tested before the cold-drink list, so
    // every sparkling soft drink on the menu was filed as bottled water --
    // which gets no temperature response, while cold drinks get -20% on a cold
    // day. These are the highest-margin lines in a SA cafe fridge.
    expectCategory(
      [
        'Appletiser Sparkling Apple 330ml', 'Grapetiser Sparkling Red',
        'Sparkling Lemonade', 'Sparkling Iced Tea',
      ],
      'cold_drink'
    );
  });

  describe('water', () => {
    // Real menus abbreviate: "Mountain Falls Sparkling 500ml" never says
    // "water" anywhere in the name, so the bare marker has to match.
    expectCategory(
      [
        'Still Water 500ml', 'Sparkling Water', 'Still 750ml',
        'Mountain Falls Sparkling 500ml', 'Valpre Still 500ml', 'Sparkling 750ml',
      ],
      'water'
    );
  });

  describe('food', () => {
    expectCategory(
      [
        'Blueberry Muffin', 'Butter Croissant', 'Brownie', 'Chocolate Cookie',
        'Carrot Cake', 'Chicken Sandwich', 'Chicken Wrap', 'Bacon & Egg Roll',
        'Toastie', 'Quiche', 'Scone', 'Salad Bowl', 'Rusks', 'Lemon Poppyseed',
        'Banana Bread', 'Bagel',
      ],
      'food'
    );
  });

  describe('retail merchandise', () => {
    // Retail needs an unambiguous marker. "Blend" alone is a drink suffix on
    // most menus, so it must not pull espresso drinks into merchandise.
    expectCategory(
      ['Beans 250g', 'House Blend 1kg', 'Espresso Blend 750g', 'Guava Mug', 'Tote Bag'],
      'retail'
    );

    // A bare 'beans' marker sold the kitchen down the river: retail is checked
    // first, so anything with beans in it became merchandise.
    it('does not read a plate of beans as a bag of coffee beans', () => {
      expect(inferItemCategory('Beans on Toast')).toBe('food');
      expect(inferItemCategory('Baked Beans')).toBe('food');
    });

    it('still files whole beans sold by weight as retail', () => {
      expect(inferItemCategory('Coffee Beans 250g')).toBe('retail');
      expect(inferItemCategory('House Coffee Beans 1kg')).toBe('retail');
    });
  });

  describe('edge cases', () => {
    it('does not treat a bare "(Blend)" suffix as merchandise', () => {
      expect(inferItemCategory('Flat White (Blend)')).toBe('coffee');
    });

    it('separates lemonade from lemon bakery items', () => {
      expect(inferItemCategory('Lemonade')).toBe('cold_drink');
      expect(inferItemCategory('Lemon Poppyseed')).toBe('food');
    });

    it('treats iced coffee as a cold drink, not a hot one', () => {
      expect(inferItemCategory('Iced Coffee')).toBe('cold_drink');
    });

    it('does not mistake watermelon for bottled water', () => {
      expect(inferItemCategory('Watermelon Cooler')).toBe('cold_drink');
    });

    it('falls back to other for genuinely unknown items', () => {
      expect(inferItemCategory('Mystery Item')).toBe('other');
      expect(inferItemCategory('')).toBe('other');
      expect(inferItemCategory()).toBe('other');
    });
  });

  // Regression cover for the word-boundary branch. It shipped with its two
  // backslash-b escapes collapsed into literal U+0008 BACKSPACE bytes, so
  // WORD_MATCH could only ever match a backspace and every cola/ice/shake item
  // fell through to the next list or to "other" -- the one category with no
  // temperature response at all. The suite stayed green because every cold
  // drink above also matches a plain substring ('iced', 'milkshake', 'coke'),
  // and because editors, diffs and JSON.stringify all render U+0008 as an
  // innocent-looking backslash-b. tests/unit/sourceHygiene.test.js guards the
  // bytes; this block guards the behaviour.
  describe('word-boundary terms', () => {
    expectCategory(
      [
        'Coca Cola', 'Coca-Cola', 'Cola', 'Cola Tonic', 'Ice Cream', 'Vanilla Ice Cream',
        'Ice Tea', 'Ice Tea Peach', 'Milk Shake', 'Banana Shake', 'Strawberry Milk Shake',
      ],
      'cold_drink'
    );

    // The boundary earns its keep on the negatives: a bare substring test for
    // cola/ice/shake would match every name below.
    it('does not read "cola" inside "chocolate"', () => {
      expect(inferItemCategory('Chocolate Brownie')).toBe('food');
    });

    it('does not read "ice" inside "rice" or "liquorice"', () => {
      expect(inferItemCategory('Rice Cake')).toBe('food');
      expect(inferItemCategory('Liquorice')).not.toBe('cold_drink');
    });

    it('does not read "shake" into "shakshuka"', () => {
      expect(inferItemCategory('Shakshuka')).not.toBe('cold_drink');
      expect(inferItemCategory('Shakshuka Bowl')).toBe('food');
    });
  });

  // Every list matched substrings: "Spiced" and "Sliced" contain "iced", so a chai latte became a cold drink and its
  // cold-day adjustment flipped from +15% to -20%; "Mug Cappuccino" was merchandise because retail is tested first.
  describe('names that contain a term but are not it', () => {
    expectCategory(['Spiced Chai Latte', 'Large Mug Rooibos', 'Mug Cappuccino'], 'coffee');
    expectCategory(['Sliced Banana Bread', 'Diced Chicken Salad', 'Cheesecake'], 'food');
    expectCategory(['Travel Mug', 'Guava Keep Cup Mug'], 'retail');
  });

  // Word-start matching no longer finds a term at the end of a compound, so the common compounds are listed whole.
  describe('compound names listed whole', () => {
    expectCategory(['Teacake', 'Fishcake', 'Flatbread', 'Cheeseburger', 'Hamburger'], 'food');
    expectCategory(['Coldbrew'], 'cold_drink');
  });
});
