const fs = require('fs');
const path = require('path');

// Every outbound call goes through src/utils/http.js, so one table sets every connect and total
// timeout. A new require('axios') or a bare fetch() elsewhere would ship a call with no deadline.
const SRC_ROOT = path.resolve(__dirname, '../../src');

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

const rel = (file) => path.relative(SRC_ROOT, file).split(path.sep).join('/');
const files = walk(SRC_ROOT).map((file) => ({ file: rel(file), source: fs.readFileSync(file, 'utf8') }));
const matching = (re) => files.filter(({ source }) => re.test(source)).map(({ file }) => file);

describe('outbound HTTP hygiene', () => {
  it('only src/utils/http.js imports axios', () => {
    expect(matching(/require\(\s*['"]axios['"]\s*\)/)).toEqual(['utils/http.js']);
  });

  it('no src file calls the global fetch directly', () => {
    expect(matching(/(^|[^.\w$])fetch\(/m)).toEqual([]);
  });

  it('the S3 client is built only in r2.service.js, with the shared timeout config', () => {
    expect(matching(/new S3Client\(/)).toEqual(['services/r2.service.js']);
    expect(matching(/s3ClientTimeoutConfig\(/)).toEqual(expect.arrayContaining(['services/r2.service.js']));
  });

  it('the Resend client is only called inside the shared deadline', () => {
    expect(matching(/new Resend\(/)).toEqual(['services/email.service.js']);
    expect(matching(/withDeadline\(\s*['"]resend['"]/)).toEqual(['services/email.service.js']);
  });
});
