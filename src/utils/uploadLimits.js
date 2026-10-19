// The answer to an upload over the size limit (BE-13-T02): a 413 with its own code, the limit in words, and the limit in bytes.
// Shared by multer's limit (routes/transactions.routes.js) and the controller's own check, so both say the same thing.
const uploadTooLargeBody = (maxBytes) => {
  const limitMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
  return {
    success: false,
    code: 'UPLOAD_TOO_LARGE',
    message: `This file is larger than the ${limitMb} MB upload limit. Export a shorter date range and upload each part.`,
    details: { maxBytes },
  };
};

module.exports = { uploadTooLargeBody };
