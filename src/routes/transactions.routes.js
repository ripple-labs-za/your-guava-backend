const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth.middleware');
const { requireActiveCafe } = require('../middleware/requireCafe.middleware');
const { uploadLimiter } = require('../middleware/rateLimit.middleware');
const { apiCache } = require('../middleware/cache.middleware');
const r2 = require('../services/r2.service');
const { uploadTooLargeBody } = require('../utils/uploadLimits');
const {
  upload,
  getTransactions,
  getStats,
  getDataStatus,
} = require('../controllers/transactions.controller');

const uploadMaxBytes = () => (
  typeof r2.maxObjectBytes === 'function' ? r2.maxObjectBytes() : 10 * 1024 * 1024
);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer disk storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${uniqueSuffix}-${safeName}`);
  },
});

const fileFilter = (_req, file, cb) => {
  // .xls is allowed through so the parser can answer with the Save-As-CSV advice (D-002); it is never imported.
  const allowedExts = ['.csv', '.xlsx', '.xls'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    const err = new Error('Only CSV and XLSX files are allowed');
    err.statusCode = 400;
    cb(err, false);
  }
};

// The portal sends one part, `file`. busboy's defaults allow unlimited text
// fields of up to 1 MB each and unlimited parts, and multer buffers every
// field before the controller runs: a thousand fields was a gigabyte of heap
// (uploads-catalogue-6). Allow the file and a little slack, nothing more.
const MULTIPART_LIMITS = {
  files: 1,
  fields: 4,
  fieldSize: 1024,
  fieldNameSize: 100,
  parts: 5,
  headerPairs: 50,
};
const FORM_TOO_LARGE_CODES = new Set([
  'LIMIT_PART_COUNT', 'LIMIT_FILE_COUNT', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_COUNT',
]);

const multerUpload = multer({
  storage,
  fileFilter,
  // Browsers send the part's file name as UTF-8 bytes; multer's latin1 default stored "Продажи.csv" garbled.
  defParamCharset: 'utf8',
  limits: { fileSize: uploadMaxBytes(), ...MULTIPART_LIMITS },
});

const handleMulterUpload = (req, res, next) => {
  multerUpload.single('file')(req, res, (err) => {
    if (!err) return next();

    if (req.file?.path) {
      fs.rm(req.file.path, { force: true }, () => {});
    }

    // A lost client is already recorded by requestLogger's close handler. It
    // cannot receive a storage-error response and is not a disk failure.
    if (req.aborted || res.destroyed || (req.destroyed && !req.complete) || /^Request (aborted|closed)$/i.test(err.message || '')) {
      return;
    }

    const isMulterError = err instanceof multer.MulterError;
    // multer drains the rest of the request before calling back, so the client
    // gets the 413 rather than a reset connection, and nothing past the first
    // kilobyte of any field is kept.
    if (isMulterError && FORM_TOO_LARGE_CODES.has(err.code)) {
      return res.status(413).json({
        success: false,
        code: 'UPLOAD_FORM_TOO_LARGE',
        message: 'This upload carried more form data than a file upload needs. Choose the file again and upload only the file.',
      });
    }
    // Too large is a 413 with its own code and the limit in words (BE-13-T02); it used to be a 400 the portal could not tell apart.
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json(uploadTooLargeBody(uploadMaxBytes()));
    const statusCode = err.statusCode || (isMulterError ? 400 : 500);
    const message = err.message || 'File upload failed';

    if (statusCode < 500) return res.status(statusCode).json({ success: false, message });
    const storageError = new Error(
      'We could not save this file on our server, so nothing was imported. Please try again in a few minutes.'
    );
    storageError.statusCode = 500;
    storageError.exposeMessage = true;
    storageError.logContext = { stage: 'upload_storage', code: err.code, syscall: err.syscall, cause: String(err.message || err) };
    return next(storageError);
  });
};

// All routes are protected, and all read or write one cafe's data (BE-03-T12).
router.use(authMiddleware);
router.use(requireActiveCafe);

// Uploads get their own budget, ahead of multer so a limited request never
// touches disk. Deliberately NOT the AI limiter: a Yoco export or a cafe with a
// saved mapping never calls Claude, so charging every upload against the AI
// budget stopped an owner importing a backlog and blamed "AI requests" for it.
// The controller admits the AI mapper through admitAiRequest (the shared AI limiter),
// and meterGuavaCredits reserves its credits before the provider call.
// requireCreditSpend is deliberately absent: members without credit permission
// must still upload preset formats (allowPaidAi=false falls back to a free mapping).
router.post('/upload', uploadLimiter, handleMulterUpload, upload);
router.get('/status', getDataStatus);
router.get('/stats', apiCache({ ttlMs: 30000, keyPrefix: 'transaction-stats' }), getStats);
router.get('/', getTransactions);

module.exports = router;
