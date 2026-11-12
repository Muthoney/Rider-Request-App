// On-device test of the Android app (emulator) through WebView DevTools + adb.
// Usage: node device.mjs <dbFile> <shotDir>
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const [DB, SHOTS] = process.argv.slice(2);
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); };
const db = () => new DatabaseSync(DB, { readOnly: true });
const shot = (n) => sh(`adb exec-out screencap -p > ${SHOTS}/${n}.png`);

async function page() {
  for (let i = 0; i < 30; i++) {
    try {
      const sock = sh(`adb shell cat /proc/net/unix | grep -o "webview_devtools_remote_[0-9]*" | sort -u | tail -1`);
      sh(`adb forward --remove-all; adb forward tcp:9333 localabstract:${sock}`);
      const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
      const p = (await b.pages()).find((x) => /localhost:3111|offline/.test(x.url()));
      if (p) return { b, p };
      b.disconnect();
    } catch {}
    await wait(1000);
  }
  throw new Error('WebView not reachable');
}
const geo = (lat, lng) => sh(`adb emu geo fix ${lng} ${lat}`);

let { b, p } = await page();
// Sign in as a rider.
await p.waitForSelector('input[type=email], #view', { timeout: 60000 });
if (await p.$('input[type=password]')) {
  await p.type('input[type=email]', 'rider.hassan@example.com');
  await p.type('input[type=password]', 'smoke-test-password-1');
  await p.click('button[type=submit]');
  await p.waitForSelector('#view', { timeout: 60000 });
}
await wait(2500);
shot('03-jobs');
const native = await p.evaluate(() => ({ native: !!window.Capacitor?.isNativePlatform?.(), plugins: Object.keys(window.Capacitor?.Plugins || {}) }));
ok('Runs inside the native app with the Capacitor bridge', native.native, native.plugins.join(', '));
ok('RiderTracker plugin is available', native.plugins.includes('RiderTracker'));
const swActive = await p.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration())?.active);
ok('Service worker active in the Android WebView', swActive);

// Clock in → native foreground service starts and posts GPS.
geo(-1.2864, 36.8172);
const me = await p.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);
if (!me.onShift) {
  await p.evaluate(() => { location.hash = '#/jobs'; });
  await wait(800);
  await p.click('#shift');
}
await wait(3000);
for (const [la, ln] of [[-1.2870, 36.8180], [-1.2900, 36.8200], [-1.2950, 36.8230]]) { geo(la, ln); await wait(6000); }
const fg = sh('adb shell dumpsys activity services ke.co.lookmedia.riders | grep -c TrackerService || true');
ok('Foreground location service is running', Number(fg) > 0);
let pts = db().prepare("SELECT COUNT(*) n FROM location_points WHERE rider_id = (SELECT id FROM users WHERE email='rider.hassan@example.com')").get().n;
ok('Native service posted live GPS to the server', pts > 0, `${pts} points`);

// Screen off: GPS keeps flowing.
sh('adb shell input keyevent KEYCODE_SLEEP');
const before = pts;
for (const [la, ln] of [[-1.3000, 36.8260], [-1.3050, 36.8290]]) { geo(la, ln); await wait(17000); }
pts = db().prepare("SELECT COUNT(*) n FROM location_points").get().n;
ok('GPS keeps reaching the server with the screen off', pts > before, `${pts - before} new points`);
sh('adb shell input keyevent KEYCODE_WAKEUP; adb shell wm dismiss-keyguard || true');
await wait(1500);

// Take an open job and collect it online.
const job = await p.evaluate(async () => {
  const { api } = await import('/js/api.js');
  const open = (await api.get('/api/jobs/available')).jobs;
  if (!open.length) return null;
  let r = (await api.post(`/api/requests/${open[0].id}/accept`, { version: open[0].version })).request;
  for (const pk of r.pickups) r = (await api.post(`/api/requests/${r.id}/collect`, { version: r.version, collectedFrom: 'Desk', pickupSeq: pk.seq })).request;
  await api.get('/api/requests?status=all'); await api.get(`/api/requests/${r.id}`);
  return r;
});
ok('Accepted and collected a job online', !!job && job.status === 'collected');

