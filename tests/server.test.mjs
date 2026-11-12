import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, sampleRequest, PASSWORD, proof, PNG } from './helpers.mjs';

let s;
before(async () => {
  s = await startServer();
  s.user('admin@alpha.test', 'admin');
  s.user('dispatch@alpha.test', 'dispatcher');
  s.user('req.one@alpha.test', 'requester');
  s.user('req.two@alpha.test', 'requester');
  s.user('rider.tri@alpha.test', 'rider', { tags: ['triangle'] });
  s.user('rider.fin@alpha.test', 'rider', { tags: ['finance'] });
  s.user('rider.gen@alpha.test', 'rider');
  s.user('rider.gen2@alpha.test', 'rider');
  s.user('new@alpha.test', 'requester', { mustChange: true, password: 'Temp-Pass-0001', tempExpiresAt: new Date(Date.now() + 3600e3).toISOString() });
  s.user('expired@alpha.test', 'requester', { mustChange: true, password: 'Temp-Pass-0002', tempExpiresAt: new Date(Date.now() - 1000).toISOString() });
  s.user('dispatch@beta.test', 'dispatcher', { companyName: 'Beta' });
  s.user('rider@beta.test', 'rider', { companyName: 'Beta' });
});
after(() => s.close());

async function as(email) {
  const c = client(s.base);
  const r = await c.login(email);
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
  return c;
}
async function createRequest(over) {
  const c = await as('req.one@alpha.test');
  const r = await c.post('/api/requests', sampleRequest(over));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.request;
}

describe('authentication', () => {
  test('rejects bad credentials without revealing which part was wrong', async () => {
    const c = client(s.base);
    const a = await c.login('dispatch@alpha.test', 'wrong-password-123');
    const b = await c.login('nobody@alpha.test', 'wrong-password-123');
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.data.message, b.data.message);
  });

  test('sets an HttpOnly, Secure, SameSite=Strict session cookie and returns a CSRF token', async () => {
    const c = client(s.base);
    const r = await c.login('dispatch@alpha.test');
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
    assert.ok(r.data.csrf);
    const me = await c.get('/api/auth/me');
    assert.equal(me.data.user.email, 'dispatch@alpha.test');
    assert.equal(me.data.user.passwordHash, undefined);
  });

  test('unauthenticated API calls get 401', async () => {
    const r = await client(s.base).get('/api/requests');
    assert.equal(r.status, 401);
  });

  test('logout ends the session', async () => {
    const c = await as('dispatch@alpha.test');
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
});

describe('temporary passwords', () => {
  test('forces replacement before any operational call', async () => {
    const c = client(s.base);
    const r = await c.login('new@alpha.test', 'Temp-Pass-0001');
    assert.equal(r.status, 200);
    assert.equal(r.data.user.mustChange, true);
    const blocked = await c.get('/api/requests');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error, 'password_change_required');

    const short = await c.post('/api/auth/password', { current: 'Temp-Pass-0001', next: 'short' });
    assert.equal(short.status, 400);
    const wrong = await c.post('/api/auth/password', { current: 'nope', next: 'A-much-longer-password-9' });
    assert.equal(wrong.status, 400);
    const ok = await c.post('/api/auth/password', { current: 'Temp-Pass-0001', next: 'A-much-longer-password-9' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.mustChange, false);
    assert.equal((await c.get('/api/requests')).status, 200);
    // the old password no longer works
    assert.equal((await client(s.base).login('new@alpha.test', 'Temp-Pass-0001')).status, 401);
  });

  test('expired temporary passwords cannot sign in', async () => {
    const r = await client(s.base).login('expired@alpha.test', 'Temp-Pass-0002');
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'temp_expired');
  });

  test('administrators create accounts and issue replacement temporary passwords', async () => {
    const admin = await as('admin@alpha.test');
    const created = await admin.post('/api/users', { email: 'rider.new@alpha.test', name: 'New Rider', role: 'rider', tags: ['finance'] });
    assert.equal(created.status, 200);
    assert.match(created.data.tempPassword, /^[\w]{4}-[\w]{4}-[\w]{4}-[\w]{4}$/);
    assert.equal(created.data.user.mustChange, true);
    assert.deepEqual(created.data.user.tags, ['finance']);
    const login = await client(s.base).login('rider.new@alpha.test', created.data.tempPassword);
    assert.equal(login.status, 200);

    const reset = await admin.post(`/api/users/${created.data.user.id}/reset-password`);
    assert.equal(reset.status, 200);
    assert.notEqual(reset.data.tempPassword, created.data.tempPassword);
    assert.equal((await client(s.base).login('rider.new@alpha.test', created.data.tempPassword)).status, 401);

    const dup = await admin.post('/api/users', { email: 'rider.new@alpha.test', name: 'Dup', role: 'rider' });
    assert.equal(dup.status, 409);
  });

  test('only administrators manage accounts', async () => {
    const d = await as('dispatch@alpha.test');
    assert.equal((await d.post('/api/users', { email: 'x@alpha.test', name: 'X', role: 'admin' })).status, 403);
  });

  test('deactivated accounts are signed out and cannot sign in', async () => {
    const admin = await as('admin@alpha.test');
    const victim = await as('rider.gen2@alpha.test');
    const id = s.ids['rider.gen2@alpha.test'];
    assert.equal((await admin.patch(`/api/users/${id}`, { active: false })).status, 200);
    assert.equal((await victim.get('/api/auth/me')).status, 401);
    assert.equal((await client(s.base).login('rider.gen2@alpha.test')).status, 401);
    await admin.patch(`/api/users/${id}`, { active: true });
  });
});

