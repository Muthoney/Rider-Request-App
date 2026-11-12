// v2 (post-demo feedback): availability, incidents, location changes, proof, ratings, contact privacy,
// shifts/overtime, SMS fallback through Africa's Talking, offline sync (idempotency, GPS batches), live events.
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, sampleRequest, ORIGIN, proof, PNG } from './helpers.mjs';
import { createIntegrations } from '../server/integrations.mjs';

// ---- Africa's Talking, faked at the HTTP level so the real client code runs ----
const at = { calls: [], mode: 'ok', seq: 0 };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
async function fakeFetch(url, init) {
  if (!String(url).includes('africastalking.com')) throw new Error(`unexpected fetch ${url}`);
  const form = new URLSearchParams(init.body);
  at.calls.push({ url: String(url), apiKey: init.headers.apiKey, to: form.get('to'), message: form.get('message'), from: form.get('from') });
  if (at.mode === 'down') throw new Error('getaddrinfo ENOTFOUND');
  const code = at.mode === 'invalid' ? 403 : at.mode === 'balance' ? 405 : 101;
  return json(201, { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ statusCode: code, number: form.get('to'), status: code === 101 ? 'Success' : code === 403 ? 'InvalidPhoneNumber' : 'InsufficientBalance', messageId: `ATXid_${++at.seq}` }] } });
}
const integrations = createIntegrations({ AT_USERNAME: 'sandbox', AT_API_KEY: 'test-key', AT_SENDER_ID: 'RIDERS', AT_CALLBACK_TOKEN: 'cb-secret' }, { fetchImpl: fakeFetch });

let s;
const PIN = { lat: -1.2992, lng: 36.8137 }; // drop-off 1 in sampleRequest (Upper Hill)
before(async () => {
  s = await startServer({ integrations, maxActiveJobs: 2 });
  s.user('admin@v2.test', 'admin', { companyName: 'V2', phone: '0700 000 001' });
  s.user('dispatch@v2.test', 'dispatcher', { companyName: 'V2', phone: '0700 000 002' });
  s.user('manager@v2.test', 'manager', { companyName: 'V2' });
  s.user('client@v2.test', 'requester', { companyName: 'V2', phone: '0700 000 010' });
  s.user('client2@v2.test', 'requester', { companyName: 'V2', phone: '0700 000 011' });
  s.user('rider.a@v2.test', 'rider', { companyName: 'V2', phone: '0711 000 101' });
  s.user('rider.b@v2.test', 'rider', { companyName: 'V2', phone: '0711 000 102' });
  s.user('rider.c@v2.test', 'rider', { companyName: 'V2', phone: '0711 000 103' });
  s.user('rider@other.test', 'rider', { companyName: 'Other' });
});
after(() => s.close());
beforeEach(() => { at.calls.length = 0; at.mode = 'ok'; s.clock.offset = 0; });

const sessions = new Map();
async function as(email) {
  if (sessions.has(email)) return sessions.get(email);
  const c = client(s.base);
  assert.equal((await c.login(email)).status, 200, `login ${email}`);
  sessions.set(email, c);
  return c;
}
const id = (email) => s.ids[email];
async function newRequest(over = {}, who = 'client@v2.test') {
  const r = await (await as(who)).post('/api/requests', sampleRequest(over));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.request;
}
async function clockIn(email) { return (await as(email)).post(`/api/riders/${id(email)}/shift`, { onShift: true }); }
async function clockOut(email) { return (await as(email)).post(`/api/riders/${id(email)}/shift`, { onShift: false }); }
async function assign(req, email, override) {
  return (await as('dispatch@v2.test')).post(`/api/requests/${req.id}/assign`, { version: req.version, riderId: id(email), ...(override ? { override } : {}) });
}
const availabilityOf = async (email) => (await (await as('dispatch@v2.test')).get('/api/live')).data.riders.find((r) => r.id === id(email));
/** Assigns, collects and hands over every drop-off. Returns the delivered request. */
async function deliver(req, email) {
  let cur = (await assign(req, email)).data.request;
  const rider = await as(email);
  cur = (await rider.post(`/api/requests/${cur.id}/collect`, { version: cur.version, collectedFrom: 'Reception' })).data.request;
  for (const d of cur.dropoffs) {
    const h = await rider.post(`/api/requests/${cur.id}/dropoffs/${d.id}/handover`, { version: cur.version, receivedBy: 'Desk', ...proof() });
    assert.equal(h.status, 200, JSON.stringify(h.data));
    cur = h.data.request;
  }
  return cur;
}

