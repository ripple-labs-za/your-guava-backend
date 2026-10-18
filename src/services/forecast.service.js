/**
 * Re-export barrel (BE-11-T04). Generation lives in ./forecast/generate.js,
 * calibration in calibration.js, the history window in history.js, suggested
 * stock in stock.js, actuals and menu-change refresh in actuals.js.
 */
const history = require('./forecast/history');
const calibration = require('./forecast/calibration');
const stock = require('./forecast/stock');
const generate = require('./forecast/generate');
const actuals = require('./forecast/actuals');

module.exports = {
  BACKTEST_BASIS_NOTE: actuals.BACKTEST_BASIS_NOTE,
  FORECAST_MODEL_VERSION: generate.FORECAST_MODEL_VERSION,
  MIN_HISTORY_WEEKS: history.MIN_HISTORY_WEEKS,
  MAX_STORED_FORECAST_ITEMS: generate.MAX_STORED_FORECAST_ITEMS,
  generateForecast: generate.generateForecast,
  generateForecastsForDates: generate.generateForecastsForDates,
  loadForecastContext: generate.loadForecastContext,
  loadForecastInputs: generate.loadForecastInputs,
  TRANSACTION_HISTORY_PROJECTION: generate.TRANSACTION_HISTORY_PROJECTION,
  invalidatePlanningForecasts: generate.invalidatePlanningForecasts,
  SIGNAL_RETRY_AFTER_MS: generate.SIGNAL_RETRY_AFTER_MS,
  generateWeekForecast: generate.generateWeekForecast,
  updateForecastActuals: actuals.updateForecastActuals,
  refreshForecastsAfterMenuChange: actuals.refreshForecastsAfterMenuChange,
  scheduleForecastRefreshAfterMenuChange: actuals.scheduleForecastRefreshAfterMenuChange,
  _test: {
    runCoalescedMenuRefresh: actuals.runCoalescedMenuRefresh,
    waitForMenuRefresh: actuals.waitForMenuRefresh,
    itemWape: actuals.itemWape,
    winsoriseBuckets: history.winsoriseBuckets,
    deFactorItemBuckets: history.deFactorItemBuckets,
    computeForecastCalibration: calibration.computeForecastCalibration,
    buildHistoryWeights: history.buildHistoryWeights,
    groupByWeekAndItem: history.groupByWeekAndItem,
    buildHistoricalPriceMap: history.buildHistoricalPriceMap,
    weightedAverage: history.weightedAverage,
    getTradingAvailability: generate.getTradingAvailability,
    describeClosedDay: generate.describeClosedDay,
    forecastConfidence: history.forecastConfidence,
    computeSuggestedStockFromPairs: stock.computeSuggestedStockFromPairs,
    requiredHistoryWeeks: history.requiredHistoryWeeks,
  },
};
