// Ask Guava's answer comes from this mock; the cases below only care where the answer is saved.
const mockAnthropicMessageCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

// Express 5 (router 2.x) layers keep only a compiled matcher: record the path each layer was declared with,
// so the guards below can see a :param on middleware (app.use('/api/x/:id', fn), router.use('/:id', fn)).
jest.mock('router/lib/layer', () => {
  const ActualLayer = jest.requireActual('router/lib/layer');
  function RecordingLayer(declaredPath, options, fn) {
    const layer = new ActualLayer(declaredPath, options, fn);
    layer.declaredPath = declaredPath;
    return layer;
  }
  RecordingLayer.prototype = ActualLayer.prototype;
  return RecordingLayer;
});

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const supertest = require('supertest');
const { setup, teardown, createTestUser, createTestManager, app } = require('../setup');
const emailService = require('../../src/services/email.service');
const Cafe = require('../../src/models/Cafe.model');
const Event = require('../../src/models/Event.model');
const Improvement = require('../../src/models/Improvement.model');
const InsightChat = require('../../src/models/InsightChat.model');
const Item = require('../../src/models/Item.model');
const LeaveBalance = require('../../src/models/LeaveBalance.model');
const LeaveRequest = require('../../src/models/LeaveRequest.model');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const Shift = require('../../src/models/Shift.model');
const Staff = require('../../src/models/Staff.model');
const TeamInvitation = require('../../src/models/TeamInvitation.model');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const User = require('../../src/models/User.model');
const { waitFor } = require('../helpers/waitFor');

const request = supertest(app);
const SRC = path.join(__dirname, '..', '..', 'src');
const REFUSED = [403, 404];

// ---------------------------------------------------------------------------
// The route table. Mount prefixes come from src/app.js; route paths come from each router's own stack.
// Express 5 layers do not keep the mount path, so app.js is parsed; every routes file must be found.
// ---------------------------------------------------------------------------
// A commented-out mount is not a mount: drop block comments and whole-line // comments before matching.
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const collectMounts = () => {
  const source = withoutComments(fs.readFileSync(path.join(SRC, 'app.js'), 'utf8'));
  const requires = new Map();
  for (const m of source.matchAll(/const (\w+) = require\('\.\/routes\/([\w.]+)'\)/g)) requires.set(m[1], m[2]);
  const mounts = [];
  for (const m of source.matchAll(/app\.use\(\s*'(\/api\/[\w-]+)'\s*,\s*(?:require\('\.\/routes\/([\w.]+)'\)|(\w+))\s*\)/g)) {
    const file = m[2] || requires.get(m[3]);
    if (file) mounts.push({ prefix: m[1], file: file.endsWith('.js') ? file : `${file}.js` });
  }
  return mounts;
};

const collectIdRoutes = () => {
  const routes = [];
  for (const { prefix, file } of collectMounts()) {
    const router = require(path.join(SRC, 'routes', file));
    for (const layer of router.stack) {
      if (!layer.route || !layer.route.path.includes(':')) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      }
    }
  }
  return [...new Set(routes)].sort();
};

expect.extend({
  toBeOneOf(received, list) {
    const pass = list.includes(received);
    return { pass, message: () => `expected ${received} ${pass ? 'not ' : ''}to be one of ${list.join(', ')}` };
  },
});

// ---------------------------------------------------------------------------
// The world: a victim organisation with cafes A1 and A2, a manager assigned only to A2, and an attacker organisation.
// ---------------------------------------------------------------------------
const world = {};
let serial = 0;
const unique = (prefix) => `${prefix}-${(serial += 1)}`;

const as = (token) => ({
  get: (url) => request.get(url).set('Authorization', `Bearer ${token}`),
  post: (url) => request.post(url).set('Authorization', `Bearer ${token}`),
  put: (url) => request.put(url).set('Authorization', `Bearer ${token}`),
  patch: (url) => request.patch(url).set('Authorization', `Bearer ${token}`),
  delete: (url) => request.delete(url).set('Authorization', `Bearer ${token}`),
});
const client = (role) => as(world[role].token);