describe('rider availability and standby', () => {
  test('status follows shift, break and jobs; dispatch sees counts, last location and activity', async () => {
    assert.equal((await availabilityOf('rider.a@v2.test')).availability, 'offline');
    await clockIn('rider.a@v2.test');
    const a = await availabilityOf('rider.a@v2.test');
    assert.equal(a.availability, 'available');
    assert.ok(a.lastSeenAt, 'last seen is recorded at clock-in');
    const live = (await (await as('dispatch@v2.test')).get('/api/live')).data;
    assert.ok(live.summary.available >= 1 && live.summary.offline >= 1);
    assert.equal(live.settings.maxActiveJobs, 2);

    const req = await newRequest();
    let cur = (await assign(req, 'rider.a@v2.test')).data.request;
    assert.equal((await availabilityOf('rider.a@v2.test')).availability, 'assigned');
    const rider = await as('rider.a@v2.test');
    // With an active job the rider cannot go on break.
    assert.equal((await rider.post(`/api/riders/${id('rider.a@v2.test')}/availability`, { status: 'on_break' })).data.error, 'has_jobs');
    cur = (await rider.post(`/api/requests/${cur.id}/collect`, { version: cur.version, collectedFrom: 'Reception' })).data.request;
    assert.equal((await availabilityOf('rider.a@v2.test')).availability, 'on_delivery');
    // Clocking out while carrying items is refused; dispatch can still do it.
    assert.equal((await clockOut('rider.a@v2.test')).data.error, 'carrying');
    for (const d of cur.dropoffs) cur = (await rider.post(`/api/requests/${cur.id}/dropoffs/${d.id}/handover`, { version: cur.version, receivedBy: 'Desk', ...proof() })).data.request;
    assert.equal(cur.status, 'delivered');
    const after = await availabilityOf('rider.a@v2.test');
    assert.equal(after.availability, 'available', 'completing the job frees the rider');
    assert.ok(after.lastActivityAt);
  });

  test('a rider on break needs an authorised override to be assigned, and cannot accept jobs', async () => {
    await clockIn('rider.b@v2.test');
    const rider = await as('rider.b@v2.test');
    const br = await rider.post(`/api/riders/${id('rider.b@v2.test')}/availability`, { status: 'on_break' });
    assert.equal(br.status, 200);
    assert.equal(br.data.rider.availability, 'on_break');
    const req = await newRequest();
    assert.equal((await rider.post(`/api/requests/${req.id}/accept`, { version: req.version })).data.error, 'on_break');
    const blocked = await assign(req, 'rider.b@v2.test');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.data.conflicts[0].code, 'rider_on_break');
    const ok = await assign(req, 'rider.b@v2.test', { acknowledged: true, reason: 'Only rider near Upper Hill' });
    assert.equal(ok.status, 200);
    assert.equal((await availabilityOf('rider.b@v2.test')).availability, 'assigned', 'the override ends the break');
    const detail = await (await as('dispatch@v2.test')).get(`/api/requests/${req.id}`);
    assert.equal(detail.data.overrides[0].conflicts[0].code, 'rider_on_break', 'the override is recorded');
    // Hand the job back so later tests start clean.
    await (await as('dispatch@v2.test')).post(`/api/requests/${req.id}/cancel`, { version: ok.data.request.version, reason: 'test' });
  });

  test('the active-job limit blocks a third job without an override; offline riders get a warning only', async () => {
    await clockIn('rider.c@v2.test');
    const reqs = [await newRequest(), await newRequest(), await newRequest()];
    assert.equal((await assign(reqs[0], 'rider.c@v2.test')).status, 200);
    assert.equal((await assign(reqs[1], 'rider.c@v2.test')).status, 200);
    const third = await assign(reqs[2], 'rider.c@v2.test');
    assert.equal(third.status, 409);
    assert.equal(third.data.data.conflicts[0].code, 'rider_at_capacity');
    const rider = await as('rider.c@v2.test');
    assert.equal((await rider.post(`/api/requests/${reqs[2].id}/accept`, { version: reqs[2].version })).data.error, 'busy');
    assert.ok((await availabilityOf('rider.c@v2.test')).atCapacity);
    // Offline rider (scheduled work): allowed, with a warning.
    await clockOut('rider.b@v2.test');
    const off = await assign(reqs[2], 'rider.b@v2.test');
    assert.equal(off.status, 200);
    assert.equal(off.data.warnings[0].code, 'rider_offline');
    const d = await as('dispatch@v2.test');
    for (const r of reqs) {
      const cur = (await d.get(`/api/requests/${r.id}`)).data.request;
      await d.post(`/api/requests/${r.id}/cancel`, { version: cur.version, reason: 'cleanup' });
    }
  });

  test('only administrators change operational settings; values are validated', async () => {
    assert.equal((await (await as('dispatch@v2.test')).patch('/api/ops/settings', { shiftHours: 9 })).status, 403);
    const admin = await as('admin@v2.test');
    assert.equal((await admin.patch('/api/ops/settings', { maxActiveJobs: 0 })).status, 400);
    const ok = await admin.patch('/api/ops/settings', { shiftHours: 8, standbyTimeoutMin: 20, dispatchPhone: '0700 000 002' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.settings.standbyTimeoutMin, 20);
    assert.equal(ok.data.settings.maxActiveJobs, 2, 'unchanged values are kept');
  });
});

