import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startServer, client, sampleRequest, ORIGIN } from './helpers.mjs';
import { lookupPlace, searchPlaces, isInKenya } from '../dist/js/kenya.js';
import { quote, trackKm, routeKm, FUEL_DEFAULTS } from '../dist/js/fuel.js';
import { createIntegrations, e164 } from '../server/integrations.mjs';

// Fake providers record what would have been sent.
const sent = { whatsapp: [], sms: [] };
const behaviour = { whatsappFails: false, smsFails: false };
const APP_SECRET = 'test-app-secret';
let messageSeq = 0;
const fake = {
  maps: { browserKey: '', mapId: '' },
  geocode: { configured: false },
  routes: { configured: false },
  whatsapp: {
    configured: true, verifyToken: 'verify-me', appSecret: APP_SECRET,
    async send(msg) {
      if (behaviour.whatsappFails) throw new Error('Recipient is not a WhatsApp user');
      sent.whatsapp.push(msg);
      return { id: `wamid.${++messageSeq}` };
    },
    validSignature: createIntegrations({ WHATSAPP_APP_SECRET: APP_SECRET }).whatsapp.validSignature,
  },
  sms: {
    configured: true,
    async send(msg) {
      if (behaviour.smsFails) throw new Error('InvalidPhoneNumber');
      sent.sms.push(msg);
      return { id: `ATXid_${sent.sms.length}` };
    },
  },
};

let s;
before(async () => {
  s = await startServer({ integrations: fake });
  s.user('admin@alpha.test', 'admin');
  s.user('manager@alpha.test', 'manager');
  s.user('dispatch@alpha.test', 'dispatcher');
  s.user('req.one@alpha.test', 'requester');
  s.user('req.two@alpha.test', 'requester');
  s.user('rider.a@alpha.test', 'rider', { phone: '0711 000 301' });
  s.user('rider.b@alpha.test', 'rider', { phone: '+254 722 000 302' });
  s.user('rider.nophone@alpha.test', 'rider');
});
after(() => s.close());
beforeEach(() => { sent.whatsapp.length = 0; sent.sms.length = 0; behaviour.whatsappFails = false; behaviour.smsFails = false; });

