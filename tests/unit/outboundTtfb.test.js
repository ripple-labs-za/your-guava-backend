const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const followRedirects = require('follow-redirects');
const { outboundGet } = require('../../src/utils/http');

it('accepts a six-second time to first byte under a twenty-second total through real follow-redirects', async () => {
  const keys = ['OUTBOUND_CONNECT_TIMEOUT_MS', 'OUTBOUND_YOCO_TIMEOUT_MS'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.OUTBOUND_CONNECT_TIMEOUT_MS = '5000';
  process.env.OUTBOUND_YOCO_TIMEOUT_MS = '20000';
  const timers = [];
  let dataEvents = 0;
  let requests = 0;
  // Only the native https boundary is fake. Axios's Node adapter and the actual
  // follow-redirects response-header timer both run; no server or socket opens.
  const fakeHttps = {
    request(_options, onResponse) {
      requests++;
      const req = new EventEmitter();
      const socket = new EventEmitter();
      socket.setTimeout = () => socket;
      socket.setKeepAlive = () => socket;
      socket.destroy = () => {};
      req.write = () => true;
      req.end = () => {};
      req.abort = () => {};
      req.destroy = (error) => {
        if (error && req.listenerCount('error')) req.emit('error', error);
      };
      req.setHeader = () => {};
      req.removeHeader = () => {};
      req.getHeader = () => undefined;
      req.setTimeout = () => req;
      setImmediate(() => req.emit('socket', socket));
      timers.push(setInterval(() => {
        dataEvents++;
        socket.emit('data', Buffer.from('.'));
      }, 500));
      timers.push(setTimeout(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.headers = { 'content-type': 'application/json' };
        response.req = req;
        onResponse(response);
        response.end('{"ok":true}');
      }, 6000));
      return req;
    },
  };
  const start = Date.now();
  try {
    const response = await outboundGet('yoco', 'https://yoco.invalid/orders', {
      transport: followRedirects.wrap({ https: fakeHttps }).https,
      proxy: false,
    });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
    expect(requests).toBe(1);
    expect(dataEvents).toBeGreaterThanOrEqual(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5900);
  } finally {
    timers.forEach(clearTimeout);
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}, 25000);