describe('emergency and incident reporting', () => {
  test('a rider reports an accident with photo and video; dispatch is alerted by SMS at once', async () => {
    await clockIn('rider.a@v2.test');
    const rider = await as('rider.a@v2.test');
    const body = { clientId: 'inc-test-0001', type: 'accident', description: 'Knocked at Kenyatta Ave roundabout', lat: -1.2864, lng: 36.8172, accuracy: 12, photos: [PNG] };
    const r = await rider.post('/api/incidents', body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const inc = r.data.incident;
    assert.equal(inc.severity, 'critical');
    assert.equal(inc.media.length, 1);
    // Offline replay with the same clientId does not create a second report.
    const again = await rider.post('/api/incidents', body);
    assert.equal(again.data.incident.id, inc.id);
    assert.equal(again.data.duplicate, true);

    // Immediate SMS escalation to admin + dispatcher (queued, then sent by the worker).
    await s.tick();
    const alerts = at.calls.filter((c) => /^EMERGENCY/.test(c.message));
    assert.deepEqual(alerts.map((c) => c.to).sort(), ['+254700000001', '+254700000002'], 'admin and dispatcher, once each');
    assert.match(alerts[0].message, /EMERGENCY: rider a .*road accident.*maps\.google\.com\/\?q=-1\.28640,36\.81720/);
    assert.equal(alerts[0].apiKey, 'test-key');
    assert.equal(alerts[0].from, 'RIDERS');
    assert.match(alerts[0].url, /sandbox\.africastalking\.com/);

    // Video evidence (binary upload, de-duplicated by clientId).
    const video = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(200, 7)]);
    const up = await fetch(`${s.base}/api/incidents/${inc.id}/media?clientId=vid-1`, {
      method: 'POST', body: video, headers: { Cookie: rider.cookie, Origin: ORIGIN, 'X-CSRF-Token': (await rider.get('/api/auth/me')).data.csrf, 'Content-Type': 'video/mp4' },
    });
    assert.equal(up.status, 200);
    const bad = await fetch(`${s.base}/api/incidents/${inc.id}/media`, {
      method: 'POST', body: Buffer.alloc(300, 1), headers: { Cookie: rider.cookie, Origin: ORIGIN, 'X-CSRF-Token': (await rider.get('/api/auth/me')).data.csrf, 'Content-Type': 'video/mp4' },
    });
    assert.equal(bad.status, 400, 'non-video bytes are refused');

    const d = await as('dispatch@v2.test');
    const list = (await d.get('/api/incidents?status=open')).data.incidents;
    const mine = list.find((x) => x.id === inc.id);
    assert.equal(mine.media.length, 2);
    const vid = mine.media.find((m) => m.kind === 'video');
    const ranged = await fetch(s.base + vid.url, { headers: { Cookie: d.cookie, Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);
    assert.ok((await d.get('/api/live')).data.incidents.some((x) => x.id === inc.id && x.location), 'shown on the live map');
    assert.equal((await (await as('rider.b@v2.test')).get(`/api/incidents/${inc.id}`)).status, 404, 'other riders cannot see it');
    assert.equal((await (await as('client@v2.test')).get('/api/incidents')).status, 403);

    // Acknowledge (rider is told) and resolve.
    const ack = await d.post(`/api/incidents/${inc.id}/ack`);
    assert.equal(ack.data.incident.status, 'acknowledged');
    const inbox = (await rider.get('/api/inbox')).data;
    assert.ok(inbox.items.some((i) => i.event === 'incident_ack'));
    assert.equal((await d.post(`/api/incidents/${inc.id}/resolve`, {})).status, 400, 'a resolution note is required');
    const res = await d.post(`/api/incidents/${inc.id}/resolve`, { resolution: 'Rider checked at clinic, bike towed' });
    assert.equal(res.data.incident.status, 'resolved');
    assert.ok((await d.get(`/api/incidents/${inc.id}`)).data.activity.length >= 3, 'history is kept');
  });
});

describe('pickup and drop-off location changes', () => {
  test('the rider is told at once, must confirm a significant change, and the history is kept', async () => {
    await clockIn('rider.a@v2.test');
    const req = await newRequest({ dropoffs: [{ address: 'Upper Hill Chambers', contactName: 'Mercy', contactPhone: '0722 000 201', ...PIN }] });
    let cur = (await assign(req, 'rider.a@v2.test')).data.request;
    const rider = await as('rider.a@v2.test');
    cur = (await rider.post(`/api/requests/${cur.id}/collect`, { version: cur.version, collectedFrom: 'Reception' })).data.request;

    const client = await as('client@v2.test');
    assert.equal((await rider.post(`/api/requests/${cur.id}/stops/change`, { version: cur.version, kind: 'dropoff', seq: 1, address: 'X' })).status, 403, 'riders cannot change addresses');
    assert.equal((await (await as('client2@v2.test')).post(`/api/requests/${cur.id}/stops/change`, { version: cur.version, kind: 'dropoff', seq: 1, address: 'X' })).status, 404);
    const ch = await client.post(`/api/requests/${cur.id}/stops/change`, {
      version: cur.version, kind: 'dropoff', seq: 1, address: 'Westlands Square', lat: -1.2676, lng: 36.8108,
      details: { building: 'Westlands Square', floor: '3', unit: 'Suite 302', gate: 'Main reception', landmark: 'Opposite Sarit Centre' }, reason: 'Recipient moved offices',
    });
    assert.equal(ch.status, 200, JSON.stringify(ch.data));
    assert.equal(ch.data.changes[0].significant, true);
    cur = ch.data.request;
    assert.equal(cur.dropoffs[0].address, 'Westlands Square');
    assert.equal(cur.dropoffs[0].details.unit, 'Suite 302');

    // Rider is notified (in-app; offline → SMS) and cannot hand over before confirming.
    const inbox = (await rider.get('/api/inbox')).data.items;
    assert.ok(inbox.some((i) => i.event === 'location_changed' && i.critical));
    const blocked = await rider.post(`/api/requests/${cur.id}/dropoffs/${cur.dropoffs[0].id}/handover`, { version: cur.version, receivedBy: 'Mercy', ...proof() });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error, 'ack_required');
    const detail = (await rider.get(`/api/requests/${cur.id}`)).data;
    const change = detail.locationChanges[0];
    assert.equal(change.from.address, 'Upper Hill Chambers');
    assert.equal(change.to.address, 'Westlands Square');
    assert.equal(change.by, 'client');
    assert.ok(change.distanceKm > 3);
    assert.equal(change.needsAck, true);
    assert.equal((await rider.post(`/api/requests/${cur.id}/location-changes/${change.id}/ack`)).status, 200);
    // GPS at the new pin is verified against it.
    const h = await rider.post(`/api/requests/${cur.id}/dropoffs/${cur.dropoffs[0].id}/handover`, {
      version: cur.version, receivedBy: 'Mercy', ...proof(), gps: { lat: -1.2677, lng: 36.8109, accuracy: 15, recordedAt: new Date().toISOString() },
    });
    assert.equal(h.status, 200, JSON.stringify(h.data));
    const rec = (await (await as('dispatch@v2.test')).get(`/api/requests/${cur.id}`)).data.records.find((x) => x.kind === 'handover');
    assert.equal(rec.gpsStatus, 'verified');
    assert.ok(rec.gps && rec.photo, 'the drop-off photo and GPS are attached to the delivery record');
    const done = (await client.post(`/api/requests/${cur.id}/stops/change`, { version: h.data.request.version, kind: 'dropoff', seq: 1, address: 'Elsewhere' }));
    assert.equal(done.status, 409, 'finished stops cannot change');
  });

  test('editing a request records location changes too', async () => {
    const req = await newRequest();
    const client = await as('client@v2.test');
    const body = sampleRequest({ version: req.version, pickup: { address: 'New pickup, Kilimani', details: { building: 'Kilimani Heights', floor: 'Ground' } } });
    const r = await client.patch(`/api/requests/${req.id}`, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.request.pickup.details.building, 'Kilimani Heights');
    const detail = (await client.get(`/api/requests/${req.id}`)).data;
    assert.equal(detail.locationChanges[0].kind, 'pickup');
    assert.equal(detail.locationChanges[0].needsAck, false, 'no rider yet, so nothing to confirm');
    assert.equal((await client.post('/api/requests', sampleRequest({ pickup: { address: 'A', details: { floor: 'x'.repeat(81) } } }))).status, 400);
  });
});

