import { icon } from './icons.js';

// ---------- safe HTML templating ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
function fmt(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += fmt(vals[i]); });
  return new Raw(out);
}
export const ic = (name, cls) => raw(icon(name, cls));

// ---------- metadata ----------
export const STATUS = {
  pending: { label: 'Waiting', icon: 'clock' },
  assigned: { label: 'Assigned', icon: 'bike' },
  collected: { label: 'In transit', icon: 'package' },
  delivered: { label: 'Delivered', icon: 'checkCircle' },
  cancelled: { label: 'Cancelled', icon: 'x' },
};
export const CATEGORY = {
  general: { label: 'General', icon: 'box', desc: 'Everyday deliveries — any available rider.' },
  triangle: { label: 'Triangle', icon: 'triangle', desc: 'Reserved for Triangle-designated riders.' },
  finance: { label: 'Finance', icon: 'coins', desc: 'Cash, cheques & finance documents. Reserved riders.' },
};
export const HANDLING = {
  fragile: { label: 'Fragile', icon: 'fragile' },
  keep_upright: { label: 'Keep upright', icon: 'arrowUp' },
  confidential: { label: 'Confidential', icon: 'lock' },
  signature: { label: 'Signature needed', icon: 'pen' },
  cash: { label: 'Cash / valuables', icon: 'coins' },
  documents: { label: 'Documents', icon: 'doc' },
  heavy: { label: 'Heavy / bulky', icon: 'weight' },
};
export const ROLE_LABEL = { admin: 'Administrator', manager: 'Manager', dispatcher: 'Dispatcher', requester: 'Requester', rider: 'Rider' };

// ---------- permissions (mirrors server/rules.mjs) ----------
export const STAFF = ['admin', 'manager', 'dispatcher'];
/** Staff who may change things; managers have read-only access. */
export const WRITERS = ['admin', 'dispatcher'];
export const isStaffUser = (u) => STAFF.includes(u?.role);
export const canWrite = (u) => WRITERS.includes(u?.role);
/** Who can create delivery requests. */
export const canRequest = (u) => ['admin', 'dispatcher', 'requester'].includes(u?.role);
export const readOnlyChip = () => html`<span class="badge b-readonly" title="Managers can view everything but not change it">${ic('eye')}Read-only</span>`;

// ---------- scheduling ----------
/** Pickups more than this far ahead are "scheduled later" rather than due now. */
export const SCHEDULE_LEAD_MS = 2 * 3600e3;
export const isUpcoming = (r) => !!r.scheduledAt && ['pending', 'assigned'].includes(r.status) && new Date(r.scheduledAt) > Date.now();
export const isScheduledLater = (r) => !!r.scheduledAt && new Date(r.scheduledAt) - Date.now() > SCHEDULE_LEAD_MS;
export const scheduleBadge = (r) => (isUpcoming(r) ? html`<span class="badge s-scheduled" title="Scheduled pickup">${ic('calendar')}${fmtDateTime(r.scheduledAt)}</span>` : '');
export const vehicleBadge = (v) => (v === 'electric' ? html`<span class="badge v-electric" title="Electric motorcycle">${ic('zap')}Electric</span>` : '');
export const exportBtn = (attr = 'data-export', label = 'Export to Excel') => html`<button type="button" class="btn sm export-btn" ${raw(attr)} title="Download as an Excel workbook (.xlsx)">${ic('download', 'sm')}<span>${label}</span></button>`;

export const statusBadge = (s) => html`<span class="badge dot s-${s}">${STATUS[s]?.label || s}</span>`;
export const categoryBadge = (c) => c === 'general' ? '' : html`<span class="badge c-${c}">${ic(CATEGORY[c].icon)}${CATEGORY[c].label}</span>`;
export const urgentBadge = (p) => p === 'urgent' ? html`<span class="badge p-urgent">${ic('flag')}Urgent</span>` : '';
export const roleBadge = (r) => html`<span class="badge r-${r}">${ROLE_LABEL[r] || r}</span>`;
export const tagBadges = (tags = []) => tags.map((t) => html`<span class="badge c-${t}">${ic(CATEGORY[t].icon)}${CATEGORY[t].label}</span>`);