// Airplane mode: no network at all.
sh('adb shell cmd connectivity airplane-mode enable; adb reverse --remove tcp:3111 || true');
await wait(4000);
for (const [la, ln] of [[-1.3100, 36.8300], [-1.3150, 36.8330]]) { geo(la, ln); await wait(17000); }
const queuedNative = await p.evaluate(async () => (await window.Capacitor.Plugins.RiderTracker.status()).queued);
ok('Offline GPS is queued on the phone', queuedNative > 0, `${queuedNative} queued`);
const queued = await p.evaluate(async (j) => {
  const { api } = await import('/js/api.js');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const d = j.dropoffs[0];
  const r = await api.act('POST', `/api/requests/${j.id}/dropoffs/${d.id}/handover`, { version: j.version, receivedBy: 'Device Offline', photo: png, signature: png },
    { label: 'device handover', requestId: j.id, versioned: true, op: { kind: 'handover', dropoffId: d.id, outcome: 'delivered' } });
  const { enqueue, uid } = await import('/js/offline.js');
  const cid = uid();
  await enqueue({ id: cid, kind: 'incident', method: 'POST', url: '/api/incidents', label: 'device incident', body: { clientId: cid, type: 'breakdown', description: 'device-offline-test', photos: [png] }, media: [] });
  return r.queued;
}, job);
ok('Handover and incident are saved offline', queued);
await p.evaluate(() => { location.hash = '#/jobs'; });
await wait(1500);
shot('04-offline-jobs');

// Cold start with no network: kill the app and reopen it.
b.disconnect();
sh('adb shell am force-stop ke.co.lookmedia.riders');
await wait(1000);
sh('adb shell monkey -p ke.co.lookmedia.riders -c android.intent.category.LAUNCHER 1');
await wait(9000);
shot('05-cold-start-offline');
({ b, p } = await page());
await wait(2000);
const cold = await p.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 400), hasView: !!document.querySelector('#view') }));
ok('App opens with no network (cached shell + saved session)', cold.hasView && /Offline/i.test(cold.text), cold.url);
const stillQueued = await p.evaluate(async () => (await (await import('/js/offline.js')).pendingActions()).length).catch(() => -1);
ok('Queued actions survive an app restart', stillQueued >= 2, `${stillQueued} pending`);

// Back online → everything syncs exactly once.
sh('adb shell cmd connectivity airplane-mode disable; adb reverse tcp:3111 tcp:3111');
await wait(8000);
geo(-1.3200, 36.8360);
await wait(17000);
await p.evaluate(async () => { const { flush } = await import('/js/offline.js'); await flush(); }).catch(() => {});
await wait(3000);
const d = db();
const handovers = d.prepare("SELECT COUNT(*) n FROM records WHERE counterpart = 'Device Offline'").get().n;
const incidents = d.prepare("SELECT COUNT(*) n FROM incidents WHERE description = 'device-offline-test'").get().n;
const ptsAfter = d.prepare('SELECT COUNT(*) n FROM location_points').get().n;
ok('Offline handover synced exactly once', handovers === 1, `${handovers}`);
ok('Offline incident synced exactly once', incidents === 1, `${incidents}`);
ok('Queued GPS uploaded after reconnecting', ptsAfter > pts, `${ptsAfter - pts} more points`);
const left = await p.evaluate(async () => (await window.Capacitor.Plugins.RiderTracker.status()).queued);
ok('Native GPS queue emptied', left === 0, `${left} left`);
shot('06-synced');

// SOS dialog renders on the phone.
await p.evaluate(() => { location.hash = '#/jobs'; });
await wait(1500);
await p.click('.sos-fab');
await wait(1500);
shot('07-sos');
b.disconnect();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
