// Hosted entry point. Only the sign-in and password screens load up front; operational
// views are imported after authentication and any required password replacement.
import { api, setCsrf, onAuthLost } from './api.js';
import { html, ic, avatar, ROLE_LABEL, toast } from './ui.js';

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
const ROUTES = [
  { path: '/', view: 'dashboard', roles: ['admin', 'manager', 'dispatcher', 'requester'] },
  { path: '/', view: 'jobs', roles: ['rider'] },
  { path: '/jobs', view: 'jobs', roles: ['rider'] },
  { path: '/requests', view: 'requests', roles: ['admin', 'manager', 'dispatcher', 'requester'] },
  { path: '/requests/new', view: 'request-form', roles: ['admin', 'manager', 'dispatcher', 'requester'] },
  { path: '/requests/:id/edit', view: 'request-form', roles: ['admin', 'manager', 'dispatcher', 'requester'] },
  { path: '/requests/:id', view: 'request-detail' },
  { path: '/dispatch', view: 'dispatch', roles: STAFF },
  { path: '/runs', view: 'runs', roles: [...STAFF, 'rider'] },
  { path: '/shifts', view: 'shifts', roles: [...STAFF, 'rider'] },
  { path: '/live', view: 'live', roles: STAFF },
  { path: '/fuel', view: 'fuel', roles: STAFF },
  { path: '/activity', view: 'activity' },
  { path: '/accounts', view: 'accounts', roles: ['admin'] },
  { path: '/settings', view: 'settings' },
];
const NAV = [
  { href: '#/', label: 'Dashboard', icon: 'home', roles: ['admin', 'manager', 'dispatcher', 'requester'], section: 'Overview' },
  { href: '#/jobs', label: 'My jobs', icon: 'bike', roles: ['rider'], section: 'Overview', match: ['/', '/jobs'] },
  { href: '#/requests', label: 'Requests', icon: 'list', roles: STAFF, section: 'Overview' },
  { href: '#/requests', label: 'My requests', icon: 'list', roles: ['requester'], section: 'Overview' },
  { href: '#/requests/new', label: 'New request', icon: 'plus', roles: ['admin', 'manager', 'dispatcher', 'requester'], section: 'Overview' },
  { href: '#/dispatch', label: 'Dispatch board', icon: 'board', roles: STAFF, section: 'Operations', badge: 'waiting' },
  { href: '#/runs', label: 'Runs', icon: 'route', roles: [...STAFF, 'rider'], section: 'Operations' },
  { href: '#/live', label: 'Live map', icon: 'gps', roles: STAFF, section: 'Operations' },
  { href: '#/shifts', label: 'Shifts', icon: 'power', roles: STAFF, section: 'Operations' },
  { href: '#/shifts', label: 'My shift', icon: 'power', roles: ['rider'], section: 'Operations' },
  { href: '#/fuel', label: 'Fuel & quotes', icon: 'fuel', roles: STAFF, section: 'Operations' },
  { href: '#/activity', label: 'Activity', icon: 'activity', section: 'Operations' },
  { href: '#/accounts', label: 'Manage accounts', icon: 'users', roles: ['admin'], section: 'Admin' },
  { href: '#/settings', label: 'Settings', icon: 'settings', section: 'Admin' },
];

function matchRoute(path, role) {
  for (const r of ROUTES) {
    if (r.roles && !r.roles.includes(role)) continue;
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
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
        ${user.role !== 'rider' ? html`
        <form class="search" role="search" id="global-search">
          ${ic('search', 'sm')}
          <input name="q" placeholder="Search requests, addresses, people…" aria-label="Search requests" autocomplete="off">
          <kbd>/</kbd>
        </form>` : html`<div class="grow"></div>`}
        <div class="grow"></div>
        ${user.role === 'rider' ? html`<a class="gps-chip" id="gps-chip" href="#/shifts" title="Location sharing">${ic('gpsOff', 'sm')}<span>Off shift</span></a>` : ''}
        <button class="icon-btn" data-action="theme" title="Toggle theme" aria-label="Toggle theme">${ic(isDark() ? 'sun' : 'moon')}</button>
        ${user.role !== 'rider' ? html`<a class="btn primary sm" href="#/requests/new">${ic('plus', 'sm')}<span>New request</span></a>` : ''}
      </header>
      <main class="content" id="view" tabindex="-1"></main>
    </div>
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
      stopRiderTracking();
      try { await api.post('/api/auth/logout'); } catch {}
      state.user = null; setCsrf(null); location.hash = '#/'; boot();
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
  if (!el) return;
  try {
    const s = await api.get('/api/stats');
    const n = s.byStatus.pending || 0;
    el.textContent = n; el.hidden = !n;
  } catch {}
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
  } catch {
    state.user = null;
  }
  if (!state.user) {
    const { renderLogin } = await import('./views/login.js');
    return renderLogin(app, { onSignedIn: (user, csrf) => { setCsrf(csrf); state.user = user; boot(); } });
  }
  if (state.user.mustChange) {
    const { renderPasswordChange } = await import('./views/password.js');
    return renderPasswordChange(app, {
      user: state.user, forced: true,
      onDone: (user) => { state.user = user; toast('Password updated. Welcome aboard!'); boot(); },
      onLogout: async () => { try { await api.post('/api/auth/logout'); } catch {} state.user = null; boot(); },
    });
  }
  mountShell();
  refreshBadges();
  if (state.user.role === 'rider') startRiderTracking();
  render();
}

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
  state.user = null;
  boot();
});
window.addEventListener('hashchange', render);
boot();
