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
for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
  delete process.env[key];
}
r2._resetClient();

describe('local signed downloads', () => {
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
