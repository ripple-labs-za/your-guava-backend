const Event = require('../models/Event.model');
const { invalidatePlanningForecasts } = require('../services/forecast.service');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const { eventDateKey, isCalendarDateKey, loadEventsByDateKey } = require('../services/forecast/history');
const { getForecastSettings, eventImpactPct, factorUnlocked } = require('../services/forecastFactors.service');
const {
  DATE_ONLY_RE, TIME_OF_DAY_RE, safeTimezone, getCafeTimezone, zonedDayStart, cafeLocalToday, parseDateOnly,
  formatDateOnly,
} = require('../utils/timezone');
const { activeCafeId } = require('../utils/tenancy');

// The throwing, message-bearing wrapper events need over the shared parseDateOnly.
const requireEventDate = (value, field = 'date') => {
  if (!DATE_ONLY_RE.test(String(value || ''))) {
    const error = new Error(`${field} must use YYYY-MM-DD`);
    error.statusCode = 400;
    throw error;
  }
  const date = parseDateOnly(value);
  if (!date) {
    const error = new Error(`${field} must be a valid calendar date`);
    error.statusCode = 400;
    throw error;
  }
  return date;
};

const invalidatePlanningForecastsFrom = async (cafeId, date) => {
  const timezone = await getCafeTimezone(cafeId);
  const today = zonedDayStart(new Date(), timezone);
  const start = zonedDayStart(formatDateOnly(dateOnly(date)), timezone);
  if (start < today) start.setTime(today.getTime());
  await invalidatePlanningForecasts(cafeId, { from: start, timezone });
};

const parseImpactPct = (impactPct) => {
  if (impactPct === undefined || impactPct === null || impactPct === '') return undefined;
  const parsed = Number(impactPct);
  if (!Number.isFinite(parsed) || parsed < -90 || parsed > 200) {
    const error = new Error('impactPct must be between -90 and 200');
    error.statusCode = 400;
    throw error;
  }
  return Math.round(parsed * 10) / 10;
};

const parseRecurring = (value) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    const error = new Error('recurring must be true or false');
    error.statusCode = 400;
    throw error;
  }
  return value;
};

const eventRange = (from, to, inclusive = true) => {
  const keys = {};
  const dates = {};
  if (from) { keys.$gte = formatDateOnly(from); dates.$gte = from; }
  if (to) { keys[inclusive ? '$lte' : '$lt'] = formatDateOnly(to); dates[inclusive ? '$lte' : '$lt'] = to; }
  return { $or: [{ dateKey: keys }, { dateKey: { $exists: false }, date: dates }] };
};

const ALLOWED_EVENT_TYPES = ['event', 'closure', 'partial_closure'];

