const crypto = require('crypto');
const path = require('path');
const r2 = require('../../src/services/r2.service');

const R2_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
];

describe('r2 storage safety', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.DOWNLOAD_SIGNING_SECRET = 'test-download-signing-secret-0123456789';
    process.env.JWT_SECRET = 'test-local-signing-secret-with-enough-entropy';
    process.env.API_PUBLIC_URL = 'http://localhost:5000';
    delete process.env.UPLOAD_MAX_BYTES;
    for (const key of R2_KEYS) delete process.env[key];
    r2._resetClient();
  });

  afterAll(() => {
    process.env = originalEnv;
    r2._resetClient();
  });

  it('accepts an untampered, unexpired local signed URL', async () => {
    const signedUrl = await r2.getSignedDownloadUrl('cafe/upload.csv', 60);
    const url = new URL(signedUrl);
    const filePath = r2.getLocalDownloadPath(
      url.searchParams.get('key'),
      url.searchParams.get('expires'),
      url.searchParams.get('sig')
    );

    expect(filePath).toBe(path.resolve(process.cwd(), 'uploads', 'r2', 'cafe', 'upload.csv'));
  });

  it('rejects a tampered signature with 403', async () => {
    const signedUrl = await r2.getSignedDownloadUrl('cafe/upload.csv', 60);
    const url = new URL(signedUrl);

    expect(() => r2.getLocalDownloadPath(
      url.searchParams.get('key'),
      url.searchParams.get('expires'),
      '0'.repeat(64)
    )).toThrow(expect.objectContaining({ statusCode: 403, code: 'INVALID_DOWNLOAD_SIGNATURE' }));
  });

  it('rejects an expired link with 410', () => {
    const key = 'cafe/upload.csv';
    const expires = String(Date.now() - 1000);
    const sig = crypto.createHmac('sha256', process.env.DOWNLOAD_SIGNING_SECRET)
      .update(`${key}.${expires}`)
      .digest('hex');

    expect(() => r2.getLocalDownloadPath(key, expires, sig))
      .toThrow(expect.objectContaining({ statusCode: 410, code: 'DOWNLOAD_LINK_EXPIRED' }));
  });

  it('rejects traversal even when the traversal value has a valid signature', () => {
    const key = '../outside.csv';
    const expires = String(Date.now() + 60_000);
    const sig = crypto.createHmac('sha256', process.env.DOWNLOAD_SIGNING_SECRET)
      .update(`${key}.${expires}`)
      .digest('hex');

    expect(() => r2.getLocalDownloadPath(key, expires, sig))
      .toThrow(expect.objectContaining({ statusCode: 403, code: 'INVALID_DOWNLOAD_LINK' }));
  });

  it('fails closed when R2 is incomplete in production', () => {
    process.env.NODE_ENV = 'production';

    expect(() => r2.useLocalStorage()).toThrow(/R2 storage is required in production/i);
  });

  it('does not silently fall back when R2 is only partially configured', () => {
    process.env.R2_BUCKET_NAME = 'test-bucket';

    expect(() => r2.useLocalStorage()).toThrow(/configuration is incomplete/i);
    expect(r2.getConfigurationStatus()).toMatchObject({ ok: false, mode: 'misconfigured' });
  });

  it('rejects oversized upload buffers before storage', async () => {
    process.env.UPLOAD_MAX_BYTES = '1024';

    await expect(r2.uploadFile(Buffer.alloc(1025), 'cafe/large.csv'))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('presigns downloads as attachments so a stored file never renders inline', async () => {
    Object.assign(process.env, { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET_NAME: 'bucket' });
    r2._resetClient();
    const url = new URL(await r2.getSignedDownloadUrl('uploads/c/1-sales.csv', 60, { fileName: 'Sales "Sept".csv' }));
    expect(url.searchParams.get('response-content-disposition')).toMatch(/^attachment; filename="Sales _Sept_\.csv"/);
  });

  // Review of BE-03-T12: a long name kept its extension only in part, and a non-Latin name became underscores.
  it('keeps the extension of a long name and the real name of a non-Latin one', async () => {
    Object.assign(process.env, { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET_NAME: 'bucket' });
    r2._resetClient();
    const disposition = async (fileName) => new URL(await r2.getSignedDownloadUrl('uploads/c/1-x.csv', 60, { fileName }))
      .searchParams.get('response-content-disposition');
    const long = await disposition(`${'x'.repeat(300)}.csv`);
    expect(long).toMatch(/filename="x{140}\.csv"; filename\*=UTF-8''x{190}\.csv$/);
    const cyrillic = await disposition('Продажи сентябрь.csv');
    expect(cyrillic).toContain("filename*=UTF-8''" + encodeURIComponent('Продажи сентябрь.csv'));
    // Text after the last dot longer than an extension is part of the name, not cut through the middle.
    const dotted = await disposition('sales.from-the-september-till');
    expect(dotted).toBe(`attachment; filename="sales.from-the-september-till"; filename*=UTF-8''sales.from-the-september-till`);
  });
it('verifies local links with DOWNLOAD_SIGNING_SECRET and refuses one signed with the session secret', () => {
  const key = 'cafe/upload.csv';
  const expires = String(Date.now() + 60_000);
  const sign = (secret) => crypto.createHmac('sha256', secret).update(`${key}.${expires}`).digest('hex');

  expect(() => r2.getLocalDownloadPath(key, expires, sign(process.env.JWT_SECRET)))
    .toThrow(expect.objectContaining({ statusCode: 403, code: 'INVALID_DOWNLOAD_SIGNATURE' }));
  expect(r2.getLocalDownloadPath(key, expires, sign(process.env.DOWNLOAD_SIGNING_SECRET)))
    .toBe(path.resolve(process.cwd(), 'uploads', 'r2', 'cafe', 'upload.csv'));
});

it('refuses to sign local links without an independent DOWNLOAD_SIGNING_SECRET', async () => {
  delete process.env.DOWNLOAD_SIGNING_SECRET;
  await expect(r2.getSignedDownloadUrl('cafe/upload.csv', 60))
    .rejects.toMatchObject({ statusCode: 503, code: 'DOWNLOAD_SIGNING_NOT_CONFIGURED' });

  process.env.DOWNLOAD_SIGNING_SECRET = process.env.JWT_SECRET;
  await expect(r2.getSignedDownloadUrl('cafe/upload.csv', 60))
    .rejects.toMatchObject({ code: 'DOWNLOAD_SIGNING_NOT_CONFIGURED' });
});

});