// Setup requests must succeed; a failed fixture would make every refusal below meaningless.
const made = (res, pick) => {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`fixture request failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return pick(res.body);
};

const YOCO_HEADER = 'Receipt,Date,Time,Status,Payment Method,Order Number,Card Reader,Items,Note,Currency,Tip,Discount,VAT,'
  + 'Total (incl. tax),Fee Amount,Net Amount';
const yocoCsv = (receipt) => Buffer.from([
  YOCO_HEADER,
  `${receipt},2026/01/15,09:30:00,Approved,Credit Card,#0001,12345,1 x Flat White (Blend),,ZAR,0.0,0.0,0.0,48.0,1.5,46.5`,
].join('\n'));

beforeAll(async () => {
  await setup();
  jest.spyOn(emailService, 'sendTeamInviteEmail').mockResolvedValue({ sent: true });

  world.victim = await createTestUser({ email: 'victim-owner@yourguava.com', cafeName: 'Victim Cafe A1', orgName: 'Victim Org' });
  world.attacker = await createTestUser({ email: 'attacker-owner@yourguava.com', cafeName: 'Attacker Cafe', orgName: 'Attacker Org' });
  // Plan limits are not under test here; give both organisations room for every fixture.
  await Organization.updateMany({}, { $set: { plan: 'pro' } });
  world.cafeA1 = String(world.victim.user.activeCafeId);
  world.attackerCafe = String(world.attacker.user.activeCafeId);
  world.cafeA2 = made(
    await client('victim').post('/api/team/add-cafe').send({ name: 'Victim Cafe A2' }),
    (body) => String(body.cafe._id)
  );
  world.manager = await createTestManager(world.victim.token, [world.cafeA2]);
});

afterAll(async () => {
  jest.restoreAllMocks();
  await teardown();
});

const make = {
  event: async () => ({ id: made(await client('victim').post('/api/events')
    .send({ name: unique('Victim Event'), date: '2026-12-01' }), (b) => b.event._id) }),
  improvement: async () => ({ id: made(await client('victim').post('/api/improvements').send({
    type: 'fix', title: unique('Victim ticket'), area: 'planning', priority: 'high',
    description: 'Victim description', desiredOutcome: 'Victim outcome',
  }), (b) => b.improvement._id) }),
  chat: async () => ({ id: made(await client('victim').post('/api/insight-chats')
    .send({ messages: [{ role: 'user', content: 'Victim question' }] }), (b) => b.chat._id) }),
  item: async () => ({ id: made(await client('victim').post('/api/items')
    .send({ name: unique('Victim Latte'), category: 'coffee', expectedPrice: 38 }), (b) => b.item._id) }),
  staff: async () => ({ id: made(await client('victim').post('/api/staff')
    .send({ name: unique('Victim Barista'), hourlyRate: 55, role: 'barista' }), (b) => b.staff._id) }),
  shift: async () => {
    const staff = await make.staff();
    return { id: made(await client('victim').post('/api/shifts')
      .send({ staffId: staff.id, date: '2026-10-05', startTime: '07:00', endTime: '15:00' }), (b) => b.shift._id) };
  },
  leave: async () => {
    const staff = await make.staff();
    return { id: made(await client('victim').post('/api/leave')
      .send({ staffId: staff.id, type: 'annual', startDate: '2026-10-12', endDate: '2026-10-13' }), (b) => b.leaveRequest._id) };
  },
  member: async () => {
    const user = await User.create({
      name: unique('Victim Member'), email: `${unique('victim-member')}@yourguava.com`, password: 'password123',
      role: 'manager', orgId: world.victim.user.orgId, cafeIds: [world.cafeA1], activeCafeId: world.cafeA1,
    });
    return { id: String(user._id) };
  },
  invitation: async () => ({ id: made(await client('victim').post('/api/team/invite').send({
    name: 'Victim Invitee', email: `${unique('victim-invitee')}@yourguava.com`, cafeIds: [world.cafeA1],
  }), (b) => b.invitation.id) }),
  payment: async () => {
    const reference = unique('victim-payment-ref');
    await PaymentSession.create({
      orgId: world.victim.user.orgId, userId: world.victim.user.id, provider: 'onegate', kind: 'credits',
      reference, amount: 99, currency: 'ZAR', credits: 500,
    });
    return { id: reference };
  },
  upload: async () => {
    const res = await client('victim').post('/api/transactions/upload')
      .attach('file', yocoCsv(unique('VICTIM')), `${unique('victim')}.csv`);
    return made(res, (b) => ({ id: b.uploadId, columnMapping: b.columnMapping, itemsMode: b.itemsMode }));
  },
  // A fresh location each time: A1 and A2 must stay active (A2 is the manager's only cafe, which archive refuses with 409).
  cafe: async () => ({ id: made(await client('victim').post('/api/team/add-cafe')
    .send({ name: unique('Victim Cafe') }), (b) => String(b.cafe._id)) }),
  archivedCafe: async () => {
    const cafe = await make.cafe();
    made(await client('victim').post(`/api/team/cafes/${cafe.id}/archive`).send({}), (b) => b);
    return cafe;
  },
};

