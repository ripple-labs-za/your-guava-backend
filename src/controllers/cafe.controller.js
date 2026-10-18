const Transaction = require('../models/Transaction.model');
const Upload = require('../models/Upload.model');
const Cafe = require('../models/Cafe.model');
const User = require('../models/User.model');
const { invalidatePlanningForecasts } = require('../services/forecast.service');
const { normalizeTradingHours, defaultTradingHours, tradingHoursInputError, hasSavedTradingHours } = require('../utils/tradingHours');
const { clearApiCache } = require('../middleware/cache.middleware');
const { safeTimezone, isSupportedTimezone } = require('../utils/timezone');
const { activeCafeId } = require('../utils/tenancy');
const { pickColumnMapping } = require('../services/parser.service');

const FORECAST_INPUT_PREFIXES = ['location.lat', 'location.lng', 'location.city', 'tradingHours', 'timezone'];

const timezoneLocked = async (cafeId) => Boolean(
  await Transaction.exists({ cafeId }) || await Upload.exists({ cafeId, status: 'parsing' })
);

const affectsForecastInputs = (setUpdates = {}, unsetUpdates = {}) =>
  [...Object.keys(setUpdates), ...Object.keys(unsetUpdates)].some((key) =>
    FORECAST_INPUT_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))
  );

const LOCATION_TEXT_FIELDS = [
  'address',
  'addressLine2',
  'suburb',
  'city',
  'postalCode',
  'province',
  'country',
];

const parseCoordinate = (value, min, max, label) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${label} must be between ${min} and ${max}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
};

const withoutTokens = (integration = {}) => {
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...safe } = integration || {};
  return safe;
};

const cafeDto = (value) => {
  const cafe = value?.toObject ? value.toObject() : { ...(value || {}) };

  if (cafe.yocoTokens) cafe.yocoTokens = withoutTokens(cafe.yocoTokens);
  if (cafe.accountingIntegrations) {
    cafe.accountingIntegrations = Object.fromEntries(
      Object.entries(cafe.accountingIntegrations).map(([provider, integration]) => [
        provider,
        withoutTokens(integration),
      ])
    );
  }

  return cafe;
};

// GET /api/cafe/list — all cafes the user can access
const listCafes = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const includeArchived = user.role === 'owner' && req.query.includeArchived === 'true';
    let cafes;
    if (user.role === 'owner') {
      // Owners see every active cafe in their org; Team asks for archived ones too so it can offer Restore.
      cafes = await Cafe.find({ orgId: user.orgId, ...(includeArchived ? {} : { archivedAt: null }) })
        .select('name location archivedAt')
        .lean();
    } else {
      cafes = await Cafe.find({ _id: { $in: user.cafeIds }, orgId: user.orgId, archivedAt: null })
        .select('name location')
        .lean();
    }

    return res.status(200).json({ success: true, cafes });
  } catch (error) {
    next(error);
  }
};

const getMe = async (req, res, next) => {
  try {
    const cafe = await Cafe.findOne({
      _id: activeCafeId(req),
      orgId: req.user.orgId,
    }).lean();
    if (!cafe) {
      return res.status(404).json({ success: false, message: 'Cafe not found' });
    }
    const tradingHoursSaved = hasSavedTradingHours(cafe);
    if (!tradingHoursSaved) {
      cafe.tradingHours = defaultTradingHours();
    }
    const timezoneEditable = !(await timezoneLocked(cafe._id));
    return res.status(200).json({ success: true, cafe: { ...cafeDto(cafe), timezoneEditable, tradingHoursSaved } });
  } catch (error) {
    next(error);
  }
};

