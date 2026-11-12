// Browser smoke test: every role, every page, phone and desktop widths, plus an offline cycle.
// Usage: node smoke.mjs <baseUrl> <shotDir>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
const [BASE, SHOTS] = process.argv.slice(2);
mkdirSync(SHOTS, { recursive: true });
const PASS = 'smoke-test-password-1';
const problems = [];
const RUN = `smoke-${Date.now().toString(36)}`;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream'] });

async function session(email, width) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: width < 600 ? 780 : 900, isMobile: width < 600, hasTouch: width < 600, deviceScaleFactor: 1 });
  await ctx.overridePermissions(BASE, ['geolocation']);
  await page.setGeolocation({ latitude: -1.2676, longitude: 36.8108, accuracy: 12 });
  const tag = `${email.split('@')[0]}@${width}`;
  page.on('pageerror', (e) => problems.push(`[${tag}] page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|fonts\.g/.test(m.text())) problems.push(`[${tag}] console: ${m.text()}`); });
  page.on('response', (r) => { const u = r.url(); if (u.startsWith(BASE) && r.status() >= 500) problems.push(`[${tag}] ${r.status()} ${u}`); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.type('input[type=email], input[name=email]', email);
  await page.type('input[type=password]', PASS);
  await Promise.all([page.waitForSelector('#view', { timeout: 15000 }), page.click('button[type=submit]')]);
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
  return { page, ctx, tag };
}
async function visit(s, hash, name) {
  await s.page.evaluate((h) => { location.hash = h; }, hash);
  await new Promise((r) => setTimeout(r, 300));
  await s.page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
  const info = await s.page.evaluate(() => {
    const W = window.innerWidth;
    // An element past the right edge is a problem unless an ancestor scrolls it on purpose (tables, maps).
    const scroller = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (['auto', 'scroll'].includes(o) || a.matches('.gmap, .map')) return true; } return false; };
    const wide = [...document.querySelectorAll('#view *, .topbar *')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > W + 1 && !scroller(e);
    });
    const leafs = wide.filter((e) => !wide.some((o) => o !== e && e.contains(o)));
    return {
      overflow: document.documentElement.scrollWidth - W,
      error: document.querySelector('#view .empty h3')?.textContent || '',
      wide: leafs.slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}(+${Math.round(e.getBoundingClientRect().right - W)}px)`),
    };
  });
  if (info.overflow > 1) problems.push(`[${s.tag}] ${hash}: page scrolls sideways by ${info.overflow}px`);
  if (info.wide.length) problems.push(`[${s.tag}] ${hash}: content cut off at the right edge: ${info.wide.join(', ')}`);
  if (/Couldn't load|Page not found/.test(info.error)) problems.push(`[${s.tag}] ${hash}: ${info.error}`);
  await s.page.screenshot({ path: `${SHOTS}/${s.tag.replace(/[@.]/g, '_')}_${name}.png`, fullPage: false });
}

const PAGES = {
  'dispatch@example.com': [['#/', 'dashboard'], ['#/dispatch', 'dispatch'], ['#/live', 'live'], ['#/incidents', 'incidents'], ['#/reports', 'reports'], ['#/shifts', 'shifts'], ['#/requests', 'requests'], ['#/settings', 'settings']],
  'admin@example.com': [['#/settings', 'settings'], ['#/accounts', 'accounts'], ['#/fuel', 'fuel']],
  'manager@example.com': [['#/dispatch', 'dispatch'], ['#/reports', 'reports']],
  'studio@example.com': [['#/', 'dashboard'], ['#/requests/new', 'form'], ['#/requests', 'requests']],
  'rider.hassan@example.com': [['#/jobs', 'jobs'], ['#/shifts', 'shift'], ['#/incidents', 'incidents']],
};
for (const width of [360, 1280]) {
  for (const [email, pages] of Object.entries(PAGES)) {
    const s = await session(email, width);
    for (const [hash, name] of pages) await visit(s, hash, name);
    // Open the first request page this user can see.
    const first = await s.page.evaluate(async () => (await (await fetch('/api/requests?status=all')).json()).requests?.[0]?.id).catch(() => null);
    if (first) await visit(s, `#/requests/${first}`, 'detail');
    await s.ctx.close();
  }
}

