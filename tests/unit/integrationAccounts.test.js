jest.mock('axios');
const axios = require('axios');
const xero = require('../../src/services/integrations/xero.service');
const quickbooks = require('../../src/services/integrations/quickbooks.service');
const sage = require('../../src/services/integrations/sage.service');

describe('accounting providers verify accounts before keeping a grant', () => {
  let saved;
  beforeEach(() => {
    saved = { ...process.env };
    for (const prefix of ['XERO', 'QUICKBOOKS', 'SAGE']) {
      process.env[`${prefix}_CLIENT_ID`] = 'test-client';
      process.env[`${prefix}_CLIENT_SECRET`] = 'test-secret';
      process.env[`${prefix}_REDIRECT_URI`] = 'http://localhost:5185/callback';
    }
    axios.get.mockReset();
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { access_token: 'access', refresh_token: 'refresh', expires_in: 1800 } });
  });
  afterEach(() => { process.env = saved; jest.restoreAllMocks(); });

  it('verifies a QuickBooks realm with the new access token', async () => {
    axios.get.mockResolvedValue({ data: { CompanyInfo: { Id: 'realm-1' } } });
    await expect(quickbooks.exchangeCodeForTokens('code', { realmId: 'realm-1' })).resolves.toMatchObject({ realmId: 'realm-1' });
    expect(axios.get).toHaveBeenCalledWith(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/realm-1/companyinfo/realm-1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer access' }) })
    );
  });

  it('refuses a QuickBooks realm the token cannot read and revokes its unused grant', async () => {
    axios.get.mockRejectedValue({ response: { status: 403 } });
    await expect(quickbooks.exchangeCodeForTokens('code', { realmId: 'realm-2' }))
      .rejects.toMatchObject({ publicCode: 'INTEGRATION_ACCOUNT_MISMATCH' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://developer.api.intuit.com/v2/oauth2/tokens/revoke', { token: 'refresh' }, expect.anything()
    );
  });

  it('refuses ambiguous Sage businesses and revokes its unused grant', async () => {
    axios.get.mockResolvedValue({ data: { $items: [{ id: 'one' }, { id: 'two' }] } });
    await expect(sage.exchangeCodeForTokens('code')).rejects.toMatchObject({ publicCode: 'INTEGRATION_ACCOUNT_CHOICE_REQUIRED' });
    expect(axios.post).toHaveBeenCalledWith('https://oauth.accounting.sage.com/revoke',
      expect.stringContaining('token=refresh'), expect.anything());
  });

  it('keeps the Sage business that the provider lists for the access token', async () => {
    axios.get.mockResolvedValue({ data: [{ id: 'business-1' }] });
    await expect(sage.exchangeCodeForTokens('code', { businessId: 'business-1' }))
      .resolves.toMatchObject({ businessId: 'business-1' });
    expect(axios.get).toHaveBeenCalledWith('https://api.accounting.sage.com/v3.1/businesses', expect.anything());
  });

  it('does not silently keep a Xero grant when its account lookup fails', async () => {
    axios.get.mockRejectedValue(new Error('lookup unavailable'));
    await expect(xero.exchangeCodeForTokens('code')).rejects.toThrow('lookup unavailable');
    expect(axios.post).toHaveBeenCalledWith('https://identity.xero.com/connect/revocation',
      expect.stringContaining('token=refresh'), expect.anything());
  });
});
