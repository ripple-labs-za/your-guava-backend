const mongoose = require('mongoose');
const Staff = require('../models/Staff.model');
const LeaveBalance = require('../models/LeaveBalance.model');
const { parseDateOnly } = require('../utils/timezone');
const { activeCafeId } = require('../utils/tenancy');
const { balanceViews } = require('../services/workforce/leaveCycles');
const { cafeToday } = require('../services/workforce/cafeCalendar');
const { parseWorkDays } = require('../services/workforce/input');
const { sendWorkforceError } = require('../services/workforce/errors');

// Pay is owner-only information. Managers get the roster without hourlyRate.
const staffDto = (staff, user) => {
  if (user?.role === 'owner') return staff;
  const { hourlyRate: _hourlyRate, ...withoutRate } = staff;
  return withoutRate;
};

// A start date is optional: empty means none, anything else must be a real YYYY-MM-DD (null otherwise).
const optionalDateOnly = (value) => (value == null || value === '' ? undefined : parseDateOnly(value));

// POST /api/staff — Create staff member + leave balance
const create = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const { name, email, phone, role, hourlyRate, startDate } = req.body;
    const parsedRate = Number(hourlyRate);
    const parsedStartDate = optionalDateOnly(startDate);

    if (!String(name || '').trim() || hourlyRate == null) {
      return res.status(400).json({ success: false, message: 'name and hourlyRate are required' });
    }
    if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 10000) {
      return res.status(400).json({ success: false, message: 'hourlyRate must be between 0 and 10000' });
    }
    if (startDate && !parsedStartDate) {
      return res.status(400).json({ success: false, message: 'startDate must use YYYY-MM-DD' });
    }
    const workDays = parseWorkDays(req.body.workDays);

    let staff;
    await session.withTransaction(async () => {
      [staff] = await Staff.create([{
        cafeId,
        name: String(name).trim(),
        email,
        phone,
        role,
        hourlyRate: parsedRate,
        startDate: parsedStartDate,
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
    next(error);
  }
};

// GET /api/staff/:id — Get single staff member with leave balance
const getOne = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { id } = req.params;

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
    next(error);
  }
};

// PUT /api/staff/:id — Update staff details
const update = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { id } = req.params;
    const { name, email, phone, role, hourlyRate, startDate, isActive } = req.body;
    const parsedStartDate = startDate !== undefined ? optionalDateOnly(startDate) : undefined;
    const parsedRate = hourlyRate !== undefined ? Number(hourlyRate) : undefined;

    if (startDate !== undefined && !parsedStartDate) {
      return res.status(400).json({ success: false, message: 'startDate must use YYYY-MM-DD' });
    }
    if (hourlyRate !== undefined && (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 10000)) {
      return res.status(400).json({ success: false, message: 'hourlyRate must be between 0 and 10000' });
    }
    const workDays = parseWorkDays(req.body.workDays);

    const staff = await Staff.findOneAndUpdate(
      { _id: id, cafeId },
      {
        $set: {
          ...(name !== undefined && { name: String(name).trim() }),
          ...(email !== undefined && { email }),
          ...(phone !== undefined && { phone }),
          ...(role !== undefined && { role }),
          ...(hourlyRate !== undefined && { hourlyRate: parsedRate }),
          ...(startDate !== undefined && { startDate: parsedStartDate }),
          ...(isActive !== undefined && { isActive }),
          ...(workDays !== undefined && { workDays }),
        },
      },
      { new: true, runValidators: true }
    );

    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    return res.status(200).json({ success: true, staff });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// DELETE /api/staff/:id — Soft delete (set isActive: false)
const remove = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { id } = req.params;

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
    next(error);
  }
};

module.exports = { create, list, getOne, update, remove };