// ---- Rider flow incl. offline: clock in, accept, collect online, go offline, hand over + SOS, back online → sync ----
{
  const s = await session('rider.hassan@example.com', 360);
  const p = s.page;
  const api = (method, url, body) => p.evaluate(async (m, u, b) => {
    const me = await (await fetch('/api/auth/me')).json();
    const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, method, url, body);
  const me = (await api('GET', '/api/auth/me')).data.user;
  if (!me.onShift) await api('POST', `/api/riders/${me.id}/shift`, { onShift: true });
  // Clear any job left assigned by the sample data so the rider is free.
  const open = (await api('GET', '/api/jobs/available')).data.jobs;
  let job = open[0];
  const accepted = job ? await api('POST', `/api/requests/${job.id}/accept`, { version: job.version }) : null;
  if (!accepted || accepted.status !== 200) problems.push(`[offline] could not accept a job: ${JSON.stringify(accepted?.data)}`);
  job = accepted?.data?.request;
  if (job) {
    let cur = job;
    for (const pk of cur.pickups) cur = (await api('POST', `/api/requests/${cur.id}/collect`, { version: cur.version, collectedFrom: 'Desk', pickupSeq: pk.seq })).data.request;
    await visit(s, '#/jobs', 'jobs-online');
    await p.evaluate(() => { location.hash = `#/requests/${0}`; });
    await visit(s, `#/requests/${cur.id}`, 'detail-before-offline');
    // Go offline.
    await p.setOfflineMode(true);
    await p.evaluate(() => window.dispatchEvent(new Event('offline')));
    await visit(s, '#/jobs', 'jobs-offline');
    await visit(s, `#/requests/${cur.id}`, 'detail-offline');
    const offlineBanner = await p.evaluate(() => !!document.querySelector('.sync-chip.off') && /Offline/.test(document.body.innerText));
    if (!offlineBanner) problems.push('[offline] no offline indicator shown');
    // Queue a handover for drop-off 1 straight through the app's own code path (no UI typing).
    const queued = await p.evaluate(async (rid, did, version, RUN) => {
      const { api } = await import('/js/api.js');
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const res = await api.act('POST', `/api/requests/${rid}/dropoffs/${did}/handover`, { version, receivedBy: 'Offline Desk', photo: png, signature: png },
        { label: 'smoke handover', requestId: rid, versioned: true, op: { kind: 'handover', dropoffId: did, outcome: 'delivered' } });
      const { enqueue, uid } = await import('/js/offline.js');
      const cid = uid();
      await enqueue({ id: cid, kind: 'incident', method: 'POST', url: '/api/incidents', label: 'smoke incident', body: { clientId: cid, type: 'breakdown', description: RUN, photos: [] }, media: [] });
      return res.queued;
    }, cur.id, cur.dropoffs[0].id, cur.version, RUN);
    if (!queued) problems.push('[offline] handover was not queued while offline');
    await visit(s, '#/jobs', 'jobs-offline-pending');
    const pendingShown = await p.evaluate(() => /To sync|waiting to sync/i.test(document.body.innerText));
    if (!pendingShown) problems.push('[offline] pending-sync marker not shown');
    // Back online: flush, then check server state.
    await p.setOfflineMode(false);
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
    await p.evaluate(async () => { const { flush } = await import('/js/offline.js'); await flush(); });
    await new Promise((r) => setTimeout(r, 800));
    await p.evaluate(async () => { const { flush } = await import('/js/offline.js'); await flush(); });
    const after = (await api('GET', `/api/requests/${cur.id}`)).data;
    const d1 = after.request.dropoffs[0];
    if (d1.status !== 'delivered' || d1.receivedBy !== 'Offline Desk') problems.push(`[offline] handover did not sync: ${d1.status} ${d1.receivedBy}`);
    const handovers = after.records.filter((x) => x.kind === 'handover' && x.counterpart === 'Offline Desk').length;
    if (handovers !== 1) problems.push(`[offline] expected exactly one synced handover, got ${handovers}`);
    const incs = (await api('GET', '/api/incidents')).data.incidents.filter((i) => i.description === RUN).length;
    if (incs !== 1) problems.push(`[offline] expected exactly one synced incident, got ${incs}`);
    const left = await p.evaluate(async () => (await (await import('/js/offline.js')).pendingActions()).length);
    if (left) problems.push(`[offline] ${left} action(s) still queued after reconnecting`);
    await visit(s, '#/jobs', 'jobs-synced');
    // SOS dialog opens.
    await p.click('.sos-fab');
    await p.waitForSelector('.modal .inc-types', { timeout: 5000 }).catch(() => problems.push('[sos] dialog did not open'));
    await p.screenshot({ path: `${SHOTS}/rider_sos_dialog.png` });
  }
  await s.ctx.close();
}

await browser.close();
console.log(problems.length ? `PROBLEMS (${problems.length}):\n${problems.join('\n')}` : 'SMOKE OK: no errors, no sideways scrolling, offline cycle synced exactly once');
process.exit(problems.length ? 1 : 0);