describe('client ratings', () => {
  test('only the requesting client rates, once, after delivery; dispatch sees performance', async () => {
    await clockIn('rider.b@v2.test');
    const req = await newRequest();
    const client = await as('client@v2.test');
    assert.equal((await client.post(`/api/requests/${req.id}/rating`, { stars: 5 })).status, 409, 'not delivered yet');
    const done = await deliver(req, 'rider.b@v2.test');
    assert.equal((await (await as('client2@v2.test')).post(`/api/requests/${done.id}/rating`, { stars: 1 })).status, 404, 'other clients cannot see it');
    assert.equal((await (await as('rider.b@v2.test')).post(`/api/requests/${done.id}/rating`, { stars: 5 })).status, 403);
    assert.equal((await client.post(`/api/requests/${done.id}/rating`, { stars: 6 })).status, 400);
    assert.equal((await (await as('dispatch@v2.test')).post(`/api/requests/${done.id}/rating`, { stars: 3 })).status, 403, 'dispatch cannot rate on the client’s behalf');
    assert.ok((await client.get(`/api/requests/${done.id}`)).data.canRate);
    const ok = await client.post(`/api/requests/${done.id}/rating`, { stars: 4, professionalism: 5, timeliness: 3, communication: 4, handling: 5, comment: 'Polite, a bit late' });
    assert.equal(ok.status, 200);
    assert.equal((await client.post(`/api/requests/${done.id}/rating`, { stars: 5 })).data.error, 'already_rated');
    const riderView = (await (await as('rider.b@v2.test')).get(`/api/requests/${done.id}`)).data.rating;
    assert.equal(riderView.stars, 4);
    assert.equal(riderView.comment, undefined, 'riders see the score, not the comment');
    assert.equal((await availabilityOf('rider.b@v2.test')).rating.avg, 4);
    const report = (await (await as('manager@v2.test')).get('/api/reports/riders')).data.riders.find((r) => r.rider.id === id('rider.b@v2.test'));
    assert.equal(report.ratings.count, 1);
    assert.equal(report.ratings.timeliness, 3);
    assert.equal(report.comments[0].comment, 'Polite, a bit late');
    assert.equal((await client.get('/api/reports/riders')).status, 403);
  });
});

