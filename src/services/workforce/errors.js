/**
 * A refusal the workforce API words deliberately for the client: an HTTP
 * status, a stable code the portal can branch on, and a sentence it shows
 * verbatim (D-009). Anything else goes to next(error) and the error middleware.
 */
class WorkforceError extends Error {
  constructor(statusCode, code, message, extra = {}) {
    super(message);
    this.name = 'WorkforceError';
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

const sendWorkforceError = (res, error) => {
  if (!(error instanceof WorkforceError)) return false;
  res.status(error.statusCode).json({ success: false, code: error.code, message: error.message, ...error.extra });
  return true;
};

module.exports = { WorkforceError, sendWorkforceError };
