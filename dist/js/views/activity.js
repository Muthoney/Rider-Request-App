import { api } from '../api.js';
import { html, ic, timeAgo, fmtDateTime, empty, exportBtn, busy, toast } from '../ui.js';
import { downloadXlsx, stamp } from '../xlsx.js';

const ICONS = {
  created: 'plus', edited: 'edit', assigned: 'bike', unassigned: 'bike', override: 'shield', collected: 'package',
  handover: 'hand', handover_failed: 'alert', delivered: 'checkCircle', cancelled: 'x', run: 'route', run_start: 'play',
  run_finish: 'stop', run_delete: 'trash', shift_added: 'calendar', shift_removed: 'calendar', shift_on: 'power', shift_off: 'power',
  notified: 'send', notify_failed: 'alert', fuel_settings: 'fuel', account_created: 'user',
  account_updated: 'user', password_reset: 'key', password_changed: 'lock', accepted: 'hand2',
  password_reset_sent: 'mail', password_reset_failed: 'alert', password_recovered: 'key',
};
export const activityIcon = (a) => ICONS[a] || 'activity';

const FILTERS = [
  ['all', 'Everything', null],
  ['requests', 'Requests', ['created', 'edited', 'cancelled']],
  ['dispatch', 'Dispatch', ['assigned', 'accepted', 'unassigned', 'override', 'run', 'run_start', 'run_finish', 'run_delete', 'notified', 'notify_failed']],
  ['delivery', 'Delivery', ['collected', 'handover', 'handover_failed', 'delivered']],
  ['overrides', 'Overrides', ['override']],
  ['admin', 'People & shifts', ['shift_added', 'shift_removed', 'shift_on', 'shift_off', 'fuel_settings', 'account_created', 'account_updated',
    'password_reset', 'password_changed', 'password_reset_sent', 'password_reset_failed', 'password_recovered']],
];

const ACTION_LABEL = {
  created: 'Created', edited: 'Edited', cancelled: 'Cancelled', assigned: 'Assigned', accepted: 'Accepted by rider', unassigned: 'Unassigned',
  override: 'Override', collected: 'Collected', handover: 'Handed over', handover_failed: 'Handover failed', delivered: 'Delivered',
  run: 'Added to run', run_start: 'Run started', run_finish: 'Run finished', run_delete: 'Run removed', notified: 'Rider notified',
  notify_failed: 'Notification failed', shift_on: 'On shift', shift_off: 'Off shift', fuel_settings: 'Fuel pricing',
  account_created: 'Account created', account_updated: 'Account updated', password_reset: 'Temporary password', password_changed: 'Password changed',
  password_reset_sent: 'Reset link sent', password_reset_failed: 'Reset link failed', password_recovered: 'Password recovered',
};

/** Saves activity rows as an Excel workbook. */
export function exportActivity(items, stem = 'activity', sheet = 'Activity') {
  if (!items.length) { toast('There is nothing to export yet.', 'warn'); return; }
  downloadXlsx(stamp(stem), {
    sheet,
    columns: [
      { header: 'Date & time', width: 18, value: (a) => new Date(a.createdAt) },
      { header: 'Request', width: 11, value: (a) => a.ref },
      { header: 'By', width: 22, value: (a) => a.user || 'System' },
      { header: 'Event', width: 20, value: (a) => ACTION_LABEL[a.action] || a.action },
      { header: 'Details', width: 90, value: (a) => a.message },
    ],
    rows: items,
  });
  toast(`Exported ${items.length} event${items.length === 1 ? '' : 's'} to Excel`);
}

function groupByDay(items) {
  const groups = new Map();
  for (const a of items) {
    const d = new Date(a.createdAt);
    const key = d.toDateString();
    if (!groups.has(key)) groups.set(key, { label: fmtDateTime(a.createdAt).split(',')[0], items: [] });
    groups.get(key).items.push(a);
  }
  return [...groups.values()];
}

export async function render(el, ctx) {
  let { activity } = await api.get('/api/activity?limit=300');
  let filter = ctx.query.get('f') || 'all';
  let q = '';
  const paint = () => {
    const f = FILTERS.find((x) => x[0] === filter);
    const items = activity.filter((a) => (!f[2] || f[2].includes(a.action)) &&
      (!q || `${a.message} ${a.ref || ''}`.toLowerCase().includes(q.toLowerCase())));
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>Activity</h1><p>A complete, append-only history of what happened and who did it.</p></div>
        <div class="row wrap">
          <div class="search" style="width:280px">${ic('search', 'sm')}<input id="aq" placeholder="Filter activity…" value="${q}" aria-label="Filter activity"></div>
          ${exportBtn()}
        </div>
      </div>
      <div class="tabs" role="tablist">${FILTERS.map(([k, label, acts]) => html`
        <button role="tab" class="${k === filter ? 'on' : ''}" aria-selected="${k === filter}" data-f="${k}">${label}<span class="n">${activity.filter((a) => !acts || acts.includes(a.action)).length}</span></button>`)}</div>
      ${items.length ? groupByDay(items).map((g) => html`
        <section class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>${g.label}</h3><span class="muted">${g.items.length} event${g.items.length > 1 ? 's' : ''}</span></div>
          <div class="timeline">${g.items.map((a) => html`
            <div class="tl a-${a.action}"><span class="ic">${ic(activityIcon(a.action))}</span>
              <div class="row between" style="align-items:flex-start">
                <div><div class="msg">${a.message}</div>
                  <div class="when">${new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${timeAgo(a.createdAt)}</div></div>
                ${a.ref ? html`<a class="btn sm ghost mono" href="#/requests/${a.requestId}">${a.ref}</a>` : ''}
              </div></div>`)}</div>
        </section>`) : html`<div class="card">${empty('activity', 'Nothing here', 'No events match this filter.')}</div>`}`);
    el.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; paint(); }));
    el.querySelector('[data-export]').addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try {
        // Export the full history (not just the 300 shown), with the current tab and search applied.
        const { activity: all } = await api.get('/api/activity?limit=5000');
        const keep = all.filter((a) => (!f[2] || f[2].includes(a.action)) && (!q || `${a.message} ${a.ref || ''}`.toLowerCase().includes(q.toLowerCase())));
        exportActivity(keep, filter === 'all' ? 'activity' : `activity-${filter}`);
      } catch (err) { toast(err.message, 'err'); }
    }));
    const input = el.querySelector('#aq');
    input.addEventListener('input', () => { q = input.value; const pos = input.selectionStart; paint(); const i = el.querySelector('#aq'); i.focus(); i.setSelectionRange(pos, pos); });
  };
  paint();
  ctx.poll(async () => {
    if (el.querySelector('#aq') === document.activeElement) return;
    try { ({ activity } = await api.get('/api/activity?limit=300')); paint(); } catch {}
  }, 30000);
}