const AV_COLORS = ['#16a34a', '#4f6bff', '#0ea5a4', '#a855f7', '#e11d48', '#d97706', '#16a34a', '#0284c7'];
export function avatar(name = '?', cls = '') {
  const parts = String(name).trim().split(/\s+/);
  const ini = ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = AV_COLORS[h % AV_COLORS.length], b = AV_COLORS[(h >>> 3) % AV_COLORS.length];
  return html`<span class="avatar ${cls}" style="background:linear-gradient(135deg, ${a}, ${b})" aria-hidden="true">${ini}</span>`;
}

// ---------- time formatting ----------
export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  const fut = s < 0; const a = Math.abs(s);
  const v = a < 45 ? 'just now' : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  if (v === 'just now') return v;
  return fut ? `in ${v}` : `${v} ago`;
}
export const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const day = same(d, today) ? 'Today' : same(d, tomorrow) ? 'Tomorrow' : same(d, yest) ? 'Yesterday'
    : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${fmtTime(iso)}`;
}
export const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
export const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
export const firstName = (n = '') => n.split(' ')[0];
export const telHref = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
export const mapsHref = (stop) => stop.lat != null
  ? `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.address)}`;

// ---------- toasts ----------
let toastHost;
export function toast(message, type = 'ok') {
  if (!toastHost) { toastHost = document.createElement('div'); toastHost.className = 'toasts'; toastHost.setAttribute('role', 'status'); document.body.append(toastHost); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = String(html`<span class="ti">${ic(type === 'err' ? 'x' : type === 'warn' ? 'alert' : 'check', 'sm')}</span><span>${message}</span>`);
  toastHost.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, type === 'err' ? 5200 : 3200);
}

// ---------- modals ----------
export function openModal({ title, subtitle, iconName = 'box', tone = '', body = '', actions = '', wide = false, onMount }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = String(html`
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mt">
        <form class="modal-form" novalidate>
          <div class="modal-head">
            <span class="mi ${tone}">${ic(iconName)}</span>
            <div class="grow"><h2 id="mt">${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : ''}</div>
            <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
          </div>
          <div class="modal-body">${body}</div>
          <div class="modal-foot">${actions}</div>
        </form>
      </div>`);
    const prevFocus = document.activeElement;
    document.body.append(back);
    const form = back.querySelector('form');
    const close = (value) => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Tab') {
        const f = [...back.querySelectorAll('button, input, select, textarea, a[href]')].filter((x) => !x.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    back.addEventListener('rr-close', () => close(null));
    const ctx = { el: back, form, close };
    onMount?.(ctx);
    (back.querySelector('[autofocus]') || back.querySelector('input, textarea, select, .btn.primary'))?.focus();
  });
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false, iconName = 'alert' }) {
  return openModal({
    title, subtitle: message, iconName, tone: danger ? 'warn' : '',
    actions: html`<button type="button" class="btn" data-close>Keep</button><button class="btn ${danger ? 'danger solid' : 'primary'}" type="submit">${confirm}</button>`,
    onMount: ({ form, close }) => form.addEventListener('submit', (e) => { e.preventDefault(); close(true); }),
  });
}

/** Wrap an async action on a button with a spinner + error toast. */
export async function busy(btn, fn) {
  if (btn?.disabled) return;
  const prev = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${btn.dataset.busy || ''}`; }
  try { return await fn(); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = prev; } }
}

export const formData = (form) => Object.fromEntries(new FormData(form).entries());

export function empty(iconName, title, text, action = '') {
  return html`<div class="empty"><div class="art">${ic(iconName)}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;
}

export function routeMini(r, max = 2) {
  const extra = r.dropoffs.length - max;
  return html`<div class="route-mini">
    <div><i class="p"></i><span class="t">${r.pickup.address}</span></div>
    ${r.dropoffs.slice(0, max).map((d) => html`<div><i class="d"></i><span class="t">${d.address}</span>${d.status === 'delivered' ? ic('check', 'sm') : ''}</div>`)}
    ${extra > 0 ? html`<div class="muted" style="padding-left:16px">+ ${extra} more stop${extra > 1 ? 's' : ''}</div>` : ''}
  </div>`;
}