const byId = (Model, select) => (target) => {
  const query = Model.findById(target.id);
  return (select ? query.select(select) : query).lean();
};

// route → { make, owner (owner-only), control ('success' = 2xx, 'reachable' = anything but 403/404), send(c, target, role), snap(target) }
const MATRIX = {
  'GET /api/account/payments/:reference': { make: 'payment', owner: true, control: 'success',
    send: (c, t) => c.get(`/api/account/payments/${t.id}`), snap: (t) => PaymentSession.findOne({ reference: t.id }).lean() },
  'POST /api/team/cafes/:cafeId/archive': { make: 'cafe', owner: true, control: 'success',
    send: (c, t) => c.post(`/api/team/cafes/${t.id}/archive`).send({}), snap: byId(Cafe) },
  'POST /api/team/cafes/:cafeId/restore': { make: 'archivedCafe', owner: true, control: 'success',
    send: (c, t) => c.post(`/api/team/cafes/${t.id}/restore`).send({}), snap: byId(Cafe) },
  'GET /api/uploads/:id/overlaps': { make: 'upload', control: 'reachable',
    send: (c, t) => c.get(`/api/uploads/${t.id}/overlaps`), snap: byId(Upload) },
  'PUT /api/events/:id': { make: 'event', control: 'success',
    send: (c, t) => c.put(`/api/events/${t.id}`).send({ name: 'Renamed Event' }), snap: byId(Event) },
  'DELETE /api/events/:id': { make: 'event', control: 'success',
    send: (c, t) => c.delete(`/api/events/${t.id}`), snap: byId(Event) },
  'GET /api/improvements/:id': { make: 'improvement', control: 'success',
    send: (c, t) => c.get(`/api/improvements/${t.id}`), snap: byId(Improvement) },
  'PATCH /api/improvements/:id/status': { make: 'improvement', owner: true, control: 'success',
    send: (c, t) => c.patch(`/api/improvements/${t.id}/status`).send({ status: 'planned' }), snap: byId(Improvement) },
  'DELETE /api/improvements/:id': { make: 'improvement', owner: true, control: 'success',
    send: (c, t) => c.delete(`/api/improvements/${t.id}`), snap: byId(Improvement) },
  'GET /api/insight-chats/:id': { make: 'chat', control: 'success',
    send: (c, t) => c.get(`/api/insight-chats/${t.id}`), snap: byId(InsightChat) },
  'PATCH /api/insight-chats/:id': { make: 'chat', control: 'success',
    send: (c, t) => c.patch(`/api/insight-chats/${t.id}`).send({ title: 'Renamed chat' }), snap: byId(InsightChat) },
  'DELETE /api/insight-chats/:id': { make: 'chat', control: 'success',
    send: (c, t) => c.delete(`/api/insight-chats/${t.id}`), snap: byId(InsightChat) },
  'PUT /api/items/:id': { make: 'item', control: 'success',
    send: (c, t) => c.put(`/api/items/${t.id}`).send({ name: unique('Renamed Latte') }), snap: byId(Item) },
  'POST /api/items/:id/resolve': { make: 'item', control: 'success',
    send: (c, t) => c.post(`/api/items/${t.id}/resolve`).send({ action: 'confirm' }), snap: byId(Item) },
  'PUT /api/leave/:id/approve': { make: 'leave', owner: true, control: 'success',
    send: (c, t) => c.put(`/api/leave/${t.id}/approve`).send({}), snap: byId(LeaveRequest) },
  'PUT /api/leave/:id/reject': { make: 'leave', owner: true, control: 'success',
    send: (c, t) => c.put(`/api/leave/${t.id}/reject`).send({}), snap: byId(LeaveRequest) },
  'PUT /api/leave/:id/cancel': { make: 'leave', owner: true, control: 'reachable',
    send: (c, t) => c.put(`/api/leave/${t.id}/cancel`).send({ reason: 'Cross-tenant probe' }), snap: byId(LeaveRequest) },
  'PUT /api/leave/balances/:staffId': { make: 'staff', owner: true, control: 'success',
    send: (c, t) => c.put(`/api/leave/balances/${t.id}`).send({ type: 'annual', total: 20, reason: 'Cross-tenant probe' }),
    snap: (t) => LeaveBalance.find({ staffId: t.id }).sort({ _id: 1 }).lean() },
  'PUT /api/shifts/:id': { make: 'shift', control: 'success',
    send: (c, t) => c.put(`/api/shifts/${t.id}`).send({ startTime: '08:00', endTime: '16:00' }), snap: byId(Shift) },
  'DELETE /api/shifts/:id': { make: 'shift', control: 'success',
    send: (c, t) => c.delete(`/api/shifts/${t.id}`), snap: byId(Shift) },
  'GET /api/staff/:id': { make: 'staff', control: 'success',
    send: (c, t) => c.get(`/api/staff/${t.id}`), snap: byId(Staff) },
  'PUT /api/staff/:id': { make: 'staff', owner: true, control: 'success',
    send: (c, t) => c.put(`/api/staff/${t.id}`).send({ name: 'Renamed Barista' }), snap: byId(Staff) },
  'DELETE /api/staff/:id': { make: 'staff', owner: true, control: 'success',
    send: (c, t) => c.delete(`/api/staff/${t.id}`), snap: byId(Staff) },
  'POST /api/team/invitations/:invitationId/resend': { make: 'invitation', owner: true, control: 'success',
    send: (c, t) => c.post(`/api/team/invitations/${t.id}/resend`).send({}), snap: byId(TeamInvitation, '+tokenHash') },
  'DELETE /api/team/invitations/:invitationId': { make: 'invitation', owner: true, control: 'success',
    send: (c, t) => c.delete(`/api/team/invitations/${t.id}`), snap: byId(TeamInvitation, '+tokenHash') },
  'DELETE /api/team/:userId': { make: 'member', owner: true, control: 'success',
    send: (c, t) => c.delete(`/api/team/${t.id}`), snap: byId(User) },
  'PATCH /api/team/:userId': { make: 'member', owner: true, control: 'success',
    send: (c, t) => c.patch(`/api/team/${t.id}`).send({ name: 'Renamed Member' }), snap: byId(User) },
  'PUT /api/team/:userId/cafes': { make: 'member', owner: true, control: 'success',
    send: (c, t, role) => c.put(`/api/team/${t.id}/cafes`)
      .send({ cafeIds: role === 'victim' ? [world.cafeA1, world.cafeA2] : [world.attackerCafe] }),
    snap: byId(User) },
  'GET /api/uploads/:id': { make: 'upload', control: 'success',
    send: (c, t) => c.get(`/api/uploads/${t.id}`), snap: byId(Upload) },
  'GET /api/uploads/:id/rows': { make: 'upload', control: 'reachable',
    send: (c, t) => c.get(`/api/uploads/${t.id}/rows`), snap: byId(Upload) },
  'POST /api/uploads/:id/confirm': { make: 'upload', control: 'success',
    send: (c, t) => c.post(`/api/uploads/${t.id}/confirm`).send({ columnMapping: t.columnMapping, itemsMode: t.itemsMode }),
    snap: byId(Upload) },
  'PATCH /api/uploads/:id/mapping': { make: 'upload', control: 'reachable',
    send: (c, t) => c.patch(`/api/uploads/${t.id}/mapping`).send({ columnMapping: t.columnMapping, itemsMode: t.itemsMode }),
    snap: byId(Upload) },
  'DELETE /api/uploads/:id': { make: 'upload', owner: true, control: 'success',
    send: (c, t) => c.delete(`/api/uploads/${t.id}`), snap: byId(Upload) },
};

