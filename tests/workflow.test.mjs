// Read-only managers, rider self-accept, scheduled requests, delivery proofs, password recovery
// with email → WhatsApp → SMS fallback, and electric motorcycles in fuel & quotes.
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, sampleRequest, PASSWORD, PNG, proof } from './helpers.mjs';
import { quote, FUEL_DEFAULTS, energyFor } from '../dist/js/fuel.js';
import { smtpSend } from '../server/integrations.mjs';
import net from 'node:net';

const outbox = { email: [], whatsapp: [], sms: [] };
const fail = { email: false, whatsapp: false, sms: false };
const fake = {
  maps: { browserKey: '', mapId: '' },
  geocode: { configured: false },
  routes: { configured: false },
  email: { configured: true, async send(m) { if (fail.email) throw new Error('SMTP down'); outbox.email.push(m); return { id: 'e1' }; } },
  whatsapp: {
    configured: true, verifyToken: '', appSecret: '', template: '', resetTemplate: '',
    async send(m) { if (fail.whatsapp) throw new Error('Not on WhatsApp'); outbox.whatsapp.push(m); return { id: 'w1' }; },
    validSignature: () => false,
  },
  sms: { configured: true, async send(m) { if (fail.sms) throw new Error('No route'); outbox.sms.push(m); return { id: 's1' }; } },
};

let s;
before(async () => {
  s = await startServer({ integrations: fake });
  s.user('admin@w.test', 'admin');
  s.user('manager@w.test', 'manager');
  s.user('dispatch@w.test', 'dispatcher');
  s.user('req@w.test', 'requester', { phone: '0711000401' });
  s.user('rider.gen@w.test', 'rider', { phone: '0711000402' });
  s.user('rider.tri@w.test', 'rider', { tags: ['triangle'] });
  s.user('rider.ev@w.test', 'rider');
  s.db.prepare(`UPDATE users SET vehicle = 'electric' WHERE email = 'rider.ev@w.test'`).run();
});
after(() => s.close());
beforeEach(() => { for (const k of Object.keys(outbox)) { outbox[k].length = 0; fail[k] = false; } });

async function as(email, password = PASSWORD) {
  const c = client(s.base);
  const r = await c.login(email, password);
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
  return c;
}
async function createRequest(over) {
  const r = await (await as('req@w.test')).post('/api/requests', sampleRequest(over));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.request;
}
const clearQueue = () => s.db.prepare(`UPDATE requests SET status = 'cancelled' WHERE status = 'pending'`).run();

describe('managers have read-only access; dispatchers read and write', () => {
  test('managers can read everything but change nothing', async () => {
    const req = await createRequest();
    const m = await as('manager@w.test');
    assert.equal((await m.get('/api/requests')).status, 200);
    assert.equal((await m.get(`/api/requests/${req.id}`)).status, 200);
    assert.equal((await m.get('/api/stats')).status, 200);
    assert.equal((await m.get('/api/live')).status, 200);
    assert.equal((await m.get('/api/fuel/report')).status, 200);
    assert.equal((await m.get('/api/activity')).status, 200);
    const rid = s.ids['rider.gen@w.test'];
    for (const [method, url, body] of [
      ['post', '/api/requests', sampleRequest()],
      ['patch', `/api/requests/${req.id}`, { ...sampleRequest(), version: req.version }],
      ['post', `/api/requests/${req.id}/cancel`, { version: req.version }],
      ['post', `/api/requests/${req.id}/assign`, { version: req.version, riderId: rid }],
      ['post', `/api/riders/${rid}/shift`, { onShift: true }],
      ['post', '/api/runs', { riderId: rid, requestIds: [req.id] }],
      ['patch', '/api/fuel/settings', { fuelPrice: 230 }],
    ]) {
      const r = await m[method](url, body);
      assert.equal(r.status, 403, `${method} ${url}`);
    }
    const d = await as('dispatch@w.test');
    assert.equal((await d.post(`/api/requests/${req.id}/assign`, { version: req.version, riderId: rid })).status, 200);
    await s.idle();
  });
});

