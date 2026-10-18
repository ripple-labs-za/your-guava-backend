const mockCreateState = jest.fn();
jest.mock('../../src/services/integrationOAuthState.service', () => ({
  createIntegrationOAuthState: (...args) => mockCreateState(...args),
  consumeIntegrationOAuthState: jest.fn(),
}));

const { getAuthUrl } = require('../../src/controllers/integrations.controller');

const XERO_ENV = {
  ACCOUNTING_INTEGRATIONS_ENABLED: 'true',
  XERO_CLIENT_ID: 'test-id',
  XERO_CLIENT_SECRET: 'test-secret',
  XERO_REDIRECT_URI: 'http://localhost:5185/integrations/xero/callback',
};

describe('integrations controller error handling', () => {
  let savedEnv;
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const req = { params: { provider: 'xero' }, user: { activeCafeId: 'cafe-1', cafeId: 'cafe-1', id: 'user-1' } };

  beforeEach(() => {
    savedEnv = { ...process.env };
    Object.assign(process.env, XERO_ENV);
    mockCreateState.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('hands an internal failure to the error middleware instead of echoing its message', async () => {
    const internal = new Error('Operation `integrationoauthstates.insertOne()` buffering timed out after 10000ms');
    mockCreateState.mockRejectedValue(internal);
    const res = response();
    const next = jest.fn();

    await getAuthUrl(req, res, next);

    expect(next).toHaveBeenCalledWith(internal);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('still names the missing setting when the provider is not configured', async () => {
    delete process.env.XERO_CLIENT_ID;
    mockCreateState.mockResolvedValue('state-1');
    const res = response();

    await getAuthUrl(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'INTEGRATION_NOT_CONFIGURED',
      message: expect.stringMatching(/XERO_CLIENT_ID/),
    }));
  });
});
