const mongoose = require('mongoose');
const Forecast = require('../../src/models/Forecast.model');
const { buildLearningFactor } = require('../../src/services/forecast/calibration');

describe('the Forecast schema stores what the forecast service computes (BE-11-T06)', () => {
  it('keeps every field of the learning factor', () => {
    const factor = buildLearningFactor(1.12, 30, { enabled: true });
    const doc = new Forecast({ cafeId: new mongoose.Types.ObjectId(), date: new Date(), factors: [factor] });
    expect(doc.toObject().factors[0]).toEqual(expect.objectContaining(factor));
  });

  it('keeps every field of an item calibration entry', () => {
    // The shape computeForecastCalibration returns for an item (services/forecast/calibration.js).
    const entry = { itemName: 'Flat White', multiplier: 1.05, sampleSize: 12, observedUnits: 140, shrink: 0.35, averageRatio: 1.08 };
    const doc = new Forecast({ cafeId: new mongoose.Types.ObjectId(), date: new Date(), calibration: { itemMultipliers: [entry] } });
    expect(doc.toObject().calibration.itemMultipliers[0]).toEqual(expect.objectContaining(entry));
  });
});