describe('riders accept work themselves', () => {
  test('riders see and accept only the waiting jobs their designation allows', async () => {
    clearQueue();
    const general = await createRequest({ title: 'General parcel' });
    const triangle = await createRequest({ title: 'Triangle proofs', category: 'triangle' });
    const gen = await as('rider.gen@w.test');
    const tri = await as('rider.tri@w.test');

    const genJobs = (await gen.get('/api/jobs/available')).data.jobs.map((j) => j.id);
    assert.ok(genJobs.includes(general.id));
    assert.ok(!genJobs.includes(triangle.id), 'Triangle work is not offered to undesignated riders');
    // The Triangle rider is held for the waiting Triangle job, so general work is not offered to them.
    const triJobs = (await tri.get('/api/jobs/available')).data.jobs.map((j) => j.id);
    assert.deepEqual(triJobs, [triangle.id]);

    assert.equal((await gen.get(`/api/requests/${general.id}`)).status, 200, 'riders can open jobs they may accept');
    assert.equal((await gen.get(`/api/requests/${triangle.id}`)).status, 404);

    const offShift = await gen.post(`/api/requests/${general.id}/accept`, { version: general.version });
    assert.equal(offShift.status, 409);
    assert.equal(offShift.data.error, 'off_shift');
    await gen.post(`/api/riders/${s.ids['rider.gen@w.test']}/shift`, { onShift: true });
    await tri.post(`/api/riders/${s.ids['rider.tri@w.test']}/shift`, { onShift: true });

    const notMine = await gen.post(`/api/requests/${triangle.id}/accept`, { version: triangle.version });
    assert.equal(notMine.status, 403);
    assert.equal(notMine.data.error, 'not_eligible');

    const ok = await gen.post(`/api/requests/${general.id}/accept`, { version: general.version });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.request.status, 'assigned');
    assert.equal(ok.data.request.rider.id, s.ids['rider.gen@w.test']);
    const again = await tri.post(`/api/requests/${general.id}/accept`, { version: general.version });
    assert.equal(again.status, 409, 'a job can only be taken once');
    assert.equal(again.data.error, 'taken');

    const detail = await (await as('dispatch@w.test')).get(`/api/requests/${general.id}`);
    assert.ok(detail.data.activity.some((a) => a.action === 'accepted'));

    assert.equal((await tri.post(`/api/requests/${triangle.id}/accept`, { version: triangle.version })).status, 200);
    await gen.post(`/api/riders/${s.ids['rider.gen@w.test']}/shift`, { onShift: false });
    await tri.post(`/api/riders/${s.ids['rider.tri@w.test']}/shift`, { onShift: false });
  });

  test('administrators can still assign anyone, recording an override', async () => {
    clearQueue();
    const triangle = await createRequest({ category: 'triangle' });
    const a = await as('admin@w.test');
    const blocked = await a.post(`/api/requests/${triangle.id}/assign`, { version: triangle.version, riderId: s.ids['rider.gen@w.test'] });
    assert.equal(blocked.data.error, 'override_required');
    const forced = await a.post(`/api/requests/${triangle.id}/assign`, {
      version: triangle.version, riderId: s.ids['rider.gen@w.test'], override: { acknowledged: true, reason: 'Admin decision for today' },
    });
    assert.equal(forced.status, 200);
    await s.idle();
  });
});

describe('scheduled requests', () => {
  test('future pickups are accepted, past or far-off ones are refused, and stats count them', async () => {
    const c = await as('req@w.test');
    const inTwoDays = new Date(Date.now() + 2 * 864e5).toISOString();
    const ok = await c.post('/api/requests', sampleRequest({ scheduledAt: inTwoDays }));
    assert.equal(ok.status, 200);
    assert.equal(ok.data.request.scheduledAt, inTwoDays);
    assert.equal((await c.post('/api/requests', sampleRequest({ scheduledAt: new Date(Date.now() - 3600e3).toISOString() }))).status, 400);
    assert.equal((await c.post('/api/requests', sampleRequest({ scheduledAt: new Date(Date.now() + 400 * 864e5).toISOString() }))).status, 400);
    assert.ok((await c.get('/api/stats')).data.scheduled >= 1);
  });
});