describe('CSRF and origin protection', () => {
  test('mutations without the CSRF token are refused', async () => {
    const c = await as('req.one@alpha.test');
    const r = await c.post('/api/requests', sampleRequest(), { withCsrf: false });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'bad_csrf');
  });
  test('cross-origin and origin-less mutations are refused, including login', async () => {
    const c = await as('req.one@alpha.test');
    assert.equal((await c.post('/api/requests', sampleRequest(), { origin: 'https://evil.test' })).data.error, 'bad_origin');
    assert.equal((await c.post('/api/requests', sampleRequest(), { origin: null })).status, 403);
    const l = await client(s.base).post('/api/auth/login', { email: 'dispatch@alpha.test', password: PASSWORD }, { origin: 'https://evil.test' });
    assert.equal(l.status, 403);
  });
});

describe('roles and company isolation', () => {
  test('requesters only see their own requests', async () => {
    const r = await createRequest();
    const other = await as('req.two@alpha.test');
    assert.equal((await other.get(`/api/requests/${r.id}`)).status, 404);
    assert.ok(!(await other.get('/api/requests?status=all')).data.requests.some((x) => x.id === r.id));
  });

  test('riders cannot create requests and requesters cannot assign', async () => {
    const rider = await as('rider.gen@alpha.test');
    assert.equal((await rider.post('/api/requests', sampleRequest())).status, 403);
    const r = await createRequest();
    const req = await as('req.one@alpha.test');
    assert.equal((await req.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider.gen@alpha.test'] })).status, 403);
  });

  test('other companies cannot see or touch requests, and cannot use foreign riders', async () => {
    const r = await createRequest();
    const beta = await as('dispatch@beta.test');
    assert.equal((await beta.get(`/api/requests/${r.id}`)).status, 404);
    assert.equal((await beta.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider@beta.test'] })).status, 404);
    assert.ok(!(await beta.get('/api/requests?status=all')).data.requests.length);
    assert.ok(!(await beta.get('/api/activity')).data.activity.some((a) => a.requestId === r.id));
    const alpha = await as('dispatch@alpha.test');
    const foreign = await alpha.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider@beta.test'] });
    assert.equal(foreign.status, 400);
  });

  test('request payloads are validated', async () => {
    const c = await as('req.one@alpha.test');
    assert.equal((await c.post('/api/requests', sampleRequest({ dropoffs: [] }))).status, 400);
    assert.equal((await c.post('/api/requests', sampleRequest({ category: 'vip' }))).status, 400);
    assert.equal((await c.post('/api/requests', sampleRequest({ handling: ['explosive'] }))).status, 400);
    assert.equal((await c.post('/api/requests', { ...sampleRequest(), pickup: { address: '' } })).status, 400);
  });
});

describe('priority rules and recorded overrides', () => {
  test('Triangle work needs a Triangle rider unless an acknowledged override is recorded', async () => {
    const r = await createRequest({ category: 'triangle', title: 'Triangle proofs' });
    const d = await as('dispatch@alpha.test');
    const blocked = await d.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider.gen@alpha.test'] });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error, 'override_required');
    assert.equal(blocked.data.data.conflicts[0].code, 'reserved_category');

    const noAck = await d.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider.gen@alpha.test'], override: { reason: 'Felix is off sick' } });
    assert.equal(noAck.status, 409);
    const ok = await d.post(`/api/requests/${r.id}/assign`, {
      version: r.version, riderId: s.ids['rider.gen@alpha.test'], override: { acknowledged: true, reason: 'Felix is off sick today' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.request.status, 'assigned');
    const detail = await d.get(`/api/requests/${r.id}`);
    assert.equal(detail.data.overrides.length, 1);
    assert.equal(detail.data.overrides[0].reason, 'Felix is off sick today');
    assert.ok(detail.data.activity.some((a) => a.action === 'override'));
    // requesters don't see dispatcher override records
    const req = await as('req.one@alpha.test');
    assert.deepEqual((await req.get(`/api/requests/${r.id}`)).data.overrides, []);
  });

  test('a Triangle rider assigned to Triangle work needs no override', async () => {
    const r = await createRequest({ category: 'triangle' });
    const d = await as('dispatch@alpha.test');
    const ok = await d.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider.tri@alpha.test'] });
    assert.equal(ok.status, 200);
  });

  test('designated riders are held for reserved work that is still waiting', async () => {
    const fin = await createRequest({ category: 'finance', title: 'Cash float' });
    const gen = await createRequest({ title: 'Brochures' });
    const d = await as('dispatch@alpha.test');
    const blocked = await d.post(`/api/requests/${gen.id}/assign`, { version: gen.version, riderId: s.ids['rider.fin@alpha.test'] });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.data.conflicts[0].code, 'reserved_rider');
    // once the finance job has its rider, the finance rider is free for general work
    assert.equal((await d.post(`/api/requests/${fin.id}/assign`, { version: fin.version, riderId: s.ids['rider.fin@alpha.test'] })).status, 200);
    assert.equal((await d.post(`/api/requests/${gen.id}/assign`, { version: gen.version, riderId: s.ids['rider.fin@alpha.test'] })).status, 200);
  });
});

describe('stale updates', () => {
  test('optimistic version checks reject stale writes and return the latest copy', async () => {
    const r = await createRequest();
    const d = await as('dispatch@alpha.test');
    const first = await d.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider.gen@alpha.test'] });
    assert.equal(first.status, 200);
    const stale = await d.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider.tri@alpha.test'] });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'stale');
    assert.equal(stale.data.data.current.version, first.data.request.version);
    const edit = await d.patch(`/api/requests/${r.id}`, { ...sampleRequest({ title: 'Changed' }), version: r.version });
    assert.equal(edit.status, 409);
    const missing = await d.post(`/api/requests/${r.id}/assign`, { riderId: s.ids['rider.gen@alpha.test'] });
    assert.equal(missing.status, 400);
  });

  test('requesters may edit or cancel only while waiting', async () => {
    const r = await createRequest();
    const req = await as('req.one@alpha.test');
    const edited = await req.patch(`/api/requests/${r.id}`, { ...sampleRequest({ title: 'Renamed' }), version: r.version });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.request.title, 'Renamed');
    const d = await as('dispatch@alpha.test');
    const a = await d.post(`/api/requests/${r.id}/assign`, { version: edited.data.request.version, riderId: s.ids['rider.gen@alpha.test'] });
    assert.equal((await req.post(`/api/requests/${r.id}/cancel`, { version: a.data.request.version })).status, 403);
    const c = await d.post(`/api/requests/${r.id}/cancel`, { version: a.data.request.version, reason: 'No longer needed' });
    assert.equal(c.status, 200);
    assert.equal(c.data.request.status, 'cancelled');
  });
});

describe('delivery progress', () => {
  test('only the fixed, assigned rider records collection and handovers', async () => {
    const r = await createRequest();
    const d = await as('dispatch@alpha.test');
    let cur = (await d.post(`/api/requests/${r.id}/assign`, { version: r.version, riderId: s.ids['rider.gen@alpha.test'] })).data.request;
    const other = await as('rider.tri@alpha.test');
    assert.equal((await other.post(`/api/requests/${r.id}/collect`, { version: cur.version, collectedFrom: 'Reception' })).status, 404);
    assert.equal((await d.post(`/api/requests/${r.id}/collect`, { version: cur.version, collectedFrom: 'Reception' })).status, 403);

    const rider = await as('rider.gen@alpha.test');
    const early = await rider.post(`/api/requests/${r.id}/dropoffs/${cur.dropoffs[0].id}/handover`, { version: cur.version, receivedBy: 'Mercy' });
    assert.equal(early.status, 409);
    const fake = await rider.post(`/api/requests/${r.id}/collect`, { version: cur.version, collectedFrom: 'Reception', photo: 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(fake.status, 400, 'bytes must really be an image');
    // MVP feedback: the pickup photo is optional (the drop-off photo stays required, below).
    const col = await rider.post(`/api/requests/${r.id}/collect`, { version: cur.version, collectedFrom: 'Reception', itemCount: 2 });
    assert.equal(col.status, 200, 'a collection no longer needs a photo');
    cur = col.data.request;
    assert.equal(cur.status, 'collected');

    const reassign = await d.post(`/api/requests/${r.id}/assign`, { version: cur.version, riderId: s.ids['rider.tri@alpha.test'] });
    assert.equal(reassign.status, 409);
    assert.equal(reassign.data.error, 'rider_fixed');

    const failed = await rider.post(`/api/requests/${r.id}/dropoffs/${cur.dropoffs[1].id}/handover`, { version: cur.version, outcome: 'failed', note: 'Office closed' });
    assert.equal(failed.status, 200);
    cur = failed.data.request;
    assert.equal(cur.status, 'collected');
    const unsigned = await rider.post(`/api/requests/${r.id}/dropoffs/${cur.dropoffs[0].id}/handover`, { version: cur.version, receivedBy: 'Mercy', photo: PNG });
    assert.equal(unsigned.status, 400, 'a delivered handover needs the D-note signature');
    const noDropPhoto = await rider.post(`/api/requests/${r.id}/dropoffs/${cur.dropoffs[0].id}/handover`, { version: cur.version, receivedBy: 'Mercy', signature: PNG });
    assert.equal(noDropPhoto.status, 400, 'a delivered handover still needs a photo');
    const h1 = await rider.post(`/api/requests/${r.id}/dropoffs/${cur.dropoffs[0].id}/handover`, { version: cur.version, receivedBy: 'Mercy', dnoteRef: 'DN-1001', ...proof() });
    cur = h1.data.request;
    assert.equal(h1.data.remaining, 1);
    const h2 = await rider.post(`/api/requests/${r.id}/dropoffs/${cur.dropoffs[1].id}/handover`, { version: cur.version, receivedBy: 'Desk', ...proof() });
    assert.equal(h2.status, 200);
    assert.equal(h2.data.request.status, 'delivered');
    assert.ok(h2.data.request.deliveredAt);

    const detail = await d.get(`/api/requests/${r.id}`);
    assert.equal(detail.data.records.length, 4);
    assert.ok(detail.data.records.every((x) => x.gpsStatus === 'unconnected'));
    assert.equal(detail.data.records.find((x) => x.kind === 'collection').photo, null, 'no pickup photo was taken');
    const signed = detail.data.records.find((x) => x.dnoteRef === 'DN-1001');
    assert.equal(signed.signedBy, 'Mercy');
    assert.ok(signed.photo && signed.signature);
    const img = await fetch(s.base + signed.photo, { headers: { Cookie: d.cookie } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await other.get(signed.photo)).status, 404, 'other riders cannot open the proof');
  });
});

describe('runs and shifts', () => {
  test('dispatchers plan runs from a rider’s open jobs; riders start and finish them', async () => {
    const a = await createRequest();
    const b = await createRequest();
    const d = await as('dispatch@alpha.test');
    const rid = s.ids['rider.gen@alpha.test'];
    await d.post(`/api/requests/${a.id}/assign`, { version: a.version, riderId: rid });
    const unassigned = await d.post('/api/runs', { riderId: rid, requestIds: [a.id, b.id] });
    assert.equal(unassigned.status, 400);
    const run = await d.post('/api/runs', { riderId: rid, name: 'Morning loop', requestIds: [a.id] });
    assert.equal(run.status, 200);
    assert.equal(run.data.run.requests.length, 1);
    assert.equal((await d.post('/api/runs', { riderId: rid, requestIds: [a.id] })).status, 400);
    const rider = await as('rider.gen@alpha.test');
    assert.equal((await rider.post(`/api/runs/${run.data.run.id}/delete`)).status, 403);
    assert.equal((await rider.post(`/api/runs/${run.data.run.id}/start`)).data.run.status, 'active');
    assert.equal((await rider.post(`/api/runs/${run.data.run.id}/finish`)).data.run.status, 'done');
    const otherRider = await as('rider.tri@alpha.test');
    assert.ok(!(await otherRider.get('/api/runs')).data.runs.some((x) => x.id === run.data.run.id));
  });

  test('riders are switched on and off shift; switching off records the shift', async () => {
    const d = await as('dispatch@alpha.test');
    const rid = s.ids['rider.tri@alpha.test'];
    const on = await d.post(`/api/riders/${rid}/shift`, { onShift: true });
    assert.equal(on.status, 200);
    assert.equal(on.data.rider.onShift, true);
    assert.equal((await d.get('/api/stats')).data.riders.find((r) => r.id === rid).onShift, true);
    assert.equal((await d.post(`/api/riders/${rid}/shift`, { onShift: 'yes' })).status, 400);

    const other = await as('rider.gen@alpha.test');
    assert.equal((await other.post(`/api/riders/${rid}/shift`, { onShift: false })).status, 403);
    const self = await as('rider.tri@alpha.test');
    assert.equal((await self.get('/api/auth/me')).data.user.onShift, true);
    s.db.prepare('UPDATE users SET on_shift_since = ? WHERE id = ?').run(new Date(Date.now() - 3600e3).toISOString(), rid);
    const off = await self.post(`/api/riders/${rid}/shift`, { onShift: false });
    assert.equal(off.data.rider.onShift, false);
    const log = (await d.get('/api/shifts')).data.shifts.filter((x) => x.rider.id === rid);
    assert.equal(log.length, 1);
    assert.ok(new Date(log[0].endsAt) - new Date(log[0].startsAt) >= 3599e3);
    assert.ok(!(await other.get('/api/shifts')).data.shifts.some((x) => x.rider.id === rid));
    const requester = await as('req.one@alpha.test');
    assert.equal((await requester.post(`/api/riders/${rid}/shift`, { onShift: true })).status, 403);
  });

  test('the old shift calendar endpoints are gone', async () => {
    const d = await as('dispatch@alpha.test');
    const r = await d.post('/api/shifts', { riderId: s.ids['rider.tri@alpha.test'], startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(r.status, 405);
  });
});

describe('static files and headers', () => {
  test('serves the app with security headers and blocks traversal', async () => {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(await res.text(), /hosted\.js/);
    const js = await fetch(`${s.base}/js/hosted.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    const trav = await fetch(`${s.base}/..%2fserver%2fapp.mjs`);
    assert.notEqual(trav.status, 200);
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  });

  test('WhatsApp import endpoint parses without storing anything', async () => {
    const c = await as('req.one@alpha.test');
    const before = s.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
    const r = await c.post('/api/import/whatsapp', { text: 'Pickup: HQ\nDrop: Bank, Moi Ave\nContact: Peter 0711 000 204' });
    assert.equal(r.status, 200);
    assert.equal(r.data.parsed.dropoffs[0].contactPhone, '+254711000204');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, before);
  });
});

