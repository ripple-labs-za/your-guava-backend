const mongoose = require('mongoose');
const Staff = require('../models/Staff.model');
const LeaveBalance = require('../models/LeaveBalance.model');
const { activeCafeId } = require('../utils/tenancy');
const { balanceViews } = require('../services/workforce/leaveCycles');
const { cafeToday } = require('../services/workforce/cafeCalendar');
const {
  parseWorkDays, WORKFORCE_TEXT_LIMITS, objectIdString, requiredText, optionalText,
  dateOnlyInput, assertPlainBody, parseHourlyRate, parseRole, parseBoolean, optionalEmail,
} = require('../services/workforce/input');
const { sendWorkforceError } = require('../services/workforce/errors');
const { assertStartDateMovable } = require('../services/workforce/startDateLock');

// Pay is owner-only information. Managers get the roster without hourlyRate.
const staffDto = (staff, user) => {
  if (user?.role === 'owner') return staff;
  const { hourlyRate: _hourlyRate, ...withoutRate } = staff;
  return withoutRate;
};

// POST /api/staff — Create staff member + leave balance
const create = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const body = assertPlainBody(req.body);
    const name = requiredText(body.name, 'name', WORKFORCE_TEXT_LIMITS.name);
    const hourlyRate = parseHourlyRate(body.hourlyRate, { required: true });
    const email = optionalEmail(body.email);
    const phone = optionalText(body.phone, 'phone', WORKFORCE_TEXT_LIMITS.phone);
    const role = parseRole(body.role);
    const parsedStartDate = body.startDate === undefined || body.startDate === ''
      ? undefined : dateOnlyInput(body.startDate, 'startDate');
    const workDays = parseWorkDays(body.workDays);
    // The cafe's date, not the server's clock: a hire recorded between 00:00 and
    // 02:00 SAST would otherwise start a day early, and so would every cycle.
    const employmentStart = parsedStartDate || (await cafeToday(cafeId));

    let staff;
    await session.withTransaction(async () => {
      [staff] = await Staff.create([{
        cafeId,
        name,
        email,
        phone,
        role,
        hourlyRate,
        startDate: employmentStart,
        ...(workDays ? { workDays } : {}),
      }], { session });
      await LeaveBalance.create([{ staffId: staff._id, cafeId }], { session });
    });

    return res.status(201).json({ success: true, staff });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  } finally {
    await session.endSession();
  }
};

// GET /api/staff — List all active staff for cafe with leave balances
const list = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);

    const staff = await Staff.find({ cafeId, isActive: true }).sort({ name: 1 }).lean();

    // Attach each person's balance in their current leave cycle.
    const balances = await LeaveBalance.find({ cafeId, staffId: { $in: staff.map((member) => member._id) } }).lean();
    const views = await balanceViews({ cafeId, staff, balances, onDate: await cafeToday(cafeId) });
    const staffWithBalances = staff.map((member, index) => staffDto({ ...member, leaveBalance: views[index] }, req.user));

    return res.status(200).json({ success: true, staff: staffWithBalances });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// GET /api/staff/:id — Get single staff member with leave balance
const getOne = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');

    const staff = await Staff.findOne({ _id: id, cafeId }).lean();

    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    const [leaveBalance] = await balanceViews({
      cafeId,
      staff: [staff],
      balances: await LeaveBalance.find({ staffId: staff._id, cafeId }).lean(),
      onDate: await cafeToday(cafeId),
    });

    return res
      .status(200)
      .json({ success: true, staff: staffDto({ ...staff, leaveBalance }, req.user) });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// PUT /api/staff/:id — Update staff details
const update = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');
    const body = assertPlainBody(req.body);
    const parsedStartDate = body.startDate === undefined ? undefined : dateOnlyInput(body.startDate, 'startDate');
    const isActive = parseBoolean(body.isActive, 'isActive');
    const workDays = parseWorkDays(body.workDays);
    const changes = {
      ...(body.name !== undefined && { name: requiredText(body.name, 'name', WORKFORCE_TEXT_LIMITS.name) }),
      ...(body.email !== undefined && { email: optionalEmail(body.email) }),
      ...(body.phone !== undefined && { phone: optionalText(body.phone, 'phone', WORKFORCE_TEXT_LIMITS.phone) }),
      ...(body.role !== undefined && { role: parseRole(body.role) }),
      ...(body.hourlyRate !== undefined && { hourlyRate: parseHourlyRate(body.hourlyRate, { required: true }) }),
      ...(parsedStartDate !== undefined && { startDate: parsedStartDate }),
      ...(isActive !== undefined && { isActive }),
      ...(workDays !== undefined && { workDays }),
    };

    let staff;
    await session.withTransaction(async () => {
      if (parsedStartDate !== undefined) await assertStartDateMovable({ cafeId, staffId: id, startDate: parsedStartDate, session });
      staff = await Staff.findOneAndUpdate(
        { _id: id, cafeId },
        {
          $set: changes,
        },
        { new: true, runValidators: true, session }
      );
    });

    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    return res.status(200).json({ success: true, staff });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  } finally {
    await session.endSession();
  }
};

// DELETE /api/staff/:id — Soft delete (set isActive: false)
const remove = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');

    const staff = await Staff.findOneAndUpdate(
      { _id: id, cafeId },
      { $set: { isActive: false } },
      { new: true }
    );

    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    return res.status(200).json({ success: true, message: 'Staff member deactivated' });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

module.exports = { create, list, getOne, update, remove };
