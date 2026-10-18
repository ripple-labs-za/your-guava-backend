const axios = require('axios');
const { zonedDateKey, zonedDateTimeToUtc } = require('./timezone');

// Simple in-memory cache for load shedding status (both reported areas)
const LOAD_SHEDDING_CACHE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Returns true if the given date is a payday:
 * - 25th of the month
 * - 1st of the month
 * - Last business day of the month
 */

const toDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const isSameLocalDate = (a, b = new Date()) => {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
};

const addHoliday = (holidays, date, name, observedOf) => {
  holidays.set(toDateKey(date), { date: toDateKey(date), name, observedOf });
};

const calculateEasterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
};

const SPECIAL_PUBLIC_HOLIDAYS = {
  // National election days and formally declared one-off public holidays.
  '2019-05-08': 'National and Provincial Elections',
  '2021-11-01': 'Local Government Elections',
  '2022-12-27': 'Special Public Holiday',
  '2024-05-29': 'National and Provincial Elections',
};

const publicHolidayOverrides = () => {
  const raw = process.env.PUBLIC_HOLIDAY_OVERRIDES || process.env.SA_PUBLIC_HOLIDAY_OVERRIDES || '';
  if (!raw.trim()) return {};

  return raw.split(',').reduce((overrides, item) => {
    const [date, ...nameParts] = item.trim().split(':');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      overrides[date] = nameParts.join(':').trim() || 'Special Public Holiday';
    }
    return overrides;
  }, {});
};

const getPublicHolidaysForYear = (year) => {
  const holidays = new Map();
  const fixedHolidays = [
    [1, 1, "New Year's Day"],
    [3, 21, 'Human Rights Day'],
    [4, 27, 'Freedom Day'],
    [5, 1, 'Workers Day'],
    [6, 16, 'Youth Day'],
    [8, 9, "National Women's Day"],
    [9, 24, 'Heritage Day'],
    [12, 16, 'Day of Reconciliation'],
    [12, 25, 'Christmas Day'],
    [12, 26, 'Day of Goodwill'],
  ];

  for (const [month, day, name] of fixedHolidays) {
    addHoliday(holidays, new Date(year, month - 1, day), name);
  }

  const easterSunday = calculateEasterSunday(year);
  addHoliday(holidays, addDays(easterSunday, -2), 'Good Friday');
  addHoliday(holidays, addDays(easterSunday, 1), 'Family Day');

  const baseHolidays = [...holidays.values()];
  for (const holiday of baseHolidays) {
    const holidayDate = new Date(holiday.date);
    if (holidayDate.getDay() === 0) {
      addHoliday(holidays, addDays(holidayDate, 1), `${holiday.name} observed`, holiday.name);
    }
  }

  const allSpecialHolidays = { ...SPECIAL_PUBLIC_HOLIDAYS, ...publicHolidayOverrides() };
  for (const [date, name] of Object.entries(allSpecialHolidays)) {
    if (date.startsWith(`${year}-`)) {
      addHoliday(holidays, new Date(date), name);
    }
  }

  return [...holidays.values()].sort((a, b) => a.date.localeCompare(b.date));
};

const getPublicHolidayInfo = (date) => {
  const d = new Date(date);
  const dateKey = toDateKey(d);
  return getPublicHolidaysForYear(d.getFullYear()).find((holiday) => holiday.date === dateKey) || null;
};

/**
 * Returns true if the given date is a South African public holiday.
 */
const isPublicHoliday = (date) => {
  return Boolean(getPublicHolidayInfo(date));
};

const parseLocalDateKey = (dateKey) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || '').trim());
  if (!match) return null;

  const [, yearValue, monthValue, dayValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
};

const normalizeSchoolTerm = (term) => {
  const startValue = Array.isArray(term) ? term[0] : term?.start;
  const endValue = Array.isArray(term) ? term[1] : term?.end;
  const start = parseLocalDateKey(startValue);
  const end = parseLocalDateKey(endValue);

  if (!start || !end || end < start) return null;
  return { start, end };
};

