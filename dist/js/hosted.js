// Hosted entry point. Only the sign-in and password screens load up front; operational
// views are imported after authentication and any required password replacement.
import { api, setCsrf, onAuthLost } from './api.js';
import { html, ic, avatar, ROLE_LABEL, toast, canRequest, readOnlyChip, openModal, timeAgo } from './ui.js';
import { idb, setCacheOwner, onSync, flush, pendingActions, discard, retry, syncStatus } from './offline.js';
import { startRealtime, stopRealtime, onUnread, markSeen, liveRefresh } from './realtime.js';
import { isNative, registerPush, askNotificationPermission, onResume, updateTrackerSession } from './native.js';

// Service worker: the app shell keeps working without a connection (HTTPS or localhost only).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const app = document.getElementById('app');
const state = { user: null, cleanup: [], navToken: 0 };

// ---------- theme ----------
const mq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  let pref = 'system';
  try { pref = localStorage.getItem('rr-theme') || 'system'; } catch {}
  const root = document.documentElement;
  root.classList.toggle('os-dark', mq.matches);
  if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref);
}
mq.addEventListener('change', applyTheme);
applyTheme();
export function setTheme(pref) {
  try { localStorage.setItem('rr-theme', pref); } catch {}
  applyTheme();
}
export const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark' ||
  (!document.documentElement.getAttribute('data-theme') && mq.matches);

// ---------- routes ----------
const STAFF = ['admin', 'manager', 'dispatcher'];
const CREATORS = ['admin', 'dispatcher', 'requester']; // managers are read-only
const ROUTES = [
  { path: '/', view: 'dashboard', roles: ['admin', 'manager', 'dispatcher', 'requester'] },
  { path: '/', view: 'jobs', roles: ['rider'] },
  { path: '/jobs', view: 'jobs', roles: ['rider'] },
  { path: '/requests', view: 'requests', roles: ['admin', 'manager', 'dispatcher', 'requester'] },
  { path: '/requests/new', view: 'request-form', roles: CREATORS },
  { path: '/requests/:id/edit', view: 'request-form', roles: CREATORS },
  { path: '/requests/:id', view: 'request-detail' },
  { path: '/dispatch', view: 'dispatch', roles: STAFF },
  { path: '/runs', view: 'runs', roles: [...STAFF, 'rider'] },
  { path: '/shifts', view: 'shifts', roles: [...STAFF, 'rider'] },
  { path: '/live', view: 'live', roles: STAFF },
  { path: '/fuel', view: 'fuel', roles: STAFF },
  { path: '/incidents', view: 'incidents', roles: [...STAFF, 'rider'] },
  { path: '/incidents/:id', view: 'incidents', roles: [...STAFF, 'rider'] },
  { path: '/reports', view: 'reports', roles: STAFF },
  { path: '/activity', view: 'activity' },
  { path: '/accounts', view: 'accounts', roles: ['admin'] },
  { path: '/settings', view: 'settings' },
];
const NAV = [
  { href: '#/', label: 'Dashboard', icon: 'home', roles: ['admin', 'manager', 'dispatcher', 'requester'], section: 'Overview' },
  { href: '#/jobs', label: 'My jobs', icon: 'bike', roles: ['rider'], section: 'Overview', match: ['/', '/jobs'] },
  { href: '#/requests', label: 'Requests', icon: 'list', roles: STAFF, section: 'Overview' },
  { href: '#/requests', label: 'My requests', icon: 'list', roles: ['requester'], section: 'Overview' },
  { href: '#/requests/new', label: 'New request', icon: 'plus', roles: CREATORS, section: 'Overview' },
  { href: '#/requests/new?schedule=1', label: 'Schedule delivery', icon: 'calendarPlus', roles: CREATORS, section: 'Overview', match: ['/requests/new?schedule'] },
  { href: '#/dispatch', label: 'Dispatch board', icon: 'board', roles: STAFF, section: 'Operations', badge: 'waiting' },
  { href: '#/runs', label: 'Runs', icon: 'route', roles: [...STAFF, 'rider'], section: 'Operations' },
  { href: '#/live', label: 'Live map', icon: 'gps', roles: STAFF, section: 'Operations' },
  { href: '#/shifts', label: 'Shifts', icon: 'power', roles: STAFF, section: 'Operations' },
  { href: '#/shifts', label: 'My shift', icon: 'power', roles: ['rider'], section: 'Operations' },
  { href: '#/incidents', label: 'Incidents', icon: 'sos', roles: STAFF, section: 'Operations', badge: 'incidents' },
  { href: '#/incidents', label: 'My incident reports', icon: 'sos', roles: ['rider'], section: 'Operations' },
  { href: '#/reports', label: 'Rider performance', icon: 'chart', roles: STAFF, section: 'Operations' },
  { href: '#/fuel', label: 'Fuel & quotes', icon: 'fuel', roles: STAFF, section: 'Operations' },
  { href: '#/activity', label: 'Activity', icon: 'activity', section: 'Operations' },
  { href: '#/accounts', label: 'Manage accounts', icon: 'users', roles: ['admin'], section: 'Admin' },
  { href: '#/settings', label: 'Settings', icon: 'settings', section: 'Admin' },
];

