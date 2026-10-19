// ZIP-level validation of an .xlsx before any reader runs: entry names, sizes, ratios, encryption, extra fields.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { createClientInputError, parserLimits } = require('./limits');

const zlib = require('zlib');

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const ZIP_ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;

const assertZipExtraFields = (buffer, start, length) => {
  const end = start + length;
  if (start < 0 || end > buffer.length) throw createClientInputError('XLSX ZIP metadata is malformed');
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) throw createClientInputError('XLSX ZIP extra fields are malformed');
    const headerId = buffer.readUInt16LE(offset);
    const dataLength = buffer.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + dataLength > end) throw createClientInputError('XLSX ZIP extra fields are malformed');
    if (headerId === 0x0001) throw createClientInputError('ZIP64 XLSX archives are not supported');
    offset += dataLength;
  }
};

const findZipEndRecord = (buffer) => {
  if (buffer.length < 22) return null;
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  return null;
};

const assertSafeZipEntryName = (name) => {
  const normalized = String(name || '').replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.includes('..')
  ) {
    throw createClientInputError('XLSX archive contains an unsafe entry name');
  }
};

const assertSafeXlsxArchive = (buffer, { onEntry } = {}) => {
  const limits = parserLimits();
  const endOffset = findZipEndRecord(buffer);
  if (endOffset == null) throw createClientInputError('XLSX ZIP directory is missing or malformed');
  if (endOffset >= 20 && buffer.readUInt32LE(endOffset - 20) === ZIP64_END_LOCATOR) {
    throw createClientInputError('ZIP64 XLSX archives are not supported');
  }

  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw createClientInputError('Multi-disk or ZIP64 XLSX archives are not supported');
  }
  if (entryCount > limits.xlsxMaxEntries) {
    throw createClientInputError(`XLSX archive exceeds the ${limits.xlsxMaxEntries} entry limit`);
  }
  if (centralOffset + centralSize !== endOffset || centralOffset >= endOffset) {
    throw createClientInputError('XLSX ZIP directory offsets are malformed');
  }

  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let actualTotalUncompressed = 0;
  const localRanges = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) {
      throw createClientInputError('XLSX ZIP central directory is malformed');
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const versionNeeded = buffer.readUInt16LE(offset + 6);
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const entryDisk = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const centralEntryEnd = offset + 46 + fileNameLength + extraLength + commentLength;

    if (
      centralEntryEnd > endOffset ||
      versionNeeded >= 45 ||
      (flags & ZIP_ENCRYPTION_FLAGS) !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      entryDisk !== 0
    ) {
      throw createClientInputError('XLSX archive uses unsupported or unsafe ZIP features');
    }
    const unixMode = externalAttributes >>> 16;
    if ((versionMadeBy >>> 8) === 3 && (unixMode & 0xf000) === 0xa000) {
      throw createClientInputError('XLSX archive symbolic-link entries are not supported');
    }

    const fileNameStart = offset + 46;
    const fileNameBuffer = buffer.subarray(fileNameStart, fileNameStart + fileNameLength);
    const fileName = fileNameBuffer.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
    assertSafeZipEntryName(fileName);
    assertZipExtraFields(buffer, fileNameStart + fileNameLength, extraLength);

    if (uncompressedSize > limits.xlsxMaxEntryUncompressedBytes) {
      throw createClientInputError(
        `XLSX entry exceeds the ${limits.xlsxMaxEntryUncompressedBytes} byte expanded-size limit`
      );
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > limits.xlsxMaxCompressionRatio)
    ) {
      throw createClientInputError(
        `XLSX entry exceeds the ${limits.xlsxMaxCompressionRatio}:1 compression-ratio limit`
      );
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      throw createClientInputError('Stored XLSX ZIP entry sizes are inconsistent');
    }

    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.xlsxMaxTotalUncompressedBytes) {
      throw createClientInputError(
        `XLSX archive exceeds the ${limits.xlsxMaxTotalUncompressedBytes} byte expanded-size limit`
      );
    }

    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
      throw createClientInputError('XLSX ZIP local-file offsets are malformed');
    }
    const localVersionNeeded = buffer.readUInt16LE(localOffset + 4);
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      localVersionNeeded >= 45 ||
      localFlags !== flags ||
      localMethod !== compressionMethod ||
      localNameLength !== fileNameLength ||
      dataStart > centralOffset ||
      dataEnd > centralOffset ||
      !buffer.subarray(localNameStart, localNameStart + localNameLength).equals(fileNameBuffer)
    ) {
      throw createClientInputError('XLSX ZIP local-file metadata is inconsistent');
    }
    if (
      (flags & 0x0008) === 0 &&
      (
        localCrc !== expectedCrc ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize
      )
    ) {
      throw createClientInputError('XLSX ZIP entry sizes are inconsistent');
    }
    assertZipExtraFields(buffer, localNameStart + localNameLength, localExtraLength);
    let expanded;
    if (compressionMethod === 8) {
      const verificationLimit = Math.max(1, Math.min(
        limits.xlsxMaxEntryUncompressedBytes,
        limits.xlsxMaxTotalUncompressedBytes - actualTotalUncompressed,
        uncompressedSize + 1
      ));
      try {
        expanded = zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd), {
          maxOutputLength: verificationLimit,
        });
      } catch (error) {
        throw createClientInputError('XLSX ZIP entry could not be safely decompressed');
      }
    } else {
      expanded = buffer.subarray(dataStart, dataEnd);
    }
    if (expanded.length !== uncompressedSize) {
      throw createClientInputError('XLSX ZIP expanded sizes are inconsistent');
    }
    if ((zlib.crc32(expanded) >>> 0) !== expectedCrc) {
      throw createClientInputError('XLSX ZIP entry CRC checksum is inconsistent');
    }
    if (onEntry) onEntry(fileName, expanded);
    actualTotalUncompressed += expanded.length;
    if (actualTotalUncompressed > limits.xlsxMaxTotalUncompressedBytes) {
      throw createClientInputError(
        `XLSX archive exceeds the ${limits.xlsxMaxTotalUncompressedBytes} byte actual expanded-size limit`
      );
    }
    localRanges.push({ start: localOffset, end: dataEnd });
    offset = centralEntryEnd;
  }

  if (offset !== endOffset) throw createClientInputError('XLSX ZIP central directory size is inconsistent');
  if (
    totalUncompressed > 0 &&
    (totalCompressed === 0 || totalUncompressed / totalCompressed > limits.xlsxMaxCompressionRatio)
  ) {
    throw createClientInputError(
      `XLSX archive exceeds the ${limits.xlsxMaxCompressionRatio}:1 compression-ratio limit`
    );
  }
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw createClientInputError('XLSX ZIP entries overlap');
    }
  }
};

// An advisory gate, never a second ZIP validator: only a genuinely small archive
// may be inspected on the main thread. Forged lengths still go through all of
// assertSafeXlsxArchive's bounded decompression and CRC checks before use.
const smallXlsxParts = (buffer, maxBytes = 2 * 1024 * 1024) => {
  if (!Buffer.isBuffer(buffer) || buffer.length > maxBytes) return null;
  const end = findZipEndRecord(buffer);
  if (end === null) return null;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let total = 0;
  if (count > 1000) return null;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) return null;
    total += buffer.readUInt32LE(offset + 24);
    if (total > maxBytes) return null;
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  if (offset !== end) return null;
  const parts = new Map();
  assertSafeXlsxArchive(buffer, { onEntry: (name, value) => parts.set(name, value) });
  return parts;
};

module.exports = {
  assertSafeXlsxArchive,
  smallXlsxParts,
};