describe('communication and contact privacy', () => {
  test('numbers are shown only to people who need them, while the job is active', async () => {
    await clockIn('rider.c@v2.test');
    const req = await newRequest();
    const rider = await as('rider.c@v2.test');
    const open = (await rider.get('/api/jobs/available')).data.jobs.find((j) => j.id === req.id);
    assert.equal(open.dropoffs[0].contactPhone, null, 'riders browsing open jobs see no numbers');
    assert.equal(open.requester.phone, null);
    let cur = (await assign(req, 'rider.c@v2.test')).data.request;
    const mine = (await rider.get(`/api/requests/${req.id}`)).data.request;
    assert.equal(mine.dropoffs[0].contactPhone, '+254711000201', 'the assigned rider sees the recipient’s number');
    assert.equal(mine.requester.phone, '0700 000 010');
    const clientView = (await (await as('client@v2.test')).get(`/api/requests/${req.id}`)).data.request;
    assert.equal(clientView.rider.phone, '0711 000 103', 'the client sees the assigned rider’s number');
    assert.equal((await rider.post(`/api/requests/${req.id}/contact`, { target: 'dropoff:1', channel: 'call' })).status, 200);
    assert.equal((await (await as('client@v2.test')).post(`/api/requests/${req.id}/contact`, { target: 'dropoff:1' })).status, 403);
    assert.ok((await rider.get(`/api/requests/${req.id}`)).data.activity.some((a) => a.action === 'contact' && /called the recipient at drop-off 1/.test(a.message)));
    cur = (await rider.get(`/api/requests/${req.id}`)).data.request;
    const done = await deliver(cur, 'rider.c@v2.test');
    assert.equal(done.status, 'delivered');
    const after = (await rider.get(`/api/requests/${req.id}`)).data.request;
    assert.equal(after.dropoffs[0].contactPhone, null, 'numbers are hidden from the rider after delivery');
    assert.equal((await (await as('client@v2.test')).get(`/api/requests/${req.id}`)).data.request.rider.phone, null);
  });
});