const normalizeSchoolCalendar = (year, calendar) => {
  const yearNumber = Number(year);
  const termsInput = Array.isArray(calendar) ? calendar : calendar?.terms;
  if (!Number.isInteger(yearNumber) || !Array.isArray(termsInput) || termsInput.length !== 4) {
    return null;
  }

  const terms = termsInput.map(normalizeSchoolTerm);
  if (
    terms.some((term) => !term) ||
    terms.some((term) => term.start.getFullYear() !== yearNumber || term.end.getFullYear() !== yearNumber)
  ) {
    return null;
  }
  terms.sort((a, b) => a.start - b.start);
  if (terms.some((term, index) => index > 0 && term.start <= terms[index - 1].end)) {
    return null;
  }

  const specialSchoolHolidaysInput = Array.isArray(calendar?.specialSchoolHolidays)
    ? calendar.specialSchoolHolidays
    : [];
  const specialSchoolHolidays = [...new Set(
    specialSchoolHolidaysInput
      .map((dateKey) => parseLocalDateKey(dateKey))
      .filter((date) => date && date.getFullYear() === yearNumber)
      .map(toDateKey)
  )].sort();

  return { terms, specialSchoolHolidays };
};

const buildSchoolCalendarMap = (calendars) => {
  return Object.entries(calendars).reduce((built, [year, calendar]) => {
    const normalized = normalizeSchoolCalendar(year, calendar);
    if (normalized) built[year] = normalized;
    return built;
  }, {});
};

// Source-backed South African public school calendars. Learner dates are used
// for demand signals; educator-only admin days are treated as school holidays.
const DEFAULT_SCHOOL_CALENDARS_BY_YEAR = buildSchoolCalendarMap({
  2025: {
    terms: [
      ['2025-01-15', '2025-03-28'],
      ['2025-04-08', '2025-06-27'],
      ['2025-07-22', '2025-10-03'],
      ['2025-10-13', '2025-12-10'],
    ],
    specialSchoolHolidays: ['2025-04-29', '2025-04-30', '2025-05-02'],
  },
  2026: {
    terms: [
      ['2026-01-14', '2026-03-27'],
      ['2026-04-08', '2026-06-26'],
      ['2026-07-21', '2026-09-23'],
      ['2026-10-06', '2026-12-09'],
    ],
    specialSchoolHolidays: ['2026-06-15'],
  },
  2027: {
    terms: [
      ['2027-01-13', '2027-03-19'],
      ['2027-04-06', '2027-06-25'],
      ['2027-07-20', '2027-09-22'],
      ['2027-10-05', '2027-12-08'],
    ],
    specialSchoolHolidays: ['2027-04-26'],
  },
});

let schoolCalendarOverrideCache = { raw: null, value: {} };

const parseSchoolCalendarOverrides = () => {
  const raw = (
    process.env.SCHOOL_CALENDAR_OVERRIDES ||
    process.env.SCHOOL_TERM_OVERRIDES ||
    process.env.SA_SCHOOL_TERM_OVERRIDES ||
    ''
  ).trim();

  if (schoolCalendarOverrideCache.raw === raw) {
    return schoolCalendarOverrideCache.value;
  }

  if (!raw) {
    schoolCalendarOverrideCache = { raw, value: {} };
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const value = buildSchoolCalendarMap(parsed && typeof parsed === 'object' ? parsed : {});
    schoolCalendarOverrideCache = { raw, value };
    return value;
  } catch (error) {
    schoolCalendarOverrideCache = { raw, value: {} };
    return {};
  }
};

const getSchoolCalendarDatesForYear = (year) => {
  const yearNumber = Number(year);
  if (!Number.isInteger(yearNumber)) return null;

  const overrides = parseSchoolCalendarOverrides();
  return overrides[yearNumber] || DEFAULT_SCHOOL_CALENDARS_BY_YEAR[yearNumber] || null;
};

const getSchoolCalendarForYear = (year) => {
  const calendar = getSchoolCalendarDatesForYear(year);
  if (!calendar) return null;

  return {
    terms: calendar.terms.map((term) => ({
      start: toDateKey(term.start),
      end: toDateKey(term.end),
    })),
    specialSchoolHolidays: [...calendar.specialSchoolHolidays],
  };
};

/**
 * Returns true if the given date falls outside learner school terms or is a
 * gazetted special school holiday.
 * Fails safe: when term dates for the date's year are unknown, returns false
 * (no signal) instead of treating every day as a school holiday.
 */
