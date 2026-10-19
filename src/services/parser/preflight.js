const { smallXlsxParts } = require('./xlsxArchive');
const { readWorkbook } = require('./xlsx');

// Do not duplicate XML parsing, coordinate arithmetic or first-sheet selection.
// The existing reader handles cheap malformed files, with strict work bounds:
// at most 2 MB expanded and 256 markup endings across every XML part. Real
// sheets with many cells stay isolated. A long unterminated tag has very few
// endings and the real SAX reader rejects its first malformed opening.
const preflightXlsx = async (buffer) => {
  const parts = smallXlsxParts(buffer);
  if (!parts) return;
  let endings = 0;
  for (const [name, bytes] of parts) {
    if (!/\.(?:xml|rels)$/i.test(name)) continue;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 62 && ++endings > 256) return;
    }
  }
  await readWorkbook(buffer);
};

module.exports = { preflightXlsx };
