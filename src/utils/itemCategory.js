/**
 * Infers a menu item's category from its name.
 *
 * This matters more than it looks: the category selects the weather factor. On
 * a cold day coffee is adjusted +15% and cold drinks -20%, while every other
 * category gets no temperature response. An item that falls through to "other"
 * therefore loses its weather signal silently.
 *
 * Order is deliberate. Merchandise is checked first but only on unambiguous
 * markers -- a bare "(Blend)" suffix is drink wording on most South African
 * menus, so it must not pull espresso drinks into retail. Cold drinks are
 * checked before hot ones so "Iced Coffee" and "Cold Brew" are not read as
 * coffee, and before food so "Lemonade" is not read as a lemon bake. Water is
 * split in two around them: a name that says "water" wins outright, while the
 * bare "sparkling"/"still" bottle markers are only consulted after the cold
 * drinks they would otherwise swallow. A bare "mug" is weak merchandise and is
 * tested last: "Mug Cappuccino" is a coffee served in a mug.
 *
 * A user can override the category in Menu Items, and re-ingesting never
 * overwrites a value they set -- see menuItems.service.
 */

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A term must start a word: "iced" matches "Iced Latte" but not "Spiced Chai" (BE-03-T09). The end stays open so
// plurals ("muffins") and suffixed words ("toastie") still match; compounds that hide a term at the end are listed
// whole ("cheesecake").
const startsAWord = (terms) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${terms.map(escapeRegExp).join('|')})`, 'u');

// Some terms are substrings of unrelated words -- "chocolate" contains "cola" --
// so they are matched on a word boundary rather than anywhere in the name.
const WORD_MATCH = /\b(cola|ice|shake)\b/;
const matchesWord = (haystack) => WORD_MATCH.test(haystack);

// Hot-drink terms that are also substrings of unrelated words: "steamed"
// contains "tea". Same treatment, but they resolve to coffee, not cold drink.
const HOT_WORD_MATCH = /\b(tea|milo|horlicks)\b/;
const matchesHotWord = (haystack) => HOT_WORD_MATCH.test(haystack);

// Packaged goods: a weight marker or non-consumable merchandise. Whole beans
// are covered by the weight markers -- a bare "beans" marker made "Beans on
// Toast" and "Baked Beans" merchandise, because retail is tested first.
const RETAIL = [
  '250g', '500g', '750g', '1kg', 'tote', 'merch',
  't-shirt', 'tshirt', 'gift card', 'voucher', 'keep cup', 'reusable cup',
];
// Merchandise only when nothing else in the name is a menu item.
const WEAK_RETAIL = ['mug'];

// Named water: the word is in the name, so nothing else can be meant.
const WATER_NAMED = ['still water', 'sparkling water', 'mineral water', 'soda water', 'water'];

// Bottled water is often named without the word "water" at all -- "Mountain
// Falls Sparkling 500ml", "Valpre Still 500ml" -- so the bare brand markers
// have to match, as the previous classifier's did. They are weak, though:
// tested ahead of the cold drinks they used to swallow every sparkling soft
// drink on the menu ("Appletiser Sparkling Apple 330ml"), which costs those
// lines the -20% cold-day adjustment because water has no weather response.
const WATER_BARE = ['sparkling', 'still'];

const COLD_DRINK = [
  'iced', 'cold brew', 'frappe', 'frappé', 'lemonade', 'juice', 'smoothie',
  'milkshake', 'soda', 'coke', 'fanta', 'sprite', 'slush',
  'cooler', 'kombucha', 'ginger beer', 'appletiser', 'grapetiser', 'tonic', 'coldbrew',
];

const COFFEE = [
  'coffee', 'espresso', 'latte', 'cappuccino', 'cortado', 'americano', 'macchiato',
  'piccolo', 'doppio', 'ristretto', 'babyccino', 'flat white', 'long white',
  'mocha', 'hot choc', 'hot chocolate', 'pour over', 'filter', 'drip', 'brew',
  'chai', 'matcha', 'rooibos', 'red espresso', 'black coffee',
];

const FOOD = [
  'muffin', 'croissant', 'brownie', 'cookie', 'cake', 'sandwich', 'wrap', 'roll',
  'toastie', 'toast', 'quiche', 'scone', 'salad', 'rusks', 'bagel', 'pie', 'tart',
  'bun', 'panini', 'burger', 'omelette', 'breakfast', 'granola', 'yoghurt',
  'crunch', 'lemon', 'banana', 'simple square', 'poppyseed', 'bread', 'waffle',
  'pancake', 'bowl', 'baked beans', 'cheesecake', 'cupcake', 'shortbread', 'gingerbread',
  'teacake', 'shortcake', 'fishcake', 'flatbread', 'cornbread', 'cheeseburger', 'hamburger',
];

const RETAIL_RE = startsAWord(RETAIL);
const WATER_NAMED_RE = startsAWord(WATER_NAMED);
const COLD_DRINK_RE = startsAWord(COLD_DRINK);
const WATER_BARE_RE = startsAWord(WATER_BARE);
const COFFEE_RE = startsAWord(COFFEE);
const FOOD_RE = startsAWord(FOOD);
const WEAK_RETAIL_RE = startsAWord(WEAK_RETAIL);

const inferItemCategory = (name = '') => {
  const n = String(name || '').toLowerCase();
  if (!n.trim()) return 'other';

  if (RETAIL_RE.test(n)) return 'retail';
  // "Watermelon" contains "water" but is a drink, not bottled water.
  if (!n.includes('watermelon') && WATER_NAMED_RE.test(n)) return 'water';
  if (COLD_DRINK_RE.test(n) || matchesWord(n)) return 'cold_drink';
  if (WATER_BARE_RE.test(n)) return 'water';
  if (COFFEE_RE.test(n) || matchesHotWord(n)) return 'coffee';
  if (FOOD_RE.test(n)) return 'food';
  if (WEAK_RETAIL_RE.test(n)) return 'retail';
  return 'other';
};

// The categories a menu item may have: the Item schema's enum, the Menu Items edit check and the AI
// review's validation all read this list.
const ITEM_CATEGORIES = Object.freeze(['coffee', 'food', 'cold_drink', 'water', 'retail', 'other']);
const isItemCategory = (value) => ITEM_CATEGORIES.includes(value);

module.exports = { inferItemCategory, ITEM_CATEGORIES, isItemCategory };
