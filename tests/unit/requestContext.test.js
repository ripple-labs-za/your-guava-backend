const { EventEmitter } = require('events');
const logger = require('../../src/utils/logger');
const { requestContext, requestLogger } = require('../../src/middleware/requestContext.middleware');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fakeResponse = (statusCode = 200) => {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.writableFinished = false;
  res.headers = {};
  res.getHeader = (name) => res.headers[name.toLowerCase()];
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  return res;
};
const fakeRequest = (headers = {}, extra = {}) => ({
  method: 'GET',
  originalUrl: '/api/health',
  get: (name) => headers[name.toLowerCase()],
  ...extra,
});

describe('requestContext', () => {
  it('issues its own id and keeps a well-formed client id beside it', () => {
    const req = fakeRequest({ 'x-request-id': 'client-supplied-id-001' });
    const res = fakeResponse();
    requestContext(req, res, () => {});
    expect(req.id).toMatch(UUID);
    expect(req.requestId).toBe(req.id);
    expect(req.clientRequestId).toBe('client-supplied-id-001');
    expect(res.headers['x-request-id']).toBe(req.id);
    expect(res.headers['x-client-request-id']).toBe('client-supplied-id-001');
  });

  it('drops a malformed client id', () => {
    const req = fakeRequest({ 'x-request-id': 'bad id with spaces' });
    const res = fakeResponse();
    requestContext(req, res, () => {});
    expect(req.clientRequestId).toBeUndefined();
    expect(res.headers['x-client-request-id']).toBeUndefined();
  });

  it('never lets two requests share a request id, whatever the client sends', () => {
    const first = fakeRequest({ 'x-request-id': 'same-client-id-01' });
    const second = fakeRequest({ 'x-request-id': 'same-client-id-01' });
    requestContext(first, fakeResponse(), () => {});
    requestContext(second, fakeResponse(), () => {});
    expect(first.id).not.toBe(second.id);
  });
});

describe('requestLogger', () => {
  const previous = {};
  beforeEach(() => {
    previous.NODE_ENV = process.env.NODE_ENV;
    previous.REQUEST_LOGS_ENABLED = process.env.REQUEST_LOGS_ENABLED;
    // Whatever logsEnabled() requires at card time (step 0) is set here.
    process.env.NODE_ENV = 'development';
    process.env.REQUEST_LOGS_ENABLED = 'true';
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  it('logs a request the client abandoned before the response finished', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const req = fakeRequest({}, { id: 'req-abort-1', method: 'POST', originalUrl: '/api/forecasts/insights/chat/stream?draft=1' });
    const res = fakeResponse();
    requestLogger(req, res, () => {});
    res.emit('close');
    expect(warn).toHaveBeenCalledWith('http_request_aborted', expect.objectContaining({
      requestId: 'req-abort-1',
      method: 'POST',
      path: '/api/forecasts/insights/chat/stream',
      aborted: true,
    }));
  });

  it('logs a completed request once, not again when the socket closes', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const res = fakeResponse(201);
    requestLogger(fakeRequest({}, { id: 'req-ok-1' }), res, () => {});
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('http_request', expect.objectContaining({ statusCode: 201, requestId: 'req-ok-1' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a 5xx at error level with the accepted client id', () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const res = fakeResponse(503);
    requestLogger(fakeRequest({}, { id: 'req-5xx', clientRequestId: 'client-abc-123', originalUrl: '/api/ready' }), res, () => {});
    res.emit('finish');
    expect(error).toHaveBeenCalledWith('http_request', expect.objectContaining({ statusCode: 503, clientRequestId: 'client-abc-123' }));
  });
});
