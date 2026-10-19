#!/usr/bin/env node
/**
 * The backend's static checks, with no dependencies (BE-12-T04). CI runs it after the tests; it runs the same way locally:
 *   node scripts/static-checks.mjs
 *   node scripts/static-checks.mjs --coverage-summary coverage/coverage-summary.json   # adds the per-file coverage floor
 *   node scripts/static-checks.mjs --only syntax,testGuards
 *   node scripts/static-checks.mjs --root <dir>                                         # another tree (the self-test)
 * Exit 0 when every selected check passes, 1 when one fails, 2 for an unknown check name.
 * Suppress one finding with `// static-checks: allow <reason>` on the offending line.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const ROOT = path.resolve(option('--root') || process.cwd());
const ONLY = (option('--only') || '').split(',').filter(Boolean);
const COVERAGE_SUMMARY = option('--coverage-summary');
const FILE_LINE_FLOOR = 70;
const ALLOW = 'static-checks: allow';
const SKIP_DIRS = new Set(['node_modules', 'coverage', 'uploads', 'backups', '.git']);
// Today's CI grep covers js, jsx, ts, tsx, mjs, cjs, json, css, md, yml, yaml and html; this keeps all of them and adds
// .env.example and the named files below. Fixture data (.csv, .txt, .xlsx) is left out on purpose: a hostile-input fixture
// (encoding, stray quotes, control bytes in a cell) may carry those bytes deliberately, exactly as today's grep leaves it out.
const TEXT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.example',
]);
const TEXT_NAMES = new Set(['Dockerfile', '.gitignore', '.dockerignore', '.nvmrc']);
// BE-12-T03 round 1: an expect() guarded on its own line. `expect(` needs the paren, so matchers like `expect.any(` never count.
const ONE_LINE_GUARDS = [
  /\bif\s*\(.*\)\s*expect\(/,
  /\bif\s*\(.*\)\s*\{.*expect\(/, // a same-line block: if (x) { expect(...) }
  /\belse\s+expect\(/,
  /\belse\s*\{.*expect\(/, // a same-line else block: } else { expect(...) }
  /(&&|\|\|)\s*expect\(/,
  /\?\s*expect\(/,
  /\?[^?]*:\s*expect\(/,
];

// Source with its comments blanked, so a name mentioned only in a comment does not count as used. Strings, template literals and
// regex literals are copied whole: a `//` inside 'https://…' or /\/\// is not a comment. A `/` starts a regex after an operator,
// an opening bracket or a keyword such as return; otherwise it is division.
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'yield', 'await']);
const stripComments = (source) => {
  let out = '';
  let last = '';
  let i = 0;
  const copyUntil = (close, start) => {
    let j = start + 1;
    let inClass = false;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') { j += 2; continue; }
      if (close === '/' && ch === '[') inClass = true;
      else if (close === '/' && ch === ']') inClass = false;
      else if (ch === close && !inClass) break;
      else if (close !== '`' && ch === '\n') break;
      j += 1;
    }
    out += source.slice(start, j + 1);
    last = close;
    return j + 1;
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      i = copyUntil(c, i);
    } else if (c === '/' && (REGEX_AFTER.has(last) || REGEX_AFTER_WORDS.has((out.slice(-12).match(/(\w+)\s*$/) || [])[1]))) {
      i = copyUntil('/', i);
    } else {
      out += c;
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
  }
  return out;
};

const walk = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
};
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const read = (file) => readFileSync(file, 'utf8');
const jsIn = (dir) => walk(path.join(ROOT, dir)).filter((file) => /\.[cm]?js$/.test(file));
const testFiles = () => jsIn('tests').filter((file) => file.endsWith('.test.js'));
const indentOf = (line) => line.length - line.trimStart().length;

// Tracked plus untracked-but-not-ignored files when ROOT is a git work tree; every file otherwise.
const repoFiles = () => {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  if (git.status === 0) return git.stdout.split('\0').filter(Boolean).map((file) => path.join(ROOT, file)).filter(existsSync);
  return walk(ROOT);
};

const eachLine = (files, test) => files.flatMap((file) => read(file).split(/\r?\n/).flatMap((line, index) =>
  (!line.includes(ALLOW) && test(line) ? [`${rel(file)}:${index + 1}: ${line.trim()}`] : [])));

const checks = {
  syntax() {
    const files = [...jsIn('src'), ...jsIn('tests'), ...jsIn('scripts')];
    const failures = files.flatMap((file) => {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      return result.status === 0 ? [] : [`${rel(file)}: ${(result.stderr.split('\n').find((l) => /Error/.test(l)) || 'syntax error').trim()}`];
    });
    return { checked: files.length, failures };
  },

  controlCharacters() {
    // A regex escape that passed through a JSON layer once collapsed into a literal U+0008 (commit 4376b43). Reads bytes:
    // UTF-8 multi-byte characters are all >= 0x80, so only a real control byte below 0x20 can match.
    const files = repoFiles().filter((file) => TEXT_EXTENSIONS.has(path.extname(file)) || TEXT_NAMES.has(path.basename(file)));
    const failures = files.flatMap((file) => {
      const bytes = readFileSync(file);
      const at = bytes.findIndex((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
      return at === -1 ? [] : [`${rel(file)}: byte 0x${bytes[at].toString(16).padStart(2, '0')} at offset ${at}`];
    });
    return { checked: files.length, failures };
  },

  focusedTests() {
    const files = testFiles();
    // Any `.only` in a chain (it.only.each, describe.only.each, test.concurrent.only) and Jasmine's fit/fdescribe/ftest.
    return { checked: files.length, failures: eachLine(files, (line) => /\b(describe|it|test)(\.\w+)*\.only\b|\bf(it|describe|test)\b\s*[(.]/.test(line)) };
  },

  nodeEnvTestBranches() {
    // BE-12-T01's rule: production code has no path only tests take. Catches the direct comparison, a helper's comparison
    // (BE-02-T06's `nodeEnv() === 'test'`), the reversed form, the removed helper's name, and Jest's worker variable.
    const TEST_BRANCH = /(NODE_ENV|nodeEnv\(\))\s*[!=]==?\s*['"]test['"]|['"]test['"]\s*[!=]==?|isTestEnvironment|JEST_WORKER_ID/;
    const files = jsIn('src');
    return { checked: files.length, failures: eachLine(files, (line) => TEST_BRANCH.test(line)) };
  },

  productionDependencies() {
    // The image installs dependencies only (npm ci --omit=dev); a src require of anything else fails at runtime in production.
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    const deps = new Set(Object.keys(pkg.dependencies || {}));
    const dev = new Set(Object.keys(pkg.devDependencies || {}));
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const files = jsIn('src');
    const failures = files.flatMap((file) => [...read(file).matchAll(/require\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g)]
      .map((match) => match[1])
      .filter((spec) => !builtins.has(spec))
      .map((spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]))
      .filter((name) => !deps.has(name))
      .map((name) => `${rel(file)}: requires "${name}", ${dev.has(name) ? 'a devDependency the production image does not install' : 'which package.json does not declare'}`));
    return { checked: files.length, failures };
  },

  unusedRequires() {
    const files = jsIn('src');
    const failures = files.flatMap((file) => {
      const source = read(file);
      const found = [];
      const declarations = /const\s+(?:(\w+)|\{([^}]*)\})\s*=\s*require\(\s*['"][^'"]+['"]\s*\)[^;\n]*;?/g;
      for (const match of source.matchAll(declarations)) {
        const lineEnd = source.indexOf('\n', match.index + match[0].length - 1);
        const line = source.slice(source.lastIndexOf('\n', match.index) + 1, lineEnd === -1 ? undefined : lineEnd);
        if (line.includes(ALLOW)) continue;
        const names = match[1]
          ? [match[1]]
          : match[2].split(',').map((part) => part.trim()).filter((part) => part && !part.startsWith('...'))
            .map((part) => part.split(':').pop().trim());
        const rest = stripComments(source.slice(0, match.index) + ' '.repeat(match[0].length) + source.slice(match.index + match[0].length));
        for (const name of names) {
          const used = new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(rest);
          if (!used) found.push(`${rel(file)}: "${name}" is required but never used`);
        }
      }
      return found;
    });
    return { checked: files.length, failures };
  },

  testGuards() {
    // BE-12-T03's rules: no test may return early, and no expect() may sit inside an if block or behind a one-line guard.
    const files = testFiles();
    const failures = files.flatMap((file) => {
      const lines = read(file).split(/\r?\n/);
      const found = [];
      lines.forEach((line, index) => {
        if (line.includes(ALLOW)) return;
        if (/^\s*(if\s*\(.*\)\s*)?return;\s*(\/\/.*)?$/.test(line)) found.push(`${rel(file)}:${index + 1}: early return: ${line.trim()}`);
        if (ONE_LINE_GUARDS.some((pattern) => pattern.test(line))) {
          found.push(`${rel(file)}:${index + 1}: conditional assertion: ${line.trim()}`);
          return;
        }
        // A block that opens on an if, an else if, or a bare else.
        if (!/^\s*((\}\s*else\s+)?if\s*\(.*\)|\}\s*else)\s*\{\s*(\/\/.*)?$/.test(line)) return;
        const indent = indentOf(line);
        for (let next = index + 1; next < lines.length; next += 1) {
          if (indentOf(lines[next]) <= indent && /^\s*\}/.test(lines[next])) break;
          if (/expect\(/.test(lines[next])) {
            found.push(`${rel(file)}:${index + 1}: conditional assertion: ${line.trim()}`);
            break;
          }
        }
      });
      return found;
    });
    return { checked: files.length, failures };
  },

  coverageFloor() {
    if (!COVERAGE_SUMMARY || !existsSync(COVERAGE_SUMMARY)) {
      return { checked: 0, failures: [`coverage summary not found (${COVERAGE_SUMMARY}); run jest with --coverage first`] };
    }
    const summary = JSON.parse(read(COVERAGE_SUMMARY));
    const files = Object.entries(summary).filter(([file]) => file !== 'total' && rel(file).startsWith('src/'));
    // A summary written for another checkout matches nothing here; checking zero files must not read as a pass.
    if (files.length === 0) return { checked: 0, failures: [`${COVERAGE_SUMMARY}: no src file of this tree (${ROOT}) in the summary`] };
    const failures = files.filter(([, value]) => value.lines.pct < FILE_LINE_FLOOR)
      .map(([file, value]) => `${rel(file)}: ${value.lines.pct}% lines (floor ${FILE_LINE_FLOOR}%)`);
    return { checked: files.length, failures };
  },
};

const unknown = ONLY.filter((name) => !checks[name]);
if (unknown.length > 0) {
  console.log(`unknown check(s): ${unknown.join(', ')}. Known: ${Object.keys(checks).join(', ')}`);
  process.exit(2);
}
const selected = ONLY.length > 0
  ? ONLY
  : Object.keys(checks).filter((name) => name !== 'coverageFloor' || COVERAGE_SUMMARY);

let failed = 0;
for (const name of selected) {
  const { checked, failures } = checks[name]();
  if (failures.length === 0) {
    console.log(`PASS ${name} (${checked} files)`);
  } else {
    failed += 1;
    console.log(`FAIL ${name} (${failures.length})`);
    for (const failure of failures) console.log(`  ${failure}`);
  }
}
console.log(failed === 0 ? 'static checks: all passed' : `static checks: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