const isSchoolHoliday = (date) => {
  const d = new Date(date);
  // Strip time for date-only comparison
  const check = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const dateKey = toDateKey(check);
  const calendar = getSchoolCalendarDatesForYear(check.getFullYear());
  if (!calendar) {
    return false; // Unknown year: no school-holiday signal rather than a permanent one.
  }

  if (calendar.specialSchoolHolidays.includes(dateKey)) {
    return true;
  }

  for (const term of calendar.terms) {
    if (check >= term.start && check <= term.end) {
      return false; // In a learner school term.
    }
  }

  return true; // Outside all learner terms.
};

// Cape Town runs its own load shedding schedule; everywhere else follows Eskom national.
const loadSheddingAreaForCity = (city = '') =>
  /cape\s*town/i.test(String(city)) ? 'capetown' : 'eskom';

/**
 * Fetches the current EskomSePush load shedding stage for the cafe's area.
 * Cape Town cafes use the City of Cape Town stage; all other locations use
 * the Eskom national stage. Returns an explicit availability signal and
 * caches verified stages for 30 minutes.
 */
const LOAD_SHEDDING_SCHEDULE_DAYS = 7;
const LOAD_SHEDDING_WINDOW = { startHour: 6, endHour: 20 };
let loadSheddingCache = { status: null, fetchedAt: null };

const parseStage = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const stage = Number(value);
  return Number.isInteger(stage) && stage >= 0 && stage <= 8 ? stage : null;
};
const parseAreaStatus = (area) => ({
  stage: parseStage(area?.stage),
  nextStages: (Array.isArray(area?.next_stages) ? area.next_stages : [])
    .map((entry) => ({ stage: parseStage(entry?.stage), startsAt: new Date(entry?.stage_start_timestamp) }))
    .filter((entry) => entry.stage !== null && !Number.isNaN(entry.startsAt.getTime()))
    .sort((left, right) => left.startsAt - right.startsAt),
});

// One /status call serves every cafe: both areas, current stage and announced changes. Cached 30 minutes on success.
const fetchLoadSheddingStatus = async () => {
  const now = Date.now();
  if (loadSheddingCache.status && now - loadSheddingCache.fetchedAt < LOAD_SHEDDING_CACHE_MS) return loadSheddingCache.status;
  const response = await axios.get('https://developer.sepush.co.za/business/2.0/status', {
    headers: { Token: process.env.ESKOMSEPUSH_API_KEY },
    timeout: 5000,
  });
  const status = {
    capetown: parseAreaStatus(response.data?.status?.capetown),
    eskom: parseAreaStatus(response.data?.status?.eskom),
  };
  loadSheddingCache = { status, fetchedAt: now };
  return status;
};

const unknownStage = (unavailableReason, extra = {}) => ({ available: false, stage: null, unavailableReason, ...extra });

// Current stage for the cafe's area (unchanged contract).
const getLoadSheddingStage = async (city) => {
  if (!process.env.ESKOMSEPUSH_API_KEY) return unknownStage('Load-shedding service is not configured');
  try {
    const area = (await fetchLoadSheddingStatus())[loadSheddingAreaForCity(city)];
    return Number.isFinite(area?.stage)
      ? { available: true, stage: area.stage }
      : unknownStage('Load-shedding provider returned no stage for this area');
  } catch (error) {
    console.error('[signals] Load shedding API error:', error.message);
    return unknownStage('Load-shedding data is temporarily unavailable');
  }
};

// Highest stage in force during [from, to): the stage at `from`, raised by any announced change inside the window.
const stageDuring = (area, from, to) => {
  let stage = area.stage;
  for (const change of area.nextStages) if (change.startsAt <= from) stage = change.stage;
  let highest = stage;
  for (const change of area.nextStages) {
    if (change.startsAt > from && change.startsAt < to) highest = Math.max(highest, change.stage);
  }
  return highest;
};

const dayNumber = (dateKey) => Math.floor(Date.parse(`${dateKey}T00:00:00.000Z`) / 86400000);