const PROVIDER_ROUTE = 'the parameter is a provider name (xero, quickbooks, sage); the handler acts on the caller\'s own cafe';
const EXEMPT = {
  'GET /api/integrations/:provider/auth': PROVIDER_ROUTE,
  'POST /api/integrations/:provider/callback': PROVIDER_ROUTE,
  'POST /api/integrations/:provider/sync': PROVIDER_ROUTE,
  'POST /api/integrations/:provider/disconnect': PROVIDER_ROUTE,
};

describe('route table', () => {
  it('finds every routes file mounted in app.js', () => {
    const mounted = collectMounts().map((m) => m.file).sort();
    const files = fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.routes.js')).sort();
    expect(mounted).toEqual(files);
  });

  // The running app is the authority; app.js is parsed only for the mount prefixes (BE-12-T02 round 1).
  // A mount behind a flag that tests/env.js leaves off is not live here, so it must have no :param route.
  const FLAG_GATED = {
    'yoco.routes.js': 'YOCO_INTEGRATION_ENABLED is off in tests/env.js (production keeps the legacy routes off too)',
  };
  const routerOf = (file) => require(path.join(SRC, 'routes', file));
  const liveRouterLayers = () => app.router.stack.filter((layer) => layer.handle && Array.isArray(layer.handle.stack));

  it('matches the parsed mounts with the routers the running app has mounted, both ways', () => {
    const live = liveRouterLayers().map((layer) => layer.handle);
    const parsed = collectMounts();
    for (const { file } of parsed) {
      const router = routerOf(file);
      const mounted = live.includes(router);
      const gatedWithoutParams = Boolean(FLAG_GATED[file])
        && !router.stack.some((layer) => layer.route && layer.route.path.includes(':'));
      expect({ file, mountedOrGatedWithoutParams: mounted || gatedWithoutParams })
        .toEqual({ file, mountedOrGatedWithoutParams: true });
    }
    const parsedRouters = parsed.map(({ file }) => routerOf(file));
    expect(live.filter((router) => !parsedRouters.includes(router))).toHaveLength(0);
  });

  // A declared path with a :param (a string with ':', a RegExp, or an array holding either).
  const declaresParam = (declared) => (Array.isArray(declared)
    ? declared.some(declaresParam)
    : declared instanceof RegExp || (typeof declared === 'string' && declared.includes(':')));

  it('finds no router nested inside a mounted router, and no middleware on a :param path in one', () => {
    const offending = collectMounts().flatMap(({ prefix, file }) => routerOf(file).stack
      .filter((layer) => (layer.handle && Array.isArray(layer.handle.stack)) || (!layer.route && declaresParam(layer.declaredPath)))
      .map((layer) => `${prefix} (${file}) ${String(layer.declaredPath)}`));
    expect(offending).toEqual([]);
  });

  it('finds no app-level route or middleware with a :param (it would bypass the routers this suite reads)', () => {
    // Every layer was built through RecordingLayer; a missing declaredPath means the guard went blind.
    expect(app.router.stack.every((layer) => layer.declaredPath !== undefined)).toBe(true);
    const appLevel = app.router.stack
      .filter((layer) => declaresParam(layer.declaredPath) || (layer.route && layer.route.path.includes(':')))
      .map((layer) => String(layer.declaredPath));
    expect(appLevel).toEqual([]);
  });

  it('covers every id-addressed route in the route table (a new route fails until it is added here)', () => {
    expect(collectIdRoutes()).toEqual([...Object.keys(MATRIX), ...Object.keys(EXEMPT)].sort());
  });
});