function matchRoute(path, role) {
  for (const r of ROUTES) {
    if (r.roles && !r.roles.includes(role)) continue;
    const keys = [];
    // Ids are numeric, so "/requests/new" never falls through to the request page for roles that can't create.
    const re = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return k === 'id' ? '(\\d+)' : '([^/]+)'; }) + '$');
    const m = path.match(re);
    if (m) return { ...r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
const currentPath = () => (location.hash.replace(/^#/, '').split('?')[0] || '/');
export const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
export const navigate = (path) => { if (`#${path}` === location.hash) render(); else location.hash = path; };

// ---------- shell ----------
function shellHtml(user) {
  const items = NAV.filter((n) => !n.roles || n.roles.includes(user.role));
  const sections = [...new Set(items.map((i) => i.section))];
  return html`
  <div class="shell">
    <aside class="side" id="side" aria-label="Main navigation">
      <a class="brand" href="#/">
        <span class="brand-mark">${ic('bike')}</span>
        <span><b>Rider Requests</b><small>${user.companyName}</small></span>
      </a>
      ${sections.map((s) => html`
        <div class="nav-label">${s}</div>
        <nav class="nav">${items.filter((i) => i.section === s).map((i) => html`
          <a href="${i.href}" data-match="${(i.match || [i.href.slice(1)]).join(',')}">${ic(i.icon)}<span>${i.label}</span>${i.badge ? html`<span class="count" data-badge="${i.badge}" hidden></span>` : ''}</a>`)}
        </nav>`)}
      <div class="side-foot">
        <div class="me">
          ${avatar(user.name)}
          <div class="grow"><b>${user.name}</b><small>${ROLE_LABEL[user.role]}</small></div>
          <button class="icon-btn" data-action="logout" title="Sign out" aria-label="Sign out">${ic('logout')}</button>
        </div>
      </div>
    </aside>
    <div class="backdrop" id="backdrop"></div>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" data-action="menu" aria-label="Open menu">${ic('menu')}</button>
        <a class="top-brand" href="#/"><span class="brand-mark">${ic('bike')}</span>Rider Requests</a>
        ${STAFF.includes(user.role) ? html`
        <form class="search" role="search" id="global-search">
          ${ic('search', 'sm')}
          <input name="q" placeholder="Search requests, addresses, people…" aria-label="Search requests" autocomplete="off">
          <kbd>/</kbd>
        </form>` : html`<div class="grow"></div>`}
        <div class="grow"></div>
        <button class="sync-chip" id="sync-chip" data-action="sync" hidden></button>
        ${user.role === 'rider' ? html`<a class="gps-chip" id="gps-chip" href="#/shifts" title="Location sharing">${ic('gpsOff', 'sm')}<span>Off shift</span></a>` : ''}
        <button class="icon-btn bell" data-action="inbox" title="Notifications" aria-label="Notifications">${ic('bell')}<span class="count" id="bell-count" hidden></span></button>
        <button class="icon-btn" data-action="theme" title="Toggle theme" aria-label="Toggle theme">${ic(isDark() ? 'sun' : 'moon')}</button>
        ${user.role === 'manager' ? readOnlyChip() : ''}
        ${canRequest(user) ? html`
          <a class="btn sm top-schedule" href="#/requests/new?schedule=1" title="Schedule a delivery for later">${ic('calendarPlus', 'sm')}<span>Schedule</span></a>
          <a class="btn primary sm" href="#/requests/new">${ic('plus', 'sm')}<span>New request</span></a>` : ''}
      </header>
      <main class="content" id="view" tabindex="-1"></main>
    </div>
    ${user.role === 'rider' ? html`<button class="sos-fab" data-action="sos" aria-label="Report an emergency">${ic('sos')}<span>SOS</span></button>` : ''}
  </div>`;
}

function mountShell() {
  app.innerHTML = String(shellHtml(state.user));
  const side = app.querySelector('#side');
  const backdrop = app.querySelector('#backdrop');
  const closeMenu = () => { side.classList.remove('open'); backdrop.classList.remove('show'); };
  backdrop.addEventListener('click', closeMenu);
  side.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
  app.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'menu') { side.classList.add('open'); backdrop.classList.add('show'); }
    if (a.dataset.action === 'theme') {
      setTheme(isDark() ? 'light' : 'dark');
      a.innerHTML = String(ic(isDark() ? 'sun' : 'moon'));
    }
    if (a.dataset.action === 'logout') {
      const waiting = (await pendingActions()).length;
      if (waiting && !confirm(`${waiting} action${waiting > 1 ? 's are' : ' is'} still waiting to sync. Sign out anyway? They stay on this phone and sync next time you sign in.`)) return;
      stopRiderTracking();
      stopRealtime();
      try { await api.post('/api/auth/logout'); } catch {}
      await idb.del('cache', 'last-me').catch(() => {});
      state.user = null; setCsrf(null); location.hash = '#/'; boot();
    }
    if (a.dataset.action === 'inbox') openInbox();
    if (a.dataset.action === 'sync') openSyncPanel();
    if (a.dataset.action === 'sos') {
      const [{ reportIncident }, jobs, ops] = await Promise.all([
        import('./incident.js'), api.get('/api/requests?status=open').catch(() => ({ requests: [] })), api.get('/api/ops/settings').catch(() => ({ settings: {} })),
      ]);
      const mine = (jobs.requests || []).filter((r) => r.rider?.id === state.user.id && ['assigned', 'collected'].includes(r.status));
      await reportIncident({ jobs: mine, dispatchPhone: ops.settings?.dispatchPhone });
    }
  });
  const search = app.querySelector('#global-search');
  search?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(search).get('q').trim();
    navigate(`/requests${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
      const i = app.querySelector('#global-search input');
      if (i) { e.preventDefault(); i.focus(); }
    }
  });
}

function highlightNav(path) {
  app.querySelectorAll('.nav a').forEach((a) => {
    const m = a.dataset.match.split(',');
    const on = m.some((x) => x === path || (x !== '/' && path.startsWith(x + '/') && !NAV.some((n) => n.href.slice(1) === path && n.href.slice(1) !== x)));
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

export async function refreshBadges() {
  const el = app.querySelector('[data-badge="waiting"]');
  const inc = app.querySelector('[data-badge="incidents"]');
  if (!el && !inc) return;
  try {
    const s = await api.get('/api/stats');
    const n = s.byStatus.pending || 0;
    if (el) { el.textContent = n; el.hidden = !n; }
    if (inc) { inc.textContent = s.openIncidents || 0; inc.hidden = !s.openIncidents; inc.classList.toggle('hot', !!s.openIncidents); }
  } catch {}
}

// ---------- notifications inbox ----------
async function openInbox() {
  let data;
  try { data = await api.get('/api/inbox?limit=40'); } catch (err) { toast(err.message, 'err'); return; }
  const choice = await openModal({
    title: 'Notifications', subtitle: data.unread ? `${data.unread} unread` : 'All caught up', iconName: 'bell', wide: false,
    body: data.items.length ? html`<div class="list inbox">${data.items.map((n) => html`
      <button type="button" class="list-item inbox-item ${n.seenAt ? '' : 'unread'} ${n.critical ? 'critical' : ''}" data-link="${n.link || ''}">
        <span class="avatar sm" style="background:${n.critical ? 'var(--danger-bg)' : 'var(--surface-3)'};color:${n.critical ? 'var(--danger)' : 'var(--muted)'}">${ic(n.event === 'emergency' ? 'sos' : n.event === 'announcement' ? 'megaphone' : n.critical ? 'alert' : 'bell', 'sm')}</span>
        <span class="grow" style="text-align:left"><b>${n.title}</b><span class="req-sub">${n.body}</span>
          <span class="req-sub">${timeAgo(n.createdAt)}${n.smsSent ? ' · also sent by SMS' : ''}</span></span>
      </button>`)}</div>` : html`<p class="muted">No notifications yet.</p>`,
    actions: html`<button type="button" class="btn" data-close>Close</button>${data.unread ? html`<button class="btn primary" type="submit">${ic('check', 'sm')} Mark all read</button>` : ''}`,
    onMount: ({ el, form, close }) => {
      el.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => close({ link: b.dataset.link })));
      form.addEventListener('submit', (e) => { e.preventDefault(); close({ all: true }); });
    },
  });
  if (choice?.all || choice?.link !== undefined) markSeen('all');
  if (choice?.link) location.hash = `#${choice.link}`;
}

// ---------- offline sync panel ----------
async function openSyncPanel() {
  const list = await pendingActions();
  const s = syncStatus();
  const res = await openModal({
    title: s.online ? 'Sync' : 'You are offline', iconName: s.online ? 'cloud' : 'wifiOff',
    subtitle: s.online ? (list.length ? 'These actions are being sent to the server.' : 'Everything is synced.') : 'Your work is saved on this phone and will be sent automatically when you are back online.',
    body: list.length ? html`<div class="list">${list.map((e) => html`
      <div class="list-item"><span class="avatar sm" style="background:${e.state === 'attention' ? 'var(--danger-bg)' : 'var(--st-pending-bg)'};color:${e.state === 'attention' ? 'var(--danger)' : 'var(--st-pending)'}">${ic(e.state === 'attention' ? 'alert' : 'clock', 'sm')}</span>
        <div class="grow"><b>${e.label || `${e.method} ${e.url}`}</b><div class="req-sub">Saved ${timeAgo(new Date(e.createdAt).toISOString())}${e.state === 'attention' ? html` · <span class="error-text">${e.error}</span>` : ''}</div></div>
        ${e.state === 'attention' ? html`<button type="button" class="btn sm" data-retry="${e.id}">Retry</button><button type="button" class="btn sm ghost" data-discard="${e.id}">Discard</button>` : ''}
      </div>`)}</div>` : html`<p class="muted">Nothing waiting.</p>`,
    actions: html`<button type="button" class="btn" data-close>Close</button><button class="btn primary" type="submit">${ic('refresh', 'sm')} Sync now</button>`,
    onMount: ({ el, form, close }) => {
      el.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => { await retry(b.dataset.retry); close(null); }));
      el.querySelectorAll('[data-discard]').forEach((b) => b.addEventListener('click', async () => {
        if (confirm('Discard this action? It will not be sent.')) { await discard(b.dataset.discard); close(null); }
      }));
      form.addEventListener('submit', (e) => { e.preventDefault(); close(true); });
    },
  });
  if (res) { await flush(); toast(syncStatus().pending ? 'Still waiting for a connection.' : 'Synced.'); }
}