describe('password recovery', () => {
  const tokenFrom = (text) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1];

  test('the same answer is given whether or not the account exists, and a link is emailed', async () => {
    const anon = client(s.base);
    const none = await anon.post('/api/auth/forgot', { email: 'nobody@w.test' });
    const real = await anon.post('/api/auth/forgot', { email: 'req@w.test' });
    assert.equal(none.status, 200);
    assert.deepEqual(none.data, real.data);
    await s.idle();
    assert.equal(outbox.email.length, 1);
    assert.equal(outbox.email[0].to, 'req@w.test');
    const token = tokenFrom(outbox.email[0].text);
    assert.ok(token);

    assert.equal((await anon.post('/api/auth/reset', { token, password: 'short' })).status, 400);
    const done = await anon.post('/api/auth/reset', { token, password: 'a-brand-new-passphrase-9' });
    assert.equal(done.status, 200);
    assert.equal((await anon.post('/api/auth/reset', { token, password: 'another-passphrase-10' })).data.error, 'bad_token', 'links work once');
    assert.equal((await client(s.base).login('req@w.test')).status, 401, 'the old password stops working');
    assert.equal((await client(s.base).login('req@w.test', 'a-brand-new-passphrase-9')).status, 200);
    s.db.prepare('UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = ?) WHERE email = ?').run('dispatch@w.test', 'req@w.test');
  });

  test('falls back to WhatsApp, then SMS, at the mobile number on the account', async () => {
    const anon = client(s.base);
    fail.email = true;
    await anon.post('/api/auth/forgot', { email: 'rider.gen@w.test' });
    await s.idle();
    assert.equal(outbox.email.length, 0);
    assert.equal(outbox.whatsapp.length, 1);
    assert.equal(outbox.whatsapp[0].to, '+254711000402');
    assert.ok(tokenFrom(outbox.whatsapp[0].text));
    assert.equal(outbox.whatsapp[0].template, '', 'the job template is never used for reset links');

    fail.whatsapp = true;
    await anon.post('/api/auth/forgot', { email: 'rider.gen@w.test' });
    await s.idle();
    assert.equal(outbox.sms.length, 1);
    const token = tokenFrom(outbox.sms[0].text);
    assert.ok(token);
    const sentBy = s.db.prepare(`SELECT channel FROM password_resets WHERE user_id = ? AND used_at IS NULL`).all(s.ids['rider.gen@w.test']);
    assert.deepEqual(sentBy.map((r) => r.channel), ['sms'], 'a new request replaces the previous link');
  });

  test('expired links are refused', async () => {
    await client(s.base).post('/api/auth/forgot', { email: 'manager@w.test' });
    await s.idle();
    const token = tokenFrom(outbox.email[0].text);
    s.clock.offset = 31 * 60e3;
    const r = await client(s.base).post('/api/auth/reset', { token, password: 'a-brand-new-passphrase-9' });
    s.clock.offset = 0;
    assert.equal(r.data.error, 'bad_token');
  });

  test('the SMTP client speaks plain SMTP (no TLS offered, no credentials)', async () => {
    const seen = [];
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      let data = false;
      let buf = '';
      sock.write('220 test ESMTP\r\n');
      sock.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (data) { if (line === '.') { data = false; sock.write('250 2.0.0 queued as ABC\r\n'); } else seen.push(line); continue; }
          seen.push(line);
          if (/^EHLO/.test(line)) sock.write('250-test\r\n250 8BITMIME\r\n');
          else if (/^(MAIL|RCPT)/.test(line)) sock.write('250 ok\r\n');
          else if (line === 'DATA') { data = true; sock.write('354 go\r\n'); }
          else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await smtpSend({ host: '127.0.0.1', port: server.address().port, secure: false, user: '', pass: '', from: 'Rider Requests <no-reply@w.test>', name: 'test' },
      { to: 'req@w.test', subject: 'Reset your password', text: 'Link: https://riders.test/#/reset?token=abc' });
    server.close();
    assert.match(res.id, /queued/);
    assert.ok(seen.includes('MAIL FROM:<no-reply@w.test>'));
    assert.ok(seen.includes('RCPT TO:<req@w.test>'));
    const body = Buffer.from(seen.slice(seen.indexOf('') + 1).join(''), 'base64').toString('utf8');
    assert.match(body, /token=abc/);
  });
});

describe('electric motorcycles in fuel and quotes', () => {
  test('electric quotes use kWh × electricity price; petrol uses litres × pump price', () => {
    const settings = { ...FUEL_DEFAULTS, electricityPrice: 24, kmPerKwh: 30, fuelPrice: 226.96, kmPerLitre: 35 };
    const ev = quote({ km: 30, minutes: 60, vehicle: 'electric' }, settings);
    assert.equal(ev.unit, 'kWh');
    assert.equal(ev.kwh, 1);
    assert.equal(ev.fuelCost, 24);
    assert.equal(ev.total, 330); // 100 + 24 + 200 = 324 → 330
    const petrol = quote({ km: 30, minutes: 60 }, settings);
    assert.equal(petrol.unit, 'L');
    assert.ok(petrol.fuelCost > ev.fuelCost);
    assert.equal(energyFor(60, 'electric', settings).amount, 2);
  });

  test('riders carry a vehicle; trip costs and the report follow it', async () => {
    const a = await as('admin@w.test');
    const updated = await a.patch(`/api/users/${s.ids['rider.tri@w.test']}`, { vehicle: 'electric' });
    assert.equal(updated.data.user.vehicle, 'electric');
    assert.equal((await a.patch(`/api/users/${s.ids['rider.tri@w.test']}`, { vehicle: 'diesel-truck' })).status, 400);
    await a.patch(`/api/users/${s.ids['rider.tri@w.test']}`, { vehicle: 'petrol' });

    const d = await as('dispatch@w.test');
    const set = await d.patch('/api/fuel/settings', { electricityPrice: 22, kmPerKwh: 32, defaultVehicle: 'electric' });
    assert.equal(set.status, 200);
    assert.equal(set.data.settings.defaultVehicle, 'electric');
    const q = await d.post('/api/fuel/quote', { km: 32, minutes: 30 });
    assert.equal(q.data.quote.vehicle, 'electric');
    assert.equal(q.data.quote.fuelCost, 22);
    assert.equal(q.data.compare.vehicle, 'petrol');

    clearQueue();
    const req = await createRequest({ dropoffs: [{ address: 'Upper Hill Chambers', lat: -1.2992, lng: 36.8137 }] });
    await d.post(`/api/requests/${req.id}/assign`, { version: req.version, riderId: s.ids['rider.ev@w.test'] });
    await s.idle();
    const fuel = (await d.get(`/api/requests/${req.id}`)).data.fuel;
    assert.equal(fuel.estimate.vehicle, 'electric');
    assert.equal(fuel.estimate.unit, 'kWh');
    await d.patch('/api/fuel/settings', { defaultVehicle: 'petrol' });
  });
});