describe('id-addressed routes refuse other tenants', () => {
  for (const [route, spec] of Object.entries(MATRIX)) {
    it(`${route} refuses another organisation and another cafe`, async () => {
      const target = await make[spec.make]();
      const before = await spec.snap(target);
      expect(before).toBeTruthy();

      const fromOtherOrg = await spec.send(client('attacker'), target, 'attacker');
      const fromOtherCafe = await spec.send(client('manager'), target, 'manager');

      expect({ route, attacker: 'another organisation', status: fromOtherOrg.status })
        .toEqual({ route, attacker: 'another organisation', status: expect.toBeOneOf(REFUSED) });
      expect({ route, attacker: 'another cafe', status: fromOtherCafe.status })
        .toEqual({ route, attacker: 'another cafe', status: expect.toBeOneOf(REFUSED) });
      expect(await spec.snap(target)).toEqual(before);

      // The victim's own request must reach the resource, or the refusals above prove nothing.
      const control = await spec.send(client('victim'), target, 'victim');
      const controlOk = spec.control === 'success'
        ? control.status >= 200 && control.status < 300
        : !REFUSED.includes(control.status);
      expect({ route, control: control.status, ok: controlOk }).toEqual({ route, control: control.status, ok: true });
    });
  }
});

describe('ids in request bodies refuse other tenants', () => {
  const REFUSED_BODY = [400, 403, 404];

  it('POST /api/team/switch-cafe refuses another organisation\'s cafe', async () => {
    const before = await User.findById(world.attacker.user.id).select('activeCafeId cafeIds').lean();
    const res = await client('attacker').post('/api/team/switch-cafe').send({ cafeId: world.cafeA1 });
    expect(REFUSED_BODY).toContain(res.status);
    expect(await User.findById(world.attacker.user.id).select('activeCafeId cafeIds').lean()).toEqual(before);
  });

  it('POST /api/team/switch-cafe refuses a manager a cafe they are not assigned to', async () => {
    const before = await User.findById(world.manager.user.id).select('activeCafeId cafeIds').lean();
    const res = await client('manager').post('/api/team/switch-cafe').send({ cafeId: world.cafeA1 });
    expect(REFUSED_BODY).toContain(res.status);
    expect(await User.findById(world.manager.user.id).select('activeCafeId cafeIds').lean()).toEqual(before);
  });

  it('PUT /api/team/:userId/cafes refuses to assign the attacker\'s own manager to another organisation\'s cafe', async () => {
    const member = await User.create({
      name: 'Attacker Member', email: `${unique('attacker-member')}@yourguava.com`, password: 'password123',
      role: 'manager', orgId: world.attacker.user.orgId, cafeIds: [world.attackerCafe], activeCafeId: world.attackerCafe,
    });
    const res = await client('attacker').put(`/api/team/${member._id}/cafes`).send({ cafeIds: [world.cafeA1] });
    expect(REFUSED_BODY).toContain(res.status);
    expect((await User.findById(member._id).lean()).cafeIds.map(String)).toEqual([world.attackerCafe]);
  });

  it('POST /api/team/transfer-ownership refuses to hand the attacker\'s organisation to another organisation\'s manager', async () => {
    const victimManager = await User.findById(world.manager.user.id).select('role orgId').lean();
    const res = await client('attacker').post('/api/team/transfer-ownership')
      .send({ userId: world.manager.user.id, currentPassword: 'password123' });
    expect(REFUSED_BODY).toContain(res.status);
    expect(await User.findById(world.manager.user.id).select('role orgId').lean()).toEqual(victimManager);
    expect((await User.findById(world.attacker.user.id).lean()).role).toBe('owner');
  });

  it('POST /api/team/invite refuses to invite into another organisation\'s cafe', async () => {
    const before = await TeamInvitation.countDocuments({ orgId: world.attacker.user.orgId });
    const res = await client('attacker').post('/api/team/invite')
      .send({ name: 'Probe', email: `${unique('probe')}@yourguava.com`, cafeIds: [world.cafeA1] });
    expect(REFUSED_BODY).toContain(res.status);
    expect(await TeamInvitation.countDocuments({ orgId: world.attacker.user.orgId })).toBe(before);
  });

  it('POST /api/items/:id/resolve refuses to map onto another organisation\'s item', async () => {
    const victimItem = await make.item();
    const own = made(await client('attacker').post('/api/items')
      .send({ name: unique('Attacker Latte'), category: 'coffee', expectedPrice: 38 }), (b) => b.item._id);
    const beforeVictim = await Item.findById(victimItem.id).lean();
    const res = await client('attacker').post(`/api/items/${own}/resolve`)
      .send({ action: 'map_to', targetItemId: victimItem.id });
    expect(REFUSED_BODY).toContain(res.status);
    expect(await Item.findById(victimItem.id).lean()).toEqual(beforeVictim);
  });

  it('POST /api/shifts refuses another organisation\'s staff member', async () => {
    const staff = await make.staff();
    const res = await client('attacker').post('/api/shifts')
      .send({ staffId: staff.id, date: '2026-10-06', startTime: '07:00', endTime: '15:00' });
    expect(REFUSED_BODY).toContain(res.status);
    expect(await Shift.countDocuments({ staffId: staff.id })).toBe(0);
  });

  it('POST /api/leave refuses another organisation\'s staff member', async () => {
    const staff = await make.staff();
    const res = await client('attacker').post('/api/leave')
      .send({ staffId: staff.id, type: 'annual', startDate: '2026-10-19', endDate: '2026-10-20' });
    expect(REFUSED_BODY).toContain(res.status);
    expect(await LeaveRequest.countDocuments({ staffId: staff.id })).toBe(0);
  });

  it('POST /api/items/reconciliation/suggestions never returns another organisation\'s item', async () => {
    const victimItem = await make.item();
    const victimDoc = await Item.findById(victimItem.id).lean();
    const res = await client('attacker').post('/api/items/reconciliation/suggestions')
      .set('Idempotency-Key', unique('cross-tenant-suggestions'))
      .send({ itemIds: [victimItem.id] });
    expect(JSON.stringify(res.body)).not.toContain(String(victimItem.id));
    expect(JSON.stringify(res.body)).not.toContain(victimDoc.name);
    expect(await Item.findById(victimItem.id).lean()).toEqual(victimDoc);
  });

  // BE-12-T02 round 1 (reviewer-b90-3): four more id entry points, scoped today and now pinned.
  it("POST /api/auth/refresh keeps the attacker's own cafe when the body asks for another organisation's", async () => {
    // The refresh itself succeeds; the requested cafe is ignored because it is not one of the attacker's.
    const res = await request.post('/api/auth/refresh').set('Cookie', world.attacker.cookie).send({ cafeId: world.cafeA1 });
    expect(res.status).toBe(200);
    expect(res.body.cafeId).toBe(world.attackerCafe);
    expect(jwt.decode(res.body.accessToken).cafeId).toBe(world.attackerCafe);
  });

  it("Ask Guava, plain and streamed, never saves into another organisation's chat", async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    try {
      await Transaction.create({
        cafeId: world.attackerCafe, receiptId: unique('attacker-sale'), date: new Date(Date.now() - 3_600_000),
        status: 'approved', total: 45, items: [{ name: 'Flat White', quantity: 1, unitPrice: 45 }],
      });
      // The plain endpoint asks for one message, the stream endpoint for events: answer each in its shape.
      mockAnthropicMessageCreate.mockImplementation((params) => Promise.resolve(params && params.stream ? {
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { id: 'msg_ct', model: 'test-model', usage: { input_tokens: 10 } } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Saturdays are busiest.' } };
          yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } };
          yield { type: 'message_stop' };
        },
      } : {
        id: 'msg_ct', model: 'test-model', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Saturdays are busiest.' }], usage: { input_tokens: 10, output_tokens: 5 },
      }));
      const victimChat = await make.chat();
      const before = await InsightChat.findById(victimChat.id).lean();
      const messages = [{ role: 'user', content: 'Which day is best?' }];

      for (const [endpoint, key] of [['/api/forecasts/insights/chat', unique('ct-chat')], ['/api/forecasts/insights/chat/stream', unique('ct-stream')]]) {
        const res = await client('attacker').post(endpoint).set('Idempotency-Key', key).send({ messages, chatId: victimChat.id });
        expect({ endpoint, status: res.status }).toEqual({ endpoint, status: 200 }); // answered, so the save path ran
        await waitFor(async () => {
          const row = await UsageLedger.findOne({ idempotencyKey: key }).lean();
          return row && !['reserved', 'recovering'].includes(row.status);
        }, { timeoutMs: 5000, message: `the ${endpoint} charge to settle` });
      }
      expect(await InsightChat.findById(victimChat.id).lean()).toEqual(before);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      mockAnthropicMessageCreate.mockReset();
    }
  });

  it("GET /api/leave?staffId= lists nothing for another organisation's or another cafe's staff", async () => {
    const staff = await make.staff();
    made(await client('victim').post('/api/leave')
      .send({ staffId: staff.id, type: 'annual', startDate: '2026-11-16', endDate: '2026-11-17' }), (b) => b.leaveRequest._id);
    for (const role of ['attacker', 'manager']) {
      const res = await client(role).get(`/api/leave?staffId=${staff.id}`);
      expect({ role, status: res.status, listed: (res.body.leaveRequests || []).length })
        .toEqual({ role, status: 200, listed: 0 });
    }
  });

  it("PUT /api/shifts/:id refuses to move the attacker's own shift onto another organisation's staff member", async () => {
    const victimStaff = await make.staff();
    const ownStaff = made(await client('attacker').post('/api/staff')
      .send({ name: unique('Attacker Barista'), hourlyRate: 55 }), (b) => b.staff._id);
    const ownShift = made(await client('attacker').post('/api/shifts')
      .send({ staffId: ownStaff, date: '2026-10-07', startTime: '07:00', endTime: '15:00' }), (b) => b.shift._id);
    const before = await Shift.findById(ownShift).lean();

    const res = await client('attacker').put(`/api/shifts/${ownShift}`).send({ staffId: victimStaff.id });
    expect(res.status).toBe(404);
    expect(await Shift.findById(ownShift).lean()).toEqual(before);
    expect(await Shift.countDocuments({ staffId: victimStaff.id })).toBe(0);
  });
});