const updateMe = async (req, res, next) => {
  try {
    const { name, location, tradingHours, timezone } = req.body;

    const setUpdates = {};
    const unsetUpdates = {};
    // identity-18: nothing is coerced; a bad body is refused before any write, so the forecasts stay as they were.
    if (name !== undefined) {
      const cleanName = typeof name === 'string' ? name.trim() : '';
      if (cleanName.length < 2 || cleanName.length > 120) {
        return res.status(400).json({ success: false, message: 'Cafe name must be between 2 and 120 characters' });
      }
      setUpdates.name = cleanName;
    }
    if (location !== undefined) {
      if (!location || typeof location !== 'object' || Array.isArray(location)) {
        return res.status(400).json({ success: false, message: 'location must be an object' });
      }

      for (const field of LOCATION_TEXT_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(location, field)) continue;
        const value = String(location[field] ?? '').trim();
        if (value) setUpdates[`location.${field}`] = value;
        else unsetUpdates[`location.${field}`] = 1;
      }

      const hasLat = Object.prototype.hasOwnProperty.call(location, 'lat');
      const hasLng = Object.prototype.hasOwnProperty.call(location, 'lng');
      if (hasLat !== hasLng) {
        return res.status(400).json({
          success: false,
          message: 'Latitude and longitude must be provided together',
        });
      }
      if (hasLat && hasLng) {
        const clearCoordinates =
          (location.lat === '' || location.lat == null) &&
          (location.lng === '' || location.lng == null);
        if (clearCoordinates) {
          unsetUpdates['location.lat'] = 1;
          unsetUpdates['location.lng'] = 1;
        } else {
          setUpdates['location.lat'] = parseCoordinate(location.lat, -90, 90, 'Latitude');
          setUpdates['location.lng'] = parseCoordinate(location.lng, -180, 180, 'Longitude');
        }
      }
    }
    if (tradingHours !== undefined) {
      const hoursError = tradingHoursInputError(tradingHours);
      if (hoursError) return res.status(400).json({ success: false, message: hoursError });
      setUpdates.tradingHours = normalizeTradingHours(tradingHours);
    }

    if (timezone !== undefined) {
      if (!isSupportedTimezone(timezone)) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_TIMEZONE',
          message: 'Choose a timezone from the list, such as Africa/Johannesburg.',
        });
      }
      const current = await Cafe.findOne({ _id: activeCafeId(req), orgId: req.user.orgId }).select('timezone').lean();
      if (!current) return res.status(404).json({ success: false, message: 'Cafe not found' });
      if (safeTimezone(current.timezone) !== timezone) {
        // D-024: imported sales were read in the current zone; changing it would move them between days.
        if (await timezoneLocked(current._id)) {
          return res.status(409).json({
            success: false,
            code: 'TIMEZONE_LOCKED',
            message: 'The timezone can only be changed before the first sales are imported, because imported sales keep the times they were read with. Contact support to change it now.',
          });
        }
        // Node and Mongo can ship different timezone databases. Probe the same
        // expression analytics uses before saving a zone Mongo cannot read.
        try {
          await Cafe.aggregate([
            { $match: { _id: current._id } },
            { $project: { day: { $dateToString: { date: new Date(), timezone, format: '%Y-%m-%d' } } } },
          ]);
        } catch (error) {
          if (error.code !== 40485) throw error;
          return res.status(400).json({
            success: false, code: 'INVALID_TIMEZONE',
            message: 'This timezone is not available yet. Choose another timezone or contact support.',
          });
        }
        setUpdates.timezone = timezone;
      }
    }

    const update = {};
    if (Object.keys(setUpdates).length > 0) update.$set = setUpdates;
    if (Object.keys(unsetUpdates).length > 0) update.$unset = unsetUpdates;
    if (Object.keys(update).length === 0) {
      if (timezone !== undefined) {
        const unchanged = await Cafe.findOne({ _id: activeCafeId(req), orgId: req.user.orgId }).lean();
        return res.status(200).json({ success: true, cafe: cafeDto(unchanged) });
      }
      return res.status(400).json({ success: false, message: 'No supported cafe fields were provided' });
    }

    const cafe = await Cafe.findOneAndUpdate(
      { _id: activeCafeId(req), orgId: req.user.orgId },
      update,
      { new: true, runValidators: true }
    );

    if (!cafe) {
      return res.status(404).json({ success: false, message: 'Cafe not found' });
    }

    // Location and trading hours are forecast inputs: coordinates drive the
    // weather signal, trading hours decide whether a day is open at all.
    // Stored forecasts are computed from them, so leaving them in place would
    // keep serving predictions built from the old settings indefinitely.
    if (affectsForecastInputs(setUpdates, unsetUpdates)) {
      await invalidatePlanningForecasts(cafe._id, { timezone: cafe.timezone });
    }
    clearApiCache({ cafeId: cafe._id });

    return res.status(200).json({ success: true, cafe: cafeDto(cafe) });
  } catch (error) {
    next(error);
  }
};

const savedMappingDto = (saved) => (saved ? {
  mapping: pickColumnMapping(saved),
  itemsMode: saved.itemsMode || 'packed',
  sourceHeaders: Array.isArray(saved.sourceHeaders) ? saved.sourceHeaders : [],
  savedAt: saved.savedAt || null,
  sourceUploadId: saved.sourceUploadId || null,
  sourceFileName: saved.sourceFileName || null,
} : null);

// GET /api/cafe/me/column-mapping — how non-Yoco files of this cafe are read, and where that came from (BE-03-T05).
const getSavedMapping = async (req, res, next) => {
  try {
    const cafe = await Cafe.findOne({ _id: activeCafeId(req), orgId: req.user.orgId }).select('savedColumnMapping').lean();
    if (!cafe) return res.status(404).json({ success: false, message: 'Cafe not found' });
    return res.status(200).json({ success: true, savedColumnMapping: savedMappingDto(cafe.savedColumnMapping) });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/cafe/me/column-mapping — the next non-Yoco upload opens the wizard (or the AI mapper) again.
const clearSavedMapping = async (req, res, next) => {
  try {
    const cafe = await Cafe.findOneAndUpdate(
      { _id: activeCafeId(req), orgId: req.user.orgId },
      { $unset: { savedColumnMapping: '' } },
      { new: true }
    );
    if (!cafe) return res.status(404).json({ success: false, message: 'Cafe not found' });
    return res.status(200).json({ success: true, savedColumnMapping: null });
  } catch (error) {
    next(error);
  }
};

module.exports = { cafeDto, listCafes, getMe, updateMe, getSavedMapping, clearSavedMapping };