const parseEventType = (type) => {
  if (type === undefined || type === null || type === '') return undefined;
  if (!ALLOWED_EVENT_TYPES.includes(type)) {
    const error = new Error(`type must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return type;
};

const parseClosureWindow = (type, closureWindow) => {
  if (type !== 'partial_closure') return undefined;
  if (!closureWindow || typeof closureWindow !== 'object') {
    const error = new Error('partial_closure requires closureWindow with startTime and endTime');
    error.statusCode = 400;
    throw error;
  }
  const { startTime, endTime } = closureWindow;
  if (!TIME_OF_DAY_RE.test(startTime || '') || !TIME_OF_DAY_RE.test(endTime || '')) {
    const error = new Error('closureWindow.startTime and closureWindow.endTime must be HH:mm');
    error.statusCode = 400;
    throw error;
  }
  if (endTime <= startTime) {
    const error = new Error('closureWindow.endTime must be after startTime');
    error.statusCode = 400;
    throw error;
  }
  return { startTime, endTime };
};

const dateOnly = (value) => {
  if (typeof value === 'string') return requireEventDate(value);
  const source = new Date(value);
  return new Date(Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth(),
    source.getUTCDate()
  ));
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const pctChange = (actual, baseline) => {
  if (!Number.isFinite(actual) || !Number.isFinite(baseline) || baseline <= 0) return null;
  return Number((((actual - baseline) / baseline) * 100).toFixed(1));
};

const getDailySales = async (cafeId, start, end, timezone) => Transaction.aggregate([
  {
    $match: {
      cafeId,
      status: 'approved',
      date: { $gte: start, $lt: end },
    },
  },
  {
    $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone } },
      revenue: { $sum: '$total' },
      transactions: { $sum: 1 },
    },
  },
  { $sort: { _id: 1 } },
]);

const eventEffects = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const cafe = await Cafe.findById(cafeId).lean();
    if (!cafe) return res.status(404).json({ success: false, message: 'Cafe not found' });

    const timezone = safeTimezone(cafe.timezone);
    const today = cafeLocalToday(timezone);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 100));
    const baselineWeeks = Math.max(3, Math.min(Number(req.query.baselineWeeks) || 8, 16));
    const latestTo = addDays(today, -1);
    const requestedTo = req.query.to ? requireEventDate(req.query.to, 'to') : latestTo;
    const to = requestedTo > latestTo ? latestTo : requestedTo;
    const from = req.query.from
      ? requireEventDate(req.query.from, 'from')
      : addDays(to, -365);
    if (from > requestedTo) {
      return res.status(400).json({ success: false, message: 'from must be on or before to' });
    }
    const org = await Organization.findById(req.user.orgId).select('plan').lean();
    const plan = org?.plan || 'starter';
    const settings = getForecastSettings(cafe, plan);
    const expectedApplied = settings.events?.enabled === true;
    const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
    const expectedNote = expectedApplied ? null : factorUnlocked(plan, 'events')
      ? 'The events factor is switched off in Factors.'
      : `Local events are not applied to forecasts on the ${planLabel} plan.`;

    const events = await Event.find({
      cafeId,
      ...eventRange(from, to),
      type: { $nin: ['closure', 'partial_closure'] },
    })
      .sort({ date: -1 })
      .limit(limit)
      .lean();

    if (events.length === 0) {
      return res.status(200).json({
        success: true,
        effects: [],
        summary: {
          eventsAnalyzed: 0,
          avgRevenueImpactPct: null,
          aboveExpected: 0,
          belowExpected: 0,
          insufficientData: 0,
        },
      });
    }

    const eventKeys = events.map((event) => eventDateKey(event, timezone)).sort();
    const earliestBaselineDate = addDays(requireEventDate(eventKeys[0]), -baselineWeeks * 7);
    const eventEndDate = addDays(requireEventDate(eventKeys[eventKeys.length - 1]), 1);
    const earliestBaselineStart = zonedDayStart(formatDateOnly(earliestBaselineDate), timezone);
    const eventEnd = zonedDayStart(formatDateOnly(eventEndDate), timezone);

    const [dailySales, eventDates] = await Promise.all([
      getDailySales(cafe._id, earliestBaselineStart, eventEnd, timezone),
      loadEventsByDateKey(cafeId, formatDateOnly(earliestBaselineDate), formatDateOnly(eventEndDate), timezone),
    ]);

    const salesByDate = new Map(dailySales.map((row) => [row._id, row]));
    const eventDateKeys = new Set(eventDates.keys());

    const effects = events.map((event) => {
      const key = eventDateKey(event, timezone);
      const eventDate = requireEventDate(key);
      const eventSales = salesByDate.get(key) || { revenue: 0, transactions: 0 };
      const baselineStart = addDays(eventDate, -baselineWeeks * 7);
      const eventWeekday = eventDate.getUTCDay();

      const comparableDays = dailySales.filter((row) => {
        const rowDate = dateOnly(row._id);
        const rowKey = row._id;
        return rowDate >= baselineStart &&
          rowDate < eventDate &&
          rowDate.getUTCDay() === eventWeekday &&
          !eventDateKeys.has(rowKey) &&
          row.revenue > 0;
      });

      const baselineDayCount = comparableDays.length;
      const baselineRevenue = baselineDayCount > 0
        ? comparableDays.reduce((sum, row) => sum + (row.revenue || 0), 0) / baselineDayCount
        : 0;
      const baselineTransactions = baselineDayCount > 0
        ? comparableDays.reduce((sum, row) => sum + (row.transactions || 0), 0) / baselineDayCount
        : 0;
      const actualRevenue = Number((eventSales.revenue || 0).toFixed(2));
      const actualTransactions = eventSales.transactions || 0;
      const measurable = actualTransactions > 0 && baselineRevenue > 0;
      const revenueImpactPct = measurable ? pctChange(actualRevenue, baselineRevenue) : null;
      const transactionImpactPct = measurable ? pctChange(actualTransactions, baselineTransactions) : null;
      const expectedImpactPct = expectedApplied ? eventImpactPct(event, settings.events) : 0;
      const vsExpectedPct = revenueImpactPct == null
        ? null
        : Number((revenueImpactPct - expectedImpactPct).toFixed(1));

      return {
        eventId: event._id,
        name: event.name,
        date: event.date,
        dateKey: key,
        impact: event.impact,
        expectedImpactPct,
        expectedApplied,
        expectedNote,
        actualRevenue,
        actualTransactions,
        baselineRevenue: Number(baselineRevenue.toFixed(2)),
        baselineTransactions: Number(baselineTransactions.toFixed(1)),
        baselineDayCount,
        revenueImpactPct,
        transactionImpactPct,
        vsExpectedPct,
        confidence: actualTransactions === 0 || baselineDayCount === 0
          ? 'none'
          : baselineDayCount < 4
            ? 'low'
            : baselineDayCount < 7
              ? 'medium'
              : 'high',
      };
    });

    const measured = effects.filter((effect) => effect.revenueImpactPct != null);
    const avgRevenueImpactPct = measured.length > 0
      ? Number((measured.reduce((sum, effect) => sum + effect.revenueImpactPct, 0) / measured.length).toFixed(1))
      : null;

    return res.status(200).json({
      success: true,
      effects,
      summary: {
        eventsAnalyzed: effects.length,
        avgRevenueImpactPct,
        aboveExpected: measured.filter((effect) => effect.vsExpectedPct > 0).length,
        belowExpected: measured.filter((effect) => effect.vsExpectedPct < 0).length,
        insufficientData: effects.filter((effect) => effect.confidence === 'none').length,
      },
    });
  } catch (error) {
    next(error);
  }
};

const list = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { from, to } = req.query;

    const filter = { cafeId };
    const timezone = await getCafeTimezone(cafeId);
    const today = cafeLocalToday(timezone);

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = requireEventDate(from, 'from');
      if (to) filter.date.$lte = requireEventDate(to, 'to');
      if (filter.date.$gte && filter.date.$lte && filter.date.$gte > filter.date.$lte) {
        return res.status(400).json({ success: false, message: 'from must be on or before to' });
      }
    } else {
      // Annual events must remain visible and removable after their first date.
      filter.date = { $gte: today };
    }

    Object.assign(filter, eventRange(filter.date.$gte, filter.date.$lte));
    delete filter.date;
    if (!from && !to) filter.$or.push({ recurring: true });
    const events = await Event.find(filter).sort({ dateKey: 1, date: 1 }).lean();
    const todayKey = formatDateOnly(today);
    for (const event of events) {
      const key = eventDateKey(event, timezone);
      if (!event.recurring || !key) continue;
      const firstYear = Math.max(Number(todayKey.slice(0, 4)), Number(key.slice(0, 4)));
      // Leap-day anniversaries can be eight years apart across a century.
      for (let year = firstYear; year <= firstYear + 8; year += 1) {
        const nextKey = `${year}-${key.slice(5)}`;
        if (nextKey >= todayKey && isCalendarDateKey(nextKey)) {
          event.nextDateKey = nextKey;
          break;
        }
      }
    }
    return res.status(200).json({ success: true, events });
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { name, date, impact, impactPct, notes, recurring, type, closureWindow } = req.body;

    if (!name || !date) {
      return res.status(400).json({ success: false, message: 'name and date are required' });
    }

    const parsedDate = requireEventDate(date);
    const parsedType = parseEventType(type) || 'event';
    const parsedClosure = parseClosureWindow(parsedType, closureWindow);

    const event = await Event.create({
      cafeId,
      name: String(name).trim(),
      date: parsedDate,
      dateKey: String(date),
      type: parsedType,
      closureWindow: parsedClosure,
      impact: impact || 'medium',
      impactPct: parseImpactPct(impactPct),
      notes,
      recurring: parseRecurring(recurring) ?? false,
    });
    await invalidatePlanningForecastsFrom(cafeId, event.date);

    return res.status(201).json({ success: true, event });
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { id } = req.params;
    const { name, date, impact, impactPct, notes, recurring, type, closureWindow } = req.body;

    const existing = await Event.findOne({ _id: id, cafeId }).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const update = {};
    const unset = {};
    if (name !== undefined) update.name = String(name).trim();
    if (date !== undefined) { update.date = requireEventDate(date); update.dateKey = String(date); }
    if (impact !== undefined) update.impact = impact;
    if (notes !== undefined) update.notes = notes;
    if (recurring !== undefined) update.recurring = parseRecurring(recurring);
    if (impactPct !== undefined) {
      const parsed = parseImpactPct(impactPct);
      if (parsed === undefined) unset.impactPct = 1;
      else update.impactPct = parsed;
    }

    if (type !== undefined) {
      const parsedType = parseEventType(type);
      update.type = parsedType;
      const effectiveType = parsedType || existing.type || 'event';
      if (effectiveType === 'partial_closure') {
        update.closureWindow = parseClosureWindow(effectiveType, closureWindow ?? existing.closureWindow);
      } else {
        unset.closureWindow = 1;
      }
    } else if (closureWindow !== undefined) {
      update.closureWindow = parseClosureWindow(existing.type || 'event', closureWindow);
    }

    const event = await Event.findOneAndUpdate(
      { _id: id, cafeId },
      { ...(Object.keys(update).length ? { $set: update } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true, runValidators: true }
    );
    const invalidateFrom = date !== undefined && update.date < existing.date
      ? update.date
      : existing.date;
    await invalidatePlanningForecastsFrom(cafeId, invalidateFrom);

    return res.status(200).json({ success: true, event });
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { id } = req.params;

    const event = await Event.findOneAndDelete({ _id: id, cafeId });

    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    await invalidatePlanningForecastsFrom(cafeId, event.date);

    return res.status(200).json({ success: true, message: 'Event deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { list, create, update, remove, eventEffects };
