// The text encoding of an uploaded CSV, decoded to UTF-8 before anything reads it (BE-03-T08).
const { isUtf8 } = require('node:buffer');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const startsWith = (buffer, prefix) =>
  buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);

const hasUtf16Bom = (buffer) => startsWith(buffer, UTF16LE_BOM) || startsWith(buffer, UTF16BE_BOM);

/**
 * Everything downstream reads UTF-8. Excel's plain "CSV (Comma delimited)" writes Windows-1252, "Unicode Text"
 * writes UTF-16, and "CSV UTF-8" puts a BOM in front; each used to reach csv-parser as it was, which turned
 * accents and the × quantity marker into U+FFFD and hid a quoted first header behind the BOM.
 */
const decodeCsvBuffer = (buffer) => {
  if (startsWith(buffer, UTF8_BOM)) return { buffer: buffer.subarray(UTF8_BOM.length), encoding: 'utf-8' };
  if (startsWith(buffer, UTF16LE_BOM)) {
    return { buffer: Buffer.from(buffer.subarray(2).toString('utf16le'), 'utf8'), encoding: 'utf-16le' };
  }
  if (startsWith(buffer, UTF16BE_BOM)) {
    const body = Buffer.from(buffer.subarray(2, buffer.length - ((buffer.length - 2) % 2)));
    return { buffer: Buffer.from(body.swap16().toString('utf16le'), 'utf8'), encoding: 'utf-16be' };
  }
  if (isUtf8(buffer)) return { buffer, encoding: 'utf-8' };
  return { buffer: Buffer.from(new TextDecoder('windows-1252').decode(buffer), 'utf8'), encoding: 'windows-1252' };
};

module.exports = { decodeCsvBuffer, hasUtf16Bom };
