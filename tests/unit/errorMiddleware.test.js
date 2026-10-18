const logger = require('../../src/utils/logger');
const errorMiddleware = require('../../src/middleware/error.middleware');

const createResponse = () => {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
};

describe('error middleware', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.restoreAllMocks();
  });

  it('does not expose messages or details for production server errors', () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    const response = createResponse();

    errorMiddleware(
      Object.assign(new Error('provider secret leaked'), {
        statusCode: 502,
        details: { providerMessage: 'sensitive upstream response' },
      }),
      { id: 'request-1', method: 'GET', path: '/api/example' },
      response,
      jest.fn()
    );

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal Server Error',
      requestId: 'request-1',
    });
  });

  it('keeps a deliberately safe 5xx message in production when the thrower opts in', () => {
    // The blanket redaction is right for an unexpected 500 — a stack trace or a
    // provider body must never reach a browser. But asUpstreamAiError writes a
    // sentence specifically for the customer ("the AI service is temporarily
    // unavailable, no credits were charged"), and redacting it to "Internal
    // Server Error" left a cafe owner with no idea what happened and a
    // reasonable fear they had just been billed for nothing. Opt-in only, and
    // only ever set on a fixed string the product authored.
    process.env.NODE_ENV = 'production';
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    const response = createResponse();
    const friendly = 'The AI service is temporarily unavailable. No credits were charged — please try again shortly.';

    errorMiddleware(
      Object.assign(new Error(friendly), {
        statusCode: 503,
        exposeMessage: true,
        upstreamStatus: 401,
        upstreamMessage: 'authentication_error',
      }),
      { id: 'request-9', method: 'POST', path: '/api/forecasts/insights/chat' },
      response,
      jest.fn()
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: friendly,
      requestId: 'request-9',
    });
  });

  it('still redacts a 5xx that did not opt in, even alongside upstream detail', () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    const response = createResponse();

    errorMiddleware(
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:27017'), {
        statusCode: 500,
        upstreamStatus: 500,
      }),
      { id: 'request-10', method: 'GET', path: '/api/example' },
      response,
      jest.fn()
    );

    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal Server Error',
      requestId: 'request-10',
    });
  });

  it('logs upstream provider detail for wrapped AI failures without exposing it to the client', () => {
    process.env.NODE_ENV = 'development';
    const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const response = createResponse();
    const rawBody = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    const cause = Object.assign(new Error(`401 ${rawBody}`), {
      name: 'AuthenticationError',
      status: 401,
      error: JSON.parse(rawBody),
    });

    errorMiddleware(
      Object.assign(new Error('The AI service is temporarily unavailable.'), {
        statusCode: 503,
        upstreamStatus: 401,
        upstreamMessage: 'authentication_error: invalid x-api-key',
        cause,
      }),
      { id: 'request-2', method: 'POST', path: '/api/forecasts/insights/chat' },
      response,
      jest.fn()
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [event, entry] = logSpy.mock.calls[0];
    expect(event).toBe('request_error');
    expect(entry).toEqual(expect.objectContaining({
      statusCode: 503,
      upstreamStatus: 401,
      upstreamMessage: 'authentication_error: invalid x-api-key',
    }));
    expect(Object.values(entry).join('\n')).not.toContain(rawBody);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'The AI service is temporarily unavailable.',
      requestId: 'request-2',
    });
  });

  it('omits upstream fields from the log when an error carries none', () => {
    const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    errorMiddleware(
      new Error('boom'),
      { method: 'GET', path: '/api/example' },
      createResponse(),
      jest.fn()
    );

    const [event, entry] = logSpy.mock.calls[0];
    expect(event).toBe('request_error');
    expect(entry).not.toHaveProperty('upstreamStatus');
    expect(entry).not.toHaveProperty('upstreamMessage');
  });

  it('preserves structured details for expected client errors', () => {
    process.env.NODE_ENV = 'production';
    const response = createResponse();

    errorMiddleware(
      Object.assign(new Error('Invalid request'), {
        statusCode: 400,
        details: { code: 'INVALID_REQUEST' },
      }),
      { method: 'POST', path: '/api/example' },
      response,
      jest.fn()
    );

    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: 'Invalid request',
      details: { code: 'INVALID_REQUEST' },
    });
  });

  it('exposes a product-authored public code', () => {
    const response = createResponse();
    errorMiddleware(Object.assign(new Error('Fix the mapping.'), { statusCode: 422, publicCode: 'SEVERE_PARTIAL_IMPORT', details: { errors: 12 } }),
      { id: 'r1', method: 'POST', path: '/api/uploads/x/confirm' }, response, jest.fn());
    expect(response.status).toHaveBeenCalledWith(422);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SEVERE_PARTIAL_IMPORT', details: { errors: 12 } }));
  });

  it('never exposes a library error code', () => {
    const response = createResponse();
    errorMiddleware(Object.assign(new Error('Stored upload not found'), { statusCode: 404, code: 'ENOENT' }),
      { id: 'r2', method: 'GET', path: '/api/uploads/local-download' }, response, jest.fn());
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('code');
  });

  it('refuses a malformed public code', () => {
    const response = createResponse();
    errorMiddleware(Object.assign(new Error('x'), { statusCode: 400, publicCode: 'lower-case <script>' }),
      { id: 'r3', method: 'GET', path: '/x' }, response, jest.fn());
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('code');
  });
it('keeps an opted-in AI error code and retry hint in production', () => {
  process.env.NODE_ENV = 'production';
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  const response = createResponse();
  const friendly = 'The AI service is busy right now. No credits were charged. Try again in a minute.';

  errorMiddleware(
    Object.assign(new Error(friendly), {
      statusCode: 503,
      exposeMessage: true,
      exposeDetails: true,
      details: { code: 'AI_PROVIDER_BUSY', retryable: true, retryAfterSeconds: 30 },
    }),
    { id: 'request-11', method: 'POST', path: '/api/forecasts/insights/chat' },
    response,
    jest.fn()
  );

  expect(response.json).toHaveBeenCalledWith({
    success: false,
    message: friendly,
    requestId: 'request-11',
    details: { code: 'AI_PROVIDER_BUSY', retryable: true, retryAfterSeconds: 30 },
  });
});

});

it('logs an error\'s logContext as context and never sends it to the client', () => {
  const logSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  const response = createResponse();
  errorMiddleware(
    Object.assign(new Error('We could not save this file on our server.'), {
      statusCode: 500,
      exposeMessage: true,
      logContext: { stage: 'upload_storage', code: 'ENOSPC', cause: "ENOSPC: no space left on device, open '/app/uploads/x.csv'" },
    }),
    { id: 'request-ctx', method: 'POST', path: '/upload' },
    response,
    jest.fn()
  );
  expect(logSpy.mock.calls[0][1].context).toMatchObject({ code: 'ENOSPC' });
  expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('ENOSPC');
});
