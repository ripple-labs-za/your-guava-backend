// Requires specific role(s)
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
      });
    }
    next();
  };
};

// Requires owner role
const ownerOnly = requireRole('owner');

// Allows both owner and manager

const canSpendCredits = (user) =>
  Boolean(user && (user.role === 'owner' || user.permissions?.canSpendCredits === true));

const requireCreditSpend = (req, res, next) => {
  if (!canSpendCredits(req.user)) {
    return res.status(403).json({
      success: false,
      code: 'CREDIT_SPEND_FORBIDDEN',
      message: 'The account owner has not enabled Guava Credit spending for this member',
    });
  }
  return next();
};

module.exports = {
  requireRole,
  ownerOnly,
  canSpendCredits,
  requireCreditSpend,
};