describe('shifts and overtime', () => {
  test('clock-in/out is idempotent; overtime is requested, approved and reported', async () => {
    await clockOut('rider.c@v2.test');
    const first = await clockIn('rider.c@v2.test');
    const twice = await clockIn('rider.c@v2.test');
    assert.equal(twice.data.unchanged, true, 'a second clock-in does nothing');
    assert.equal(twice.data.rider.onShiftSince, first.data.rider.onShiftSince);
    const rider = await as('rider.c@v2.test');
    assert.equal((await rider.post('/api/overtime', { minutes: 5 })).status, 400);
    assert.equal((await rider.post('/api/overtime', { minutes: 9999 })).status, 400);
    const ot = await rider.post('/api/overtime', { minutes: 60, reason: 'Finance run after 6pm' });
    assert.equal(ot.status, 200);
    assert.equal((await rider.post('/api/overtime', { minutes: 30 })).data.error, 'pending', 'one pending request at a time');
    assert.equal((await rider.post(`/api/overtime/${ot.data.overtime.id}/decide`, { approve: true })).status, 403, 'riders cannot approve their own');
    const d = await as('dispatch@v2.test');
    assert.ok((await d.get('/api/inbox')).data.items.some((i) => i.event === 'overtime'));
    assert.equal((await d.post(`/api/overtime/${ot.data.overtime.id}/decide`, { approve: true, note: 'OK' })).data.overtime.status, 'approved');

    // 8.5 hours later: past the 8 h standard shift, inside the approved hour.
    s.clock.offset = 8.5 * 3600e3;
    let me = (await rider.get('/api/shift/me')).data.shift;
    assert.equal(me.plannedMinutes, 480);
    assert.equal(me.approvedMinutes, 60);
    assert.equal(me.state, 'overtime_approved');
    s.clock.offset = 9.5 * 3600e3;
    me = (await rider.get('/api/shift/me')).data.shift;
    assert.equal(me.state, 'over_unapproved');
    await s.tick();
    assert.ok((await rider.get('/api/inbox')).data.items.some((i) => i.event === 'shift_over'), 'the rider is told the shift is over');
    const out = await clockOut('rider.c@v2.test');
    assert.equal(out.status, 200, JSON.stringify(out.data));
    const report = (await d.get(`/api/shifts/report?riderId=${id('rider.c@v2.test')}&to=${new Date(Date.now() + 864e5).toISOString()}`)).data;
    const row = report.shifts.find((x) => !x.inProgress);
    assert.ok(row.minutes >= 569 && row.minutes <= 571, `minutes ${row.minutes}`);
    assert.equal(row.approvedOvertimeMinutes, 60);
    assert.ok(row.unapprovedOvertimeMinutes >= 29);
    assert.ok(report.riders[0].overtimeMinutes >= 89);

    // Dispatch offers overtime; the rider accepts.
    s.clock.offset = 0;
    await clockIn('rider.c@v2.test');
    const offer = await d.post(`/api/riders/${id('rider.c@v2.test')}/overtime`, { minutes: 30, reason: 'Late pickup' });
    assert.equal(offer.status, 200);
    assert.equal((await d.post(`/api/overtime/${offer.data.overtime.id}/decide`, { approve: true })).status, 403, 'the rider accepts an offer, not dispatch');
    assert.equal((await rider.post(`/api/overtime/${offer.data.overtime.id}/decide`, { approve: true })).data.overtime.status, 'approved');
  });
});

