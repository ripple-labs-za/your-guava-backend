jest.mock('axios');
const axios = require('axios');
const oneGate = require('../../src/services/onegate.service');

describe('OneGate runtime configuration', () => {
  let nodeEnv;

  beforeEach(() => {
    nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    if (nodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  });

  it('accepts only the credential-free official HTTPS origin in production', () => {
    expect(oneGate.cleanBaseUrl('https://payments.onegate.co.za/'))
      .toBe('https://payments.onegate.co.za');
    expect(() => oneGate.cleanBaseUrl('http://payments.onegate.co.za'))
      .toThrow(/HTTPS/i);
    expect(() => oneGate.cleanBaseUrl('https://payments.attacker.example'))
      .toThrow(/official OneGate/i);
    expect(() => oneGate.cleanBaseUrl('https://user:secret@payments.onegate.co.za'))
      .toThrow(/credentials/i);
  });
});

describe('OneGate provider failures', () => {
  let savedEnv;
  const providerFailure = (status, data) => Object.assign(
    new Error(`Request failed with status code ${status}`),
    { isAxiosError: true, response: { status, data } }
  );

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.NODE_ENV = 'test';
    process.env.ONEGATE_ORGANISATION_ID = '21234';
    process.env.ONEGATE_API_SALT = 'test-salt';
    process.env.API_PUBLIC_URL = 'https://api.yourguava.invalid';
    delete process.env.ONEGATE_API_URL;
    axios.get.mockReset();
    axios.post.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('answers a OneGate 401 with 502 and a code, never with 401 or the provider text', async () => {
    axios.post.mockRejectedValue(providerFailure(401, { message: 'Invalid salt for organisation 21234' }));
    const error = await oneGate.createPaymentKey({ reference: 'GGC1', amount: 69 }).catch((caught) => caught);
    expect(error).toMatchObject({
      statusCode: 502,
      publicCode: 'UPSTREAM_AUTH_FAILED',
      exposeMessage: true,
      upstreamStatus: 401,
    });
    expect(error.message).not.toMatch(/salt|21234/);
  });

  it('wraps a failed gateway lookup the same way instead of letting axios through', async () => {
    axios.get.mockRejectedValue(providerFailure(500, { message: 'gateway exploded' }));
    await expect(oneGate.lookupGatewayTransaction('GGC1'))
      .rejects.toMatchObject({ statusCode: 502, publicCode: 'UPSTREAM_ERROR', upstreamStatus: 500 });
  });
});