describe('several pickups on one request', () => {
  test('each pickup is collected separately; the request is in transit once all are collected', async () => {
    clearQueue();
    const c = await as('req@w.test');
    const extraPickups = [{ address: 'Print House, Industrial Area', contactName: 'Print desk' }, { address: 'Sarit Centre, Westlands', lat: -1.2614, lng: 36.8026 }];
    assert.equal((await c.post('/api/requests', sampleRequest({ extraPickups: [{ address: '' }] }))).status, 400);
    assert.equal((await c.post('/api/requests', sampleRequest({ extraPickups: Array(5).fill({ address: 'X' }) }))).status, 400);
    const made = await c.post('/api/requests', sampleRequest({ extraPickups }));
    assert.equal(made.status, 200, JSON.stringify(made.data));
    let req = made.data.request;
    assert.deepEqual(req.pickups.map((p) => [p.seq, p.address, p.collected]), [[1, 'HQ, Westlands', false], [2, 'Print House, Industrial Area', false], [3, 'Sarit Centre, Westlands', false]]);

    const d = await as('dispatch@w.test');
    req = (await d.post(`/api/requests/${req.id}/assign`, { version: req.version, riderId: s.ids['rider.gen@w.test'] })).data.request;
    await s.idle();
    const rider = await as('rider.gen@w.test');
    const first = await rider.post(`/api/requests/${req.id}/collect`, { version: req.version, collectedFrom: 'Reception', photo: PNG, pickupSeq: 2 });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    req = first.data.request;
    assert.equal(req.status, 'assigned', 'still collecting');
    assert.equal(first.data.remainingPickups, 2);
    assert.deepEqual(req.pickups.map((p) => p.collected), [false, true, false]);
    assert.equal((await rider.post(`/api/requests/${req.id}/collect`, { version: req.version, collectedFrom: 'Again', photo: PNG, pickupSeq: 2 })).status, 409);
    assert.equal((await d.post(`/api/requests/${req.id}/assign`, { version: req.version, riderId: s.ids['rider.tri@w.test'] })).data.error, 'rider_fixed');
    assert.equal((await c.post(`/api/requests/${req.id}/cancel`, { version: req.version })).status, 403);
    assert.equal((await d.patch(`/api/requests/${req.id}`, { ...sampleRequest(), version: req.version })).status, 409, 'locked after the first pickup');
    assert.equal((await rider.post(`/api/requests/${req.id}/dropoffs/${req.dropoffs[0].id}/handover`, { version: req.version, receivedBy: 'M', ...proof() })).status, 409);

    req = (await rider.post(`/api/requests/${req.id}/collect`, { version: req.version, collectedFrom: 'Reception', photo: PNG })).data.request;
    assert.deepEqual(req.pickups.map((p) => p.collected), [true, true, false], 'without a pickupSeq the next uncollected pickup is used');
    const last = await rider.post(`/api/requests/${req.id}/collect`, { version: req.version, collectedFrom: 'Mall desk', photo: PNG });
    assert.equal(last.data.request.status, 'collected');
    assert.ok(last.data.request.collectedAt);
    const detail = await d.get(`/api/requests/${req.id}`);
    assert.deepEqual(detail.data.records.filter((r) => r.kind === 'collection').map((r) => r.pickupSeq), [2, 1, 3]);
    assert.ok(detail.data.fuel.estimate.totalStops === 5, 'route covers every pickup and drop-off');
    assert.ok((await d.get('/api/requests?q=Sarit')).data.requests.some((r) => r.id === req.id), 'search covers extra pickups');
  });
});

describe('activity export', () => {
  test('the activity feed can return more rows for exports', async () => {
    const d = await as('dispatch@w.test');
    const r = await d.get('/api/activity?limit=2000');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.activity));
  });
});