describe('SMS fallback (Africa’s Talking)', () => {
  test('critical notifications to an offline user go by SMS once; temporary failures retry, permanent ones stop', async () => {
    const n = s.handler.notifier;
    const client = s.db.prepare('SELECT * FROM users WHERE id = ?').get(id('client2@v2.test'));
    n.notify({ users: [client], event: 'test', title: 'T', body: 'B', sms: 'Critical test', critical: true, dedupe: 'sms-test-1' });
    n.notify({ users: [client], event: 'test', title: 'T', body: 'B', sms: 'Critical test', critical: true, dedupe: 'sms-test-1' });
    at.mode = 'down';
    await s.tick();
    assert.equal(at.calls.length, 1, 'one attempt, no duplicate');
    let row = s.db.prepare(`SELECT * FROM sms_outbox WHERE dedupe_key = 'sms-test-1:u${client.id}'`).get();
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 1);
    await s.tick();
    assert.equal(at.calls.length, 1, 'waits for the backoff');
    at.mode = 'ok';
    s.clock.offset = 31e3;
    await s.tick();
    row = s.db.prepare('SELECT * FROM sms_outbox WHERE id = ?').get(row.id);
    assert.equal(row.status, 'sent');
    assert.equal(at.calls.at(-1).to, '+254700000011');

    // Delivery report (form-encoded, token-protected).
    const cb = (token, body) => fetch(`${s.base}/api/webhooks/sms?token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    assert.equal((await cb('wrong', { id: row.provider_id, status: 'Success' })).status, 403);
    assert.equal((await cb('cb-secret', { id: row.provider_id, status: 'Success' })).status, 200);
    assert.equal(s.db.prepare('SELECT status FROM sms_outbox WHERE id = ?').get(row.id).status, 'delivered');

    at.mode = 'invalid';
    n.notify({ users: [client], event: 'test', title: 'T', body: 'B', sms: 'Bad number', critical: true, dedupe: 'sms-test-2' });
    await s.tick();
    assert.equal(s.db.prepare(`SELECT status FROM sms_outbox WHERE dedupe_key = 'sms-test-2:u${client.id}'`).get().status, 'failed', 'InvalidPhoneNumber is final');
    at.mode = 'balance';
    n.notify({ users: [client], event: 'test', title: 'T', body: 'B', sms: 'No balance', critical: true, dedupe: 'sms-test-3' });
    await s.tick();
    assert.equal(s.db.prepare(`SELECT status FROM sms_outbox WHERE dedupe_key = 'sms-test-3:u${client.id}'`).get().status, 'queued', 'InsufficientBalance is retried');
  });

  test('a connected user gets the notification live; SMS follows only if it goes unseen', async () => {
    const c = await as('client2@v2.test');
    const ctl = new AbortController();
    const res = await fetch(`${s.base}/api/events`, { headers: { Cookie: c.cookie }, signal: ctl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    let buf = '';
    const until = async (re) => { while (!re.test(buf)) { const { value } = await reader.read(); buf += Buffer.from(value).toString(); } };
    await until(/event: hello/);
    const user = s.db.prepare('SELECT * FROM users WHERE id = ?').get(id('client2@v2.test'));
    const [item] = s.handler.notifier.notify({ users: [user], event: 'test', title: 'Live', body: 'Hi', sms: 'Live test', critical: true, dedupe: 'live-1' });
    await until(/event: notification[\s\S]*"title":"Live"/);
    // Clear anything older tests left due, so only this notification is in play.
    s.db.prepare(`UPDATE sms_outbox SET status = 'skipped' WHERE status = 'queued'`).run();
    s.db.prepare(`UPDATE inbox SET sms_queued_at = created_at WHERE sms_queued_at IS NULL AND id != ?`).run(item.id);
    const mine = () => at.calls.filter((c) => c.to === '+254700000011');
    await s.tick();
    assert.equal(mine().length, 0, 'no SMS while it can still be seen in the app');
    s.clock.offset = 91e3; // past sms_fallback_seconds
    await s.tick();
    assert.equal(mine().length, 1, 'unseen after the fallback delay → SMS');
    assert.equal(mine()[0].message, 'Live test');
    // Seen items never trigger SMS.
    const [seen] = s.handler.notifier.notify({ users: [user], event: 'test', title: 'Seen', body: 'Hi', sms: 'Seen test', critical: true, dedupe: 'live-2' });
    await c.post('/api/inbox/seen', { ids: [seen.id, item.id] });
    s.clock.offset = 300e3;
    await s.tick();
    assert.equal(mine().length, 1);
    ctl.abort();
  });

  test('users can turn SMS down; emergencies still reach dispatch', async () => {
    s.db.prepare(`UPDATE users SET sms_pref = 'off' WHERE id = ?`).run(id('client2@v2.test'));
    const user = s.db.prepare('SELECT * FROM users WHERE id = ?').get(id('client2@v2.test'));
    s.handler.notifier.notify({ users: [user], event: 'test', title: 'x', body: 'y', sms: 'z', critical: true, dedupe: 'pref-off' });
    s.clock.offset = 600e3;
    await s.tick();
    assert.equal(at.calls.length, 0);
  });
});

describe('offline sync', () => {
  test('replaying a queued action with the same Idempotency-Key does not duplicate it', async () => {
    await clockIn('rider.a@v2.test');
    const rider = await as('rider.a@v2.test');
    const csrf = (await rider.get('/api/auth/me')).data.csrf;
    const post = (url, body, key) => fetch(s.base + url, {
      method: 'POST', body: JSON.stringify(body),
      headers: { Cookie: rider.cookie, Origin: ORIGIN, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    });
    const body = { type: 'breakdown', description: 'Puncture on Waiyaki Way' };
    const a = await post('/api/incidents', body, 'sync-key-0001');
    const b = await post('/api/incidents', body, 'sync-key-0001');
    assert.equal(a.status, 200);
    assert.equal(b.headers.get('idempotent-replay'), 'true');
    assert.equal((await a.json()).incident.id, (await b.json()).incident.id);
    assert.equal((await post('/api/overtime', { minutes: 30 }, 'sync-key-0001')).status, 422, 'a key cannot be reused for another action');
  });

  test('GPS captured offline is uploaded later and kept only for clocked-in time', async () => {
    const rider = await as('rider.a@v2.test');
    s.clock.offset = 600e3; // ten minutes into the shift
    const t = Date.now() + s.clock.offset;
    const pts = [
      { lat: -1.30, lng: 36.80, accuracy: 10, recordedAt: new Date(t - 120e3).toISOString() },
      { lat: -1.31, lng: 36.81, accuracy: 10, recordedAt: new Date(t - 60e3).toISOString() },
      { lat: 51.5, lng: -0.1, recordedAt: new Date(t - 30e3).toISOString() }, // outside Kenya
      { lat: -1.3, lng: 36.8, recordedAt: new Date(t - 3 * 864e5).toISOString() }, // too old
    ];
    const r = await rider.post('/api/location/batch', { points: pts });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { stored: 2, skipped: 2 });
    const live = (await availabilityOf('rider.a@v2.test'));
    assert.ok(live.lastSeenAt);
  });
});

describe('announcements and inbox', () => {
  test('dispatch announces to riders on shift; managers cannot', async () => {
    assert.equal((await (await as('manager@v2.test')).post('/api/announcements', { text: 'Hi' })).status, 403);
    const r = await (await as('dispatch@v2.test')).post('/api/announcements', { text: 'Heavy rain on Mombasa Road, avoid if possible', audience: 'on_shift' });
    assert.equal(r.status, 200);
    assert.ok(r.data.sent >= 1);
    const rider = await as('rider.a@v2.test');
    const box = (await rider.get('/api/inbox')).data;
    assert.ok(box.items.some((i) => i.event === 'announcement'));
    assert.equal((await rider.post('/api/inbox/seen', { all: true })).data.unread, 0);
  });
});

describe('offline app shell', () => {
  test('the service worker precaches every static file, and they are served with the right types', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
    const walk = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])))).flat();
    const files = (await walk(dist)).map((f) => f.slice(dist.length).replaceAll(path.sep, '/')).filter((f) => /\.(js|css|html|svg|png|webmanifest)$/.test(f) && f !== '/sw.js');
    const sw = await readFile(path.join(dist, 'sw.js'), 'utf8');
    const listed = JSON.parse(`[${/const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1].replaceAll("'", '"').replace(/,\s*$/, '')}]`);
    for (const f of files) assert.ok(listed.includes(f), `${f} is missing from the service worker precache`);
    for (const f of listed.filter((x) => x !== '/')) assert.ok(files.includes(f), `${f} is precached but does not exist`);
    const swRes = await fetch(`${s.base}/sw.js`);
    assert.match(swRes.headers.get('content-type'), /javascript/);
    assert.match((await fetch(`${s.base}/manifest.webmanifest`)).headers.get('content-type'), /manifest\+json/);
    const csp = swRes.headers.get('content-security-policy');
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /media-src 'self' blob:/);
  });
});