async function as(email) {
  const c = client(s.base);
  const r = await c.login(email);
  assert.equal(r.status, 200, `login ${email}`);
  return c;
}
async function createRequest(over) {
  const r = await (await as('req.one@alpha.test')).post('/api/requests', sampleRequest(over));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.request;
}
async function assignTo(email, req) {
  const d = await as('dispatch@alpha.test');
  const r = await d.post(`/api/requests/${req.id}/assign`, { version: req.version, riderId: s.ids[email] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await s.idle();
  return { d, request: r.data.request };
}

describe('rider notifications on assignment', () => {
  test('sends a WhatsApp message to the rider’s Kenyan mobile number with the job details', async () => {
    const req = await createRequest({ priority: 'urgent' });
    const { d } = await assignTo('rider.a@alpha.test', req);
    assert.equal(sent.whatsapp.length, 1);
    assert.equal(sent.sms.length, 0);
    const msg = sent.whatsapp[0];
    assert.equal(msg.to, '+254711000301');
    assert.match(msg.text, new RegExp(`URGENT New delivery ${req.ref}`));
    assert.match(msg.text, /HQ, Westlands/);
    assert.match(msg.text, /2 stops, first: Upper Hill Chambers/);
    assert.match(msg.text, new RegExp(`${ORIGIN}/#/requests/${req.id}`));
    assert.equal(msg.params.length, 5);
    const detail = await d.get(`/api/requests/${req.id}`);
    assert.equal(detail.data.notifications[0].channel, 'whatsapp');
    assert.equal(detail.data.notifications[0].status, 'sent');
    assert.ok(detail.data.activity.some((a) => a.action === 'notified'));
  });

  test('falls back to SMS when WhatsApp rejects the message', async () => {
    behaviour.whatsappFails = true;
    const req = await createRequest();
    const { d } = await assignTo('rider.b@alpha.test', req);
    assert.equal(sent.sms.length, 1);
    assert.equal(sent.sms[0].to, '+254722000302');
    const n = (await d.get(`/api/requests/${req.id}`)).data.notifications;
    assert.deepEqual(n.map((x) => `${x.channel}:${x.status}`), ['sms:sent', 'whatsapp:failed']);
    assert.match(n[1].error, /not a WhatsApp user/);
  });

  test('records a skipped notification when the rider has no mobile number', async () => {
    const req = await createRequest();
    const { d } = await assignTo('rider.nophone@alpha.test', req);
    assert.equal(sent.whatsapp.length + sent.sms.length, 0);
    const n = (await d.get(`/api/requests/${req.id}`)).data.notifications[0];
    assert.equal(n.status, 'skipped');
    assert.match(n.error, /no valid mobile number/);
  });

  test('a WhatsApp delivery failure reported by the webhook triggers the SMS fallback', async () => {
    const req = await createRequest();
    const { d } = await assignTo('rider.a@alpha.test', req);
    const wamid = `wamid.${messageSeq}`;
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'failed', errors: [{ title: 'Message undeliverable' }] }] } }] }] });
    const post = (sig) => fetch(`${s.base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: payload });
    assert.equal((await post('sha256=bad')).status, 403);
    const good = await post(`sha256=${createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`);
    assert.equal(good.status, 200);
    await s.idle();
    assert.equal(sent.sms.length, 1);
    const n = (await d.get(`/api/requests/${req.id}`)).data.notifications;
    assert.deepEqual(n.map((x) => `${x.channel}:${x.status}`), ['sms:sent', 'whatsapp:failed']);
  });

  test('webhook verification echoes the challenge only for the right token', async () => {
    const ok = await fetch(`${s.base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '12345');
    const bad = await fetch(`${s.base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    assert.equal(bad.status, 403);
  });

  test('staff can resend; requesters cannot see notifications', async () => {
    const req = await createRequest();
    const { d } = await assignTo('rider.a@alpha.test', req);
    const res = await d.post(`/api/requests/${req.id}/notify`);
    assert.equal(res.status, 200);
    assert.equal(sent.whatsapp.length, 2);
    const requester = await as('req.one@alpha.test');
    assert.deepEqual((await requester.get(`/api/requests/${req.id}`)).data.notifications, []);
    assert.equal((await requester.post(`/api/requests/${req.id}/notify`)).status, 403);
  });

  test('normalises Kenyan numbers to E.164', () => {
    assert.equal(e164('0711 000 301'), '+254711000301');
    assert.equal(e164('254 110 000 301'), '+254110000301');
    assert.equal(e164('+254-722-000-302'), '+254722000302');
    assert.equal(e164('12345'), null);
  });
});

describe('live GPS tracking', () => {
  test('riders share location only while on shift, and only inside Kenya', async () => {
    const rid = s.ids['rider.a@alpha.test'];
    const rider = await as('rider.a@alpha.test');
    const off = await rider.post('/api/location', { lat: -1.2864, lng: 36.8231, accuracy: 10 });
    assert.equal(off.status, 409);
    assert.equal(off.data.error, 'off_shift');
    await rider.post(`/api/riders/${rid}/shift`, { onShift: true });
    const outside = await rider.post('/api/location', { lat: 51.5, lng: -0.12, accuracy: 10 });
    assert.equal(outside.status, 400);
    assert.equal(outside.data.error, 'outside_kenya');
    const ok = await rider.post('/api/location', { lat: -1.2864, lng: 36.8231, accuracy: 10, speed: 20 });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.stored, true);
    const dup = await rider.post('/api/location', { lat: -1.2865, lng: 36.8232, accuracy: 10 });
    assert.equal(dup.data.stored, false, 'throttled within 4 seconds');

    const d = await as('dispatch@alpha.test');
    const live = await d.get('/api/live');
    const me = live.data.riders.find((r) => r.id === rid);
    assert.equal(me.onShift, true);
    assert.equal(me.location.lat, -1.2864);
    assert.equal((await (await as('req.one@alpha.test')).get('/api/live')).status, 403);
    assert.equal((await d.post('/api/location', { lat: -1.28, lng: 36.82 })).status, 403);

    await rider.post(`/api/riders/${rid}/shift`, { onShift: false });
    assert.equal((await d.get('/api/live')).data.riders.find((r) => r.id === rid).location, null);
  });

  test('requesters see the rider’s live position on their own in-progress request', async () => {
    const rid = s.ids['rider.b@alpha.test'];
    const req = await createRequest();
    await assignTo('rider.b@alpha.test', req);
    const rider = await as('rider.b@alpha.test');
    await rider.post(`/api/riders/${rid}/shift`, { onShift: true });
    await rider.post('/api/location', { lat: -1.2700, lng: 36.8100, accuracy: 8 });
    const mine = await (await as('req.one@alpha.test')).get(`/api/requests/${req.id}/track`);
    assert.equal(mine.status, 200);
    assert.equal(mine.data.rider.lat, -1.27);
    assert.deepEqual(mine.data.path, [], 'requesters do not get the full track');
    assert.equal((await (await as('req.two@alpha.test')).get(`/api/requests/${req.id}/track`)).status, 404);
    const staff = await (await as('dispatch@alpha.test')).get(`/api/requests/${req.id}/track`);
    assert.equal(staff.data.path.length, 1);
    await rider.post(`/api/riders/${rid}/shift`, { onShift: false });
  });
});

describe('Kenya-only pins and places', () => {
  test('rejects request pins outside Kenya or with one coordinate missing', async () => {
    const c = await as('req.one@alpha.test');
    const abroad = await c.post('/api/requests', sampleRequest({ pickup: { address: 'Kampala Road', lat: 0.3136, lng: 32.5811 } }));
    assert.equal(abroad.status, 400);
    assert.match(abroad.data.message, /in Kenya/);
    const half = await c.post('/api/requests', sampleRequest({ dropoffs: [{ address: 'Somewhere', lat: -1.29 }] }));
    assert.equal(half.status, 400);
    const ok = await c.post('/api/requests', sampleRequest({ pickup: { address: 'Sarit Centre', lat: -1.2610, lng: 36.8020 } }));
    assert.equal(ok.status, 200);
  });

  test('geocode falls back to the Kenyan landmark and street list', async () => {
    const c = await as('req.one@alpha.test');
    const r = await c.get('/api/geocode?q=Yaya%20Centre');
    assert.equal(r.status, 200);
    assert.equal(r.data.source, 'gazetteer');
    assert.equal(r.data.results[0].label, 'Yaya Centre');
    assert.ok(r.data.results.every((x) => isInKenya(x.lat, x.lng)));
    assert.equal((await (await as('rider.a@alpha.test')).get('/api/geocode?q=Yaya')).status, 403);
  });

  test('lookupPlace prefers landmarks and respects the named town', () => {
    assert.equal(lookupPlace('Triangle Agency, Argwings Kodhek Rd, Kilimani').name, 'Argwings Kodhek Road');
    assert.equal(lookupPlace('2nd floor, Yaya Centre, Argwings Kodhek Rd').name, 'Yaya Centre');
    assert.equal(lookupPlace('Bank branch, Moi Avenue').name, 'Moi Avenue');
    assert.equal(lookupPlace('Moi Avenue, Mombasa').name, 'Mombasa');
    assert.equal(lookupPlace('Nyali, Mombasa').name, 'Nyali');
    assert.equal(lookupPlace('Upper Hill Chambers, 4th floor').name, 'Upper Hill');
    assert.equal(lookupPlace('Studio 4, Kampala Road, Uganda'), null);
    assert.ok(searchPlaces('westgate').some((p) => p.label === 'Westgate Mall'));
    assert.equal(isInKenya(-1.28, 36.82), true);
    assert.equal(isInKenya(-6.8, 39.28), false); // Dar es Salaam
  });
});

describe('item handling', () => {
  test('"Keep cold" is no longer accepted and is hidden on older requests', async () => {
    const c = await as('req.one@alpha.test');
    assert.equal((await c.post('/api/requests', sampleRequest({ handling: ['cold'] }))).status, 400);
    const req = await createRequest({ handling: ['fragile'] });
    s.db.prepare(`UPDATE requests SET handling = '["fragile","cold"]' WHERE id = ?`).run(req.id);
    const got = await c.get(`/api/requests/${req.id}`);
    assert.deepEqual(got.data.request.handling, ['fragile']);
  });
});

describe('fuel tracking and quotes', () => {
  test('quote = base fee + fuel by distance + rider time, rounded up to KES 10', () => {
    const q = quote({ km: 14, minutes: 45 }, { ...FUEL_DEFAULTS, fuelPrice: 226.96, kmPerLitre: 35, timeRatePerHour: 200, baseFee: 100 });
    assert.equal(q.litres, 0.4);
    assert.equal(q.fuelCost, 90.78);
    assert.equal(q.timeCost, 150);
    assert.equal(q.total, 350); // 100 + 90.78 + 150 = 340.78 → 350
  });

  test('GPS track distance ignores jitter, inaccurate fixes, impossible jumps and long gaps', () => {
    const t = (m) => new Date(Date.UTC(2026, 10, 7, 8, m)).toISOString();
    const pts = [
      { lat: -1.2864, lng: 36.8231, accuracy: 10, recordedAt: t(0) },
      { lat: -1.28641, lng: 36.82311, accuracy: 10, recordedAt: t(1) }, // jitter
      { lat: -1.30, lng: 36.85, accuracy: 500, recordedAt: t(2) }, // inaccurate
      { lat: -1.2954, lng: 36.8231, accuracy: 10, recordedAt: t(3) }, // ~1 km south
      { lat: -2.5, lng: 36.8231, accuracy: 10, recordedAt: t(4) }, // impossible jump
      { lat: -1.0, lng: 37.0, accuracy: 10, recordedAt: t(200) }, // after a long gap
    ];
    const km = trackKm(pts);
    assert.ok(km > 0.95 && km < 1.05, `got ${km}`);
    assert.ok(routeKm([{ lat: -1.2864, lng: 36.8231 }, { lat: -1.2954, lng: 36.8231 }], 1.3) > 1.25);
  });

  test('managers set the Kenyan pump price; dispatchers cannot', async () => {
    const m = await as('manager@alpha.test');
    const d = await as('dispatch@alpha.test');
    assert.equal((await d.get('/api/fuel/settings')).data.settings.fuelPrice, FUEL_DEFAULTS.fuelPrice);
    assert.equal((await d.patch('/api/fuel/settings', { fuelPrice: 230 })).status, 403);
    assert.equal((await m.patch('/api/fuel/settings', { fuelPrice: 5 })).status, 400);
    const r = await m.patch('/api/fuel/settings', { fuelPrice: 230.5, kmPerLitre: 40, fuelPriceUpdatedAt: '2026-11-15' });
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.fuelPrice, 230.5);
    assert.equal(r.data.settings.fuelPriceUpdatedAt, '2026-11-15');
    assert.equal(r.data.settings.timeRatePerHour, FUEL_DEFAULTS.timeRatePerHour);
    const q = await d.post('/api/fuel/quote', { km: 40, minutes: 60 });
    assert.equal(q.data.quote.litres, 1);
    assert.equal(q.data.quote.fuelCost, 230.5);
    await m.patch('/api/fuel/settings', { fuelPrice: FUEL_DEFAULTS.fuelPrice, kmPerLitre: FUEL_DEFAULTS.kmPerLitre });
  });

  test('quotes from Kenyan stops, and request detail carries an estimate and, once delivered, the GPS trip cost', async () => {
    const c = await as('req.one@alpha.test');
    const byStops = await c.post('/api/fuel/quote', { stops: [{ address: 'Sarit Centre, Westlands' }, { address: 'Enterprise Road, Industrial Area' }] });
    assert.equal(byStops.status, 200);
    assert.equal(byStops.data.source, 'estimate');
    assert.ok(byStops.data.quote.km > 8 && byStops.data.quote.km < 14, `km ${byStops.data.quote.km}`);
    assert.equal((await c.post('/api/fuel/quote', { stops: [{ address: 'Nowhere special' }, { address: 'Moi Avenue' }] })).status, 400);

    const req = await createRequest({ dropoffs: [{ address: 'Upper Hill Chambers', lat: -1.2992, lng: 36.8137 }] });
    const est = (await c.get(`/api/requests/${req.id}`)).data.fuel;
    assert.ok(est.estimate.total > 0);
    assert.equal(est.actual, null);

    const rid = s.ids['rider.a@alpha.test'];
    const { request } = await assignTo('rider.a@alpha.test', req);
    const rider = await as('rider.a@alpha.test');
    await rider.post(`/api/riders/${rid}/shift`, { onShift: true });
    // Ride ~2 km in 500 m steps, recorded 1 minute apart (30 km/h).
    const base = Date.now();
    for (let i = 0; i <= 4; i++) {
      s.db.prepare('INSERT INTO location_points (company_id, rider_id, lat, lng, accuracy, recorded_at) VALUES (1, ?, ?, ?, 10, ?)')
        .run(rid, -1.2649 - i * 0.0045, 36.8028, new Date(base + i * 60e3).toISOString());
    }
    s.clock.offset = 6 * 60e3;
    let cur = (await rider.post(`/api/requests/${req.id}/collect`, { version: request.version, collectedFrom: 'Reception' })).data.request;
    cur = (await rider.post(`/api/requests/${req.id}/dropoffs/${cur.dropoffs[0].id}/handover`, { version: cur.version, receivedBy: 'Mercy' })).data.request;
    assert.equal(cur.status, 'delivered');
    const done = (await c.get(`/api/requests/${req.id}`)).data.fuel;
    assert.equal(done.actual.source, 'gps');
    assert.ok(done.actual.km >= 1.9 && done.actual.km <= 2.1, `gps km ${done.actual.km}`);

    const report = await (await as('dispatch@alpha.test')).get('/api/fuel/report?days=7');
    assert.equal(report.status, 200);
    assert.ok(report.data.trips.some((t) => t.id === req.id && t.source === 'gps'));
    assert.ok(report.data.riders.find((r) => r.id === rid).gpsKm >= 1.9);
    assert.equal((await c.get('/api/fuel/report')).status, 403);
    await rider.post(`/api/riders/${rid}/shift`, { onShift: false });
    s.clock.offset = 0;
  });
});