function wireStatusChips() {
  const chip = app.querySelector('#sync-chip');
  onSync((s) => {
    if (!chip?.isConnected) return;
    const show = !s.online || s.pending || s.attention;
    chip.hidden = !show;
    chip.className = `sync-chip ${!s.online ? 'off' : s.attention ? 'warn' : 'busy'}`;
    chip.innerHTML = String(html`${ic(!s.online ? 'wifiOff' : s.attention ? 'alert' : 'cloud', 'sm')}<span>${!s.online ? `Offline${s.pending ? ` · ${s.pending} to sync` : ''}` : s.attention ? `${s.attention} need${s.attention === 1 ? 's' : ''} attention` : `Syncing ${s.pending}…`}</span>`);
    document.documentElement.classList.toggle('is-offline', !s.online);
  });
  const bell = app.querySelector('#bell-count');
  onUnread((n) => { if (bell?.isConnected) { bell.textContent = n > 99 ? '99+' : n; bell.hidden = !n; } });
}

// ---------- view rendering ----------
async function render() {
  if (!state.user) return;
  state.cleanup.splice(0).forEach((fn) => { try { fn(); } catch {} });
  document.querySelectorAll('.modal-back').forEach((m) => m.dispatchEvent(new CustomEvent('rr-close')));
  const token = ++state.navToken;
  const path = currentPath();
  const route = matchRoute(path, state.user.role);
  const view = app.querySelector('#view');
  if (!view) return;
  highlightNav(path);
  const host = document.createElement('div');
  view.replaceChildren(host);
  if (!route) {
    host.innerHTML = String(html`<div class="card"><div class="empty"><div class="art">${ic('alert')}</div><h3>Page not found</h3><p>That page doesn't exist or isn't available for your role.</p><a class="btn" href="#/">Back to dashboard</a></div></div>`);
    return;
  }
  host.innerHTML = String(html`<div class="stack"><div class="skel" style="height:34px;width:260px"></div><div class="skel" style="height:120px"></div><div class="skel" style="height:280px"></div></div>`);
  try {
    const mod = await import(`./views/${route.view}.js`);
    if (token !== state.navToken) return;
    const ctx = {
      user: state.user, params: route.params, query: query(), navigate, refreshBadges,
      setUser: (u) => { state.user = { ...state.user, ...u }; },
      onCleanup: (fn) => state.cleanup.push(fn),
      /** Re-run fn when the server says something changed (debounced). */
      onLive: (fn, types) => state.cleanup.push(liveRefresh((type, data) => { if (token === state.navToken && !document.querySelector('.modal-back')) fn(type, data); }, types)),
      poll: (fn, ms = 20000) => {
        const id = setInterval(() => { if (document.visibilityState === 'visible' && token === state.navToken) fn(); }, ms);
        state.cleanup.push(() => clearInterval(id));
      },
      isCurrent: () => token === state.navToken,
    };
    await mod.render(host, ctx);
    if (token === state.navToken) { view.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  } catch (err) {
    if (token !== state.navToken) return;
    host.innerHTML = String(html`<div class="card"><div class="empty"><div class="art">${ic('alert')}</div><h3>Couldn't load this page</h3><p>${err.message}</p><button class="btn" id="retry">${ic('refresh', 'sm')} Try again</button></div></div>`);
    host.querySelector('#retry')?.addEventListener('click', render);
  }
}

async function boot() {
  try {
    const me = await api.get('/api/auth/me');
    setCsrf(me.csrf);
    state.user = me.user;
    idb.put('cache', 'last-me', { user: me.user, csrf: me.csrf, at: Date.now() }).catch(() => {});
    if (isNative()) updateTrackerSession(me.csrf);
  } catch (err) {
    state.user = null;
    // Offline: keep working as the last signed-in user (the session cookie is still on this phone).
    if (err.status === 0) {
      const last = await idb.get('cache', 'last-me').catch(() => null);
      if (last?.user && !last.user.mustChange) { setCsrf(last.csrf); state.user = last.user; toast('Offline: showing your saved jobs. Actions will sync later.', 'warn'); }
    }
  }
  setCacheOwner(state.user?.id || null);
  if (!state.user) {
    const auth = await import('./views/login.js');
    const signedIn = (user, csrf) => { setCsrf(csrf); state.user = user; boot(); };
    const path = currentPath();
    const toLogin = () => { history.replaceState(null, '', '#/'); auth.renderLogin(app, { onSignedIn: signedIn, onForgot: toForgot }); };
    const toForgot = () => { history.replaceState(null, '', '#/forgot'); auth.renderForgot(app, { onBack: toLogin }); };
    if (path === '/reset') return auth.renderReset(app, { token: query().get('token') || '', onDone: toLogin, onForgot: toForgot });
    if (path === '/forgot') return toForgot();
    return auth.renderLogin(app, { onSignedIn: signedIn, onForgot: toForgot });
  }
  if (['/reset', '/forgot'].includes(currentPath())) history.replaceState(null, '', '#/');
  if (state.user.mustChange) {
    const { renderPasswordChange } = await import('./views/password.js');
    return renderPasswordChange(app, {
      user: state.user, forced: true,
      onDone: (user) => { state.user = user; toast('Password updated. Welcome aboard!'); boot(); },
      onLogout: async () => { try { await api.post('/api/auth/logout'); } catch {} state.user = null; boot(); },
    });
  }
  mountShell();
  wireStatusChips();
  refreshBadges();
  if (state.user.role === 'rider') startRiderTracking();
  startRealtime();
  badgeLive?.(); badgeLive = liveRefresh(refreshBadges, ['change', 'incident'], 1500);
  flush();
  if (isNative()) { askNotificationPermission(); registerPush(api); }
  render();
}
onResume(() => { if (state.user) { flush(); refreshBadges(); } });

let badgeLive = null;
// ---------- rider live location ----------
let trackerUnsub = null;
async function startRiderTracking() {
  const { syncTracking, onTracker } = await import('./tracker.js');
  trackerUnsub?.();
  trackerUnsub = onTracker((t) => {
    const chip = app.querySelector('#gps-chip');
    if (!chip) return;
    chip.className = `gps-chip ${t.status}`;
    chip.title = t.message;
    chip.innerHTML = String(html`${ic(t.status === 'live' ? 'gps' : 'gpsOff', 'sm')}<span>${t.status === 'live' ? 'Live GPS' : t.status === 'off' ? 'Off shift' : t.status === 'waiting' ? 'Finding GPS…' : 'GPS problem'}</span>`);
  });
  syncTracking(!!state.user.onShift);
}
function stopRiderTracking() {
  trackerUnsub?.(); trackerUnsub = null;
  import('./tracker.js').then((m) => m.stopTracking()).catch(() => {});
}

onAuthLost((err) => {
  if (!state.user) return;
  toast(err.code === 'password_change_required' ? 'Please replace your temporary password.' : 'Your session ended. Please sign in again.', 'warn');
  stopRiderTracking();
  stopRealtime();
  state.user = null;
  boot();
});
window.addEventListener('hashchange', render);
boot();