const getLoadSheddingForDate = async (city, dateKey, timezone, now = new Date()) => {
  const offset = dayNumber(dateKey) - dayNumber(zonedDateKey(now, timezone));
  if (offset < 0) return unknownStage('Load-shedding history is not recorded for past dates');
  if (offset > LOAD_SHEDDING_SCHEDULE_DAYS) return unknownStage('EskomSePush publishes at most 7 days ahead');
  if (!process.env.ESKOMSEPUSH_API_KEY) return unknownStage('Load-shedding service is not configured');
  let area;
  try {
    area = (await fetchLoadSheddingStatus())[loadSheddingAreaForCity(city)];
  } catch (error) {
    console.error('[signals] Load shedding API error:', error.message);
    return unknownStage('Load-shedding data is temporarily unavailable');
  }
  if (!Number.isFinite(area?.stage)) return unknownStage('Load-shedding provider returned no stage for this area');
  const [year, month, day] = dateKey.split('-').map(Number);
  const windowStart = zonedDateTimeToUtc({ year, month, day, hour: LOAD_SHEDDING_WINDOW.startHour }, timezone);
  const windowEnd = zonedDateTimeToUtc({ year, month, day, hour: LOAD_SHEDDING_WINDOW.endHour }, timezone);
  if (offset === 0) {
    const from = new Date(Math.max(windowStart.getTime(), now.getTime()));
    return { available: true, stage: stageDuring(area, from, windowEnd), source: 'esp_status' };
  }
  const dayStart = zonedDateTimeToUtc({ year, month, day }, timezone);
  const published = area.nextStages.some((change) => change.startsAt >= dayStart);
  if (!published) return unknownStage('EskomSePush has not published a schedule for this date');
  return { available: true, stage: stageDuring(area, windowStart, windowEnd), source: 'esp_schedule' };
};


const clearLoadSheddingCache = () => {
  loadSheddingCache = { status: null, fetchedAt: null };
};

/**
 * Aggregates all signals for a given date and location.
 */
const getSignalsForDate = async (date, location = {}) => {
  const d = new Date(date);
  const dayOfWeek = d.getDay();

  const loadShedding = await getLoadSheddingForDate(location.city, toDateKey(d), location.timezone || 'Africa/Johannesburg');

  return {
    isPayday: isPayday(d),
    isPublicHoliday: isPublicHoliday(d),
    isSchoolHoliday: isSchoolHoliday(d),
    loadSheddingStage: loadShedding.stage,
    loadSheddingSource: loadShedding.source || null,
    loadSheddingAvailable: loadShedding.available,
    ...(loadShedding.unavailableReason
      ? { loadSheddingUnavailableReason: loadShedding.unavailableReason }
      : {}),
    dayOfWeek,
  };
};

const isBusinessDay = (date) => {
  const d = new Date(date);
  return d.getDay() !== 0 && d.getDay() !== 6 && !isPublicHoliday(d);
};

// At most a long weekend plus a holiday away (Easter is four days), so the walk is bounded.
const previousBusinessDay = (date) => {
  let cursor = new Date(date);
  for (let step = 0; step < 7 && !isBusinessDay(cursor); step += 1) cursor = addDays(cursor, -1);
  return cursor;
};

// Employers pay on the 25th, on the last business day, or on the 1st; a 25th or month-end that is not a business day moves to the
// business day before it. A 1st that is not a business day is already covered by the previous month's month-end.
const paydayAnchors = (year, month) => {
  const anchors = [
    previousBusinessDay(new Date(year, month, 25, 12)),
    previousBusinessDay(new Date(year, month + 1, 0, 12)),
  ];
  const first = new Date(year, month, 1, 12);
  if (isBusinessDay(first)) anchors.push(first);
  return anchors;
};

const isPayday = (date) => {
  const d = new Date(date);
  return paydayAnchors(d.getFullYear(), d.getMonth()).some((anchor) => isSameLocalDate(anchor, d));
};

module.exports = {
  isBusinessDay, previousBusinessDay, paydayAnchors, getLoadSheddingForDate, LOAD_SHEDDING_SCHEDULE_DAYS,
  isPayday,
  isPublicHoliday,
  getPublicHolidayInfo,
  getPublicHolidaysForYear,
  getSchoolCalendarForYear,
  isSchoolHoliday,
  getLoadSheddingStage,
  clearLoadSheddingCache,
  getSignalsForDate,
};
