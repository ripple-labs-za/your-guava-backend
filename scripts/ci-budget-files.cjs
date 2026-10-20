const fs = require('node:fs');
const path = require('node:path');

// A visible tag on it/test (including .each) or describe selects the file and the test name.
// Discover rather than maintain a second list that can silently omit a newly tagged test.
const TAGGED_REGISTRATION = /^\s*(?:(?:it|test|describe)(?:\.each\([^\r\n]*\))?|\]\))\(\s*['"`]\[budget\] /m;
const budgetFiles = (root) => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return full.endsWith('.test.js') && TAGGED_REGISTRATION.test(fs.readFileSync(full, 'utf8'))
      ? [full.replaceAll('\\', '/')] : [];
  });
  const files = walk(path.join(root, 'tests'));
  if (files.length === 0) throw new Error('No [budget] tests found; refusing an empty budget gate');
  return files;
};

module.exports = { budgetFiles };
