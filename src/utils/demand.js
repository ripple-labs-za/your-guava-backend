/**
 * "Ignore POS item" on Menu Items marks every line of that item menuItemStatus 'ignored': a delivery fee, a
 * service charge, a cash-out. It is still part of the sale (identity, takings) but it is not demand. Every reader
 * that measures what was sold must go through these helpers; a new reader that does not is the gap-1 defect again
 * (BE-03-T11).
 */
const IGNORED_LINE_STATUS = 'ignored';
const isDemandLine = (line) => Boolean(line?.name) && line.menuItemStatus !== IGNORED_LINE_STATUS;
const demandLines = (items) => (Array.isArray(items) ? items.filter(isDemandLine) : []);
// Lines written before menuItemStatus existed have no field; $ne keeps them, as isDemandLine does.
const DEMAND_LINE_MATCH = Object.freeze({ 'items.menuItemStatus': { $ne: IGNORED_LINE_STATUS } });
const demandItemsExpression = (input = '$items') => ({
  $filter: { input, as: 'line', cond: { $ne: ['$$line.menuItemStatus', IGNORED_LINE_STATUS] } },
});

module.exports = { IGNORED_LINE_STATUS, isDemandLine, demandLines, DEMAND_LINE_MATCH, demandItemsExpression };
