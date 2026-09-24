// The text encoding of an uploaded CSV, decoded to UTF-8 before anything reads it (BE-03-T08).
const { isUtf8 } = require('node:buffer');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const startsWith = (buffer, prefix) =>
  buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);

const hasUtf16Bom = (buffer) => startsWith(buffer, UTF16LE_BOM) || startsWith(buffer, UTF16BE_BOM);

let cp1252Table = null;
/** Each byte's Windows-1252 character, built once. */
const cp1252Char = (byte) => {
  if (!cp1252Table) {
    const all = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, index) => index));
    cp1252Table = [...all];
  }
  return cp1252Table[byte];
};

const isContinuation = (byte) => byte >= 0x80 && byte <= 0xbf;

/** The length of the valid UTF-8 sequence starting at `i`, or 0 (overlong forms and surrogates are invalid). */
const utf8SequenceLength = (buffer, i) => {
  const b = buffer[i];
  if (b >= 0xc2 && b <= 0xdf) return isContinuation(buffer[i + 1]) ? 2 : 0;
  if (b >= 0xe0 && b <= 0xef) {
    const b1 = buffer[i + 1];
    const lowest = b === 0xe0 ? 0xa0 : 0x80;
    const highest = b === 0xed ? 0x9f : 0xbf;
    return b1 >= lowest && b1 <= highest && isContinuation(buffer[i + 2]) ? 3 : 0;
  }
  if (b >= 0xf0 && b <= 0xf4) {
    const b1 = buffer[i + 1];
    const lowest = b === 0xf0 ? 0x90 : 0x80;
    const highest = b === 0xf4 ? 0x8f : 0xbf;
    return b1 >= lowest && b1 <= highest && isContinuation(buffer[i + 2]) && isContinuation(buffer[i + 3]) ? 4 : 0;
  }
  return 0;
};

const hasUtf8Multibyte = (buffer) => {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] >= 0x80 && utf8SequenceLength(buffer, i) > 0) return true;
  }
  return false;
};

/** UTF-8 where the bytes form it, Windows-1252 for each byte that does not. Linear. */
const decodeMixed = (buffer) => {
  const parts = [];
  let run = 0;
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] < 0x80) { i += 1; continue; }
    const length = utf8SequenceLength(buffer, i);
    if (length > 0) { i += length; continue; }
    parts.push(buffer.toString('utf8', run, i), cp1252Char(buffer[i]));
    i += 1;
    run = i;
  }
  parts.push(buffer.toString('utf8', run));
  return Buffer.from(parts.join(''), 'utf8');
};

/**
 * Everything downstream reads UTF-8. Excel's plain "CSV (Comma delimited)" writes Windows-1252, "Unicode Text"
 * writes UTF-16, and "CSV UTF-8" puts a BOM in front; each used to reach csv-parser as it was, which turned
 * accents and the × quantity marker into U+FFFD and hid a quoted first header behind the BOM.
 *
 * A file that is UTF-8 but for a stray byte (one line pasted from elsewhere) stays UTF-8, with only the bytes that
 * are not UTF-8 read as Windows-1252: decoding it all as 1252 turned every correct "è" into "Ã¨" (review of
 * BE-03-T08). A real Windows-1252 file almost never forms a valid UTF-8 sequence, so it still decodes as 1252.
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
  if (hasUtf8Multibyte(buffer)) return { buffer: decodeMixed(buffer), encoding: 'utf-8' };
  return { buffer: Buffer.from(new TextDecoder('windows-1252').decode(buffer), 'utf8'), encoding: 'windows-1252' };
};

module.exports = { decodeCsvBuffer, hasUtf16Bom };
