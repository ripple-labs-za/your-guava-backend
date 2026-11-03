const mongoose = require('mongoose');

// W-1: the weather for one cafe on one cafe-local day, kept for ever. `forecast` is the latest provider forecast taken
// while the day was still ahead (kept for accuracy analysis); `observed` is WeatherAPI history.json once the day has
// closed. History de-weathering prefers `observed`. Additive only: nothing ever deletes or rewrites another cafe's day.
const weatherSnapshotSchema = new mongoose.Schema({
  available: { type: Boolean, required: true },
  temp: { type: Number },
  maxTemp: { type: Number },
  condition: { type: String, maxlength: 200 },
  humidity: { type: Number },
  isRain: { type: Boolean },
  precipMm: { type: Number },
  chanceOfRain: { type: Number },
  fetchedAt: { type: Date, required: true },
}, { _id: false });

const weatherDaySchema = new mongoose.Schema({
  cafeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cafe', required: true },
  dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  source: { type: String, enum: ['weatherapi'], default: 'weatherapi' },
  // What the provider was asked for: "lat,lng", or the cafe's city when it has no coordinates (F-2).
  query: { type: String, maxlength: 200 },
  forecast: { type: weatherSnapshotSchema },
  observed: { type: weatherSnapshotSchema },
  // W-2: the provider will never give this day (its plan does not cover it), so it is never asked for again.
  observedUnavailable: {
    type: new mongoose.Schema({ reason: { type: String, maxlength: 200 }, at: { type: Date } }, { _id: false }),
  },
}, { timestamps: true });

weatherDaySchema.index({ cafeId: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('WeatherDay', weatherDaySchema);
