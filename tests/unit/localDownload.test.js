const originalEnv = { ...process.env };
process.env.NODE_ENV = 'test';
process.env.DOWNLOAD_SIGNING_SECRET = 'local-download-test-download-secret-0123';
process.env.JWT_SECRET = 'local-download-test-signing-secret';
process.env.JWT_REFRESH_SECRET = 'local-download-test-refresh-secret';
for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
  delete process.env[key];
}

const supertest = require('supertest');
const crypto = require('crypto');
const app = require('../../src/app');
const r2 = require('../../src/services/r2.service');
const Upload = require('../../src/models/Upload.model');
for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
  delete process.env[key];
}
r2._resetClient();

describe('local signed downloads', () => {
  it('downloads unchanged bytes with the stored original filename, ignoring unsigned filename input', async () => {
    const key = `uploads/local-download-test/${Date.now()}-internal-sales.csv`;
    const bytes = Buffer.from('Receipt,Total\r\nA1,38.00\r\n');
    const lookup = jest.spyOn(Upload, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => ({ fileName: 'original sales.csv' }) }),
    });
    try {
      await r2.uploadFile(bytes, key, 'text/csv');
      const signedUrl = new URL(await r2.getSignedDownloadUrl(key, 60));
      signedUrl.searchParams.set('fileName', 'attacker-controlled.csv');
      const response = await supertest(app).get(`${signedUrl.pathname}${signedUrl.search}`);
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toBe('attachment; filename="original sales.csv"');
      expect(response.text).toBe(bytes.toString());
      expect(lookup).toHaveBeenCalledWith({ r2Key: key, status: { $ne: 'deleted' } });
    } finally {
      lookup.mockRestore();
      await r2.deleteFile(key);
    }
  });

  afterAll(() => {
    process.env = originalEnv;
    r2._resetClient();
  });

  it('returns 404 for a valid signed link whose object is missing', async () => {
    const signedUrl = new URL(await r2.getSignedDownloadUrl('missing/object.csv', 60));
    const response = await supertest(app).get(`${signedUrl.pathname}${signedUrl.search}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, message: 'Stored upload not found' });
  });

  it('refuses leftover stored bytes without an active upload record', async () => {
    const key = `uploads/local-download-test/${Date.now()}-leftover.csv`;
    const lookup = jest.spyOn(Upload, 'findOne').mockReturnValue({ select: () => ({ lean: async () => null }) });
    try {
      await r2.uploadFile(Buffer.from('private bytes'), key, 'text/csv');
      const signedUrl = new URL(await r2.getSignedDownloadUrl(key, 60));
      const response = await supertest(app).get(`${signedUrl.pathname}${signedUrl.search}`);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('private bytes');
    } finally { lookup.mockRestore(); await r2.deleteFile(key); }
  });

  it.each(['Caf\u00e9 sales.csv', 'sales"\r\nX-Injection: yes.csv'])('safely encodes an original attachment name: %j', async (fileName) => {
    const key = `uploads/local-download-test/${Date.now()}-${crypto.randomBytes(3).toString('hex')}.csv`;
    const lookup = jest.spyOn(Upload, 'findOne').mockReturnValue({ select: () => ({ lean: async () => ({ fileName }) }) });
    try {
      await r2.uploadFile(Buffer.from('Receipt,Total\nA1,38'), key, 'text/csv');
      const signedUrl = new URL(await r2.getSignedDownloadUrl(key, 60));
      const response = await supertest(app).get(`${signedUrl.pathname}${signedUrl.search}`);
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toMatch(/^attachment;/);
      expect(response.headers['content-disposition']).not.toMatch(/[\r\n]/);
      expect(response.headers['x-injection']).toBeUndefined();
      expect(response.text).toBe('Receipt,Total\nA1,38');
    } finally { lookup.mockRestore(); await r2.deleteFile(key); }
  });

  it('returns 403 for a tampered local signature', async () => {
    const signedUrl = new URL(await r2.getSignedDownloadUrl('missing/object.csv', 60));
    signedUrl.searchParams.set('sig', '0'.repeat(64));
    const response = await supertest(app).get(`${signedUrl.pathname}${signedUrl.search}`);

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/signature/i);
  });

  it('returns 410 for an expired local signature', async () => {
    const key = 'missing/object.csv';
    const expires = String(Date.now() - 1000);
    const sig = crypto.createHmac('sha256', process.env.DOWNLOAD_SIGNING_SECRET)
      .update(`${key}.${expires}`)
      .digest('hex');
    const response = await supertest(app)
      .get('/api/uploads/local-download')
      .query({ key, expires, sig });

    expect(response.status).toBe(410);
    expect(response.body.message).toMatch(/expired/i);
  });
it('returns 403 for a link signed with the session secret', async () => {
  const key = 'missing/object.csv';
  const expires = String(Date.now() + 60_000);
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${key}.${expires}`).digest('hex');
  const response = await supertest(app).get('/api/uploads/local-download').query({ key, expires, sig });

  expect(response.status).toBe(403);
  expect(response.body.message).toMatch(/signature/i);
});

});
