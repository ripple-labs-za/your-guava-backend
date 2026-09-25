// File-type acceptance: the legacy .xls refusal and the supported-buffer check that fronts the archive validator.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { createClientInputError } = require('./limits');
const { assertSafeXlsxArchive } = require('./xlsxArchive');
const { hasUtf16Bom } = require('./encoding');

// OLE2/CFBF signature: every Excel 97-2003 .xls begins with these eight bytes.
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

// Names the format and the way out. CSV UTF-8 is the instruction rather than XLSX
// because it imports on every build, and the portal says the same thing (D-002).
const LEGACY_XLS_MESSAGE =
  'This is a legacy .xls file. In Excel choose File -> Save As -> "CSV UTF-8 (Comma delimited)" '
  + 'and upload that .csv.';

const assertSupportedFileBufferUncached = (buffer, fileExt = 'csv') => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createClientInputError('Uploaded file is empty');
  }

  const ext = String(fileExt || '').toLowerCase();

  // Identify a legacy .xls by its bytes before trusting the extension. An owner
  // whose till only writes .xls will often rename it to .xlsx and try again, and
  // that produced 'XLSX file signature is invalid' - true, and useless: it does not
  // say what the file is or what to do with it. OLE2/CFBF compound document.
  if (buffer.length >= OLE2_MAGIC.length && buffer.subarray(0, OLE2_MAGIC.length).equals(OLE2_MAGIC)) {
    const err = createClientInputError(LEGACY_XLS_MESSAGE);
    err.code = 'LEGACY_XLS';
    err.publicCode = 'LEGACY_XLS';
    throw err;
  }

  if (ext === 'xlsx') {
    const validZipSuffixes = new Set(['3:4', '5:6', '7:8']);
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
      validZipSuffixes.has(`${buffer[2]}:${buffer[3]}`);
    if (!isZip) throw createClientInputError('XLSX file signature is invalid');
    assertSafeXlsxArchive(buffer);
    return;
  }

  // The legacy-XLS guidance lived downstream of this assert, so it was
  // unreachable: an owner whose till only offers .xls was told the format was
  // unsupported and nothing about what to export instead. Say it here and every
  // entry point says it.
  if (ext === 'xls') {
    const err = createClientInputError(LEGACY_XLS_MESSAGE);
    err.code = 'LEGACY_XLS';
    err.publicCode = 'LEGACY_XLS';
    throw err;
  }

  if (ext !== 'csv') {
    throw createClientInputError('Only CSV and XLSX files are supported');
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  // UTF-16 is full of NUL bytes by construction; prepareCsv checks the decoded text instead (BE-03-T08).
  if (!hasUtf16Bom(buffer) && sample.includes(0)) {
    throw createClientInputError('CSV file contains binary data');
  }
};

// parseBuffer asserted the file and then readRows asserted it again; the upload asserted it three times. Each pass
// inflated every entry of an archive of up to 50 MB and scanned its sheets (BE-03-T13). A Buffer is validated once per
// extension for as long as it is alive; one that failed is never remembered, so it fails every time.
const VALIDATED = new WeakMap();

const assertSupportedFileBuffer = (buffer, fileExt = 'csv') => {
  const ext = String(fileExt || '').toLowerCase();
  if (Buffer.isBuffer(buffer) && VALIDATED.get(buffer)?.has(ext)) return;
  assertSupportedFileBufferUncached(buffer, ext);
  if (!VALIDATED.has(buffer)) VALIDATED.set(buffer, new Set());
  VALIDATED.get(buffer).add(ext);
};

module.exports = {
  assertSupportedFileBuffer,
};
