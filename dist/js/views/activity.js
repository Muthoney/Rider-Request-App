import { api } from '../api.js';
import { html, ic, timeAgo, fmtDateTime, empty } from '../ui.js';

const ICONS = {
  created: 'plus', edited: 'edit', assigned: 'bike', unassigned: 'bike', override: 'shield', collected: 'package',
  handover: 'hand', handover_failed: 'alert', delivered: 'checkCircle', cancelled: 'x', run: 'route', run_start: 'play',
  run_finish: 'stop', run_delete: 'trash', shift_added: 'calendar', shift_removed: 'calendar', account_created: 'user',
  account_updated: 'user', password_reset: 'key', password_changed: 'lock',
};
export const activityIcon = (a) => ICONS[a] || 'activity';

const FILTERS = [
  ['all', 'Everything', null],
  ['requests', 'Requests', ['created', 'edited', 'cancelled']],
  ['dispatch', 'Dispatch', ['assigned', 'unassigned', 'override', 'run', 'run_start', 'run_finish', 'run_delete']],
  ['delivery', 'Delivery', ['collected', 'handover', 'handover_failed', 'delivered']],
  ['overrides', 'Overrides', ['override']],
  ['admin', 'People & shifts', ['shift_added', 'shift_removed', 'account_created', 'account_updated', 'password_reset', 'password_changed']],
];

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
        <div class="search" style="width:280px">${ic('search', 'sm')}<input id="aq" placeholder="Filter activity…" value="${q}" aria-label="Filter activity"></div>
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
    const input = el.querySelector('#aq');
    input.addEventListener('input', () => { q = input.value; const pos = input.selectionStart; paint(); const i = el.querySelector('#aq'); i.focus(); i.setSelectionRange(pos, pos); });
  };
  paint();
  ctx.poll(async () => {
    if (el.querySelector('#aq') === document.activeElement) return;
    try { ({ activity } = await api.get('/api/activity?limit=300')); paint(); } catch {}
  }, 30000);
}
