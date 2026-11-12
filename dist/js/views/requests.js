import { api } from '../api.js';
import {
  html, ic, statusBadge, categoryBadge, urgentBadge, avatar, timeAgo, fmtDateTime, empty, HANDLING, STATUS, CATEGORY,
  canRequest, readOnlyChip, isUpcoming, scheduleBadge, exportBtn, toast,
} from '../ui.js';
import { downloadXlsx, stamp } from '../xlsx.js';

const TABS = [
  ['open', 'Open'], ['scheduled', 'Scheduled'], ['pending', 'Waiting'], ['assigned', 'Assigned'], ['collected', 'In transit'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['all', 'All'],
];

export async function render(el, ctx) {
  const staff = ['admin', 'manager', 'dispatcher'].includes(ctx.user.role);
  let status = ctx.query.get('status') || 'open';
  let q = ctx.query.get('q') || '';
  let category = 'all';
  let view = 'table';
  try { view = localStorage.getItem('rr-req-view') || 'table'; } catch {}
  let { requests } = await api.get('/api/requests?status=all');

  const counts = (s) => s === 'all' ? requests.length : s === 'open'
    ? requests.filter((r) => ['pending', 'assigned', 'collected'].includes(r.status)).length
    : s === 'scheduled' ? requests.filter(isUpcoming).length
      : requests.filter((r) => r.status === s).length;

  const filtered = () => requests.filter((r) => {
    if (status === 'open' && !['pending', 'assigned', 'collected'].includes(r.status)) return false;
    if (status === 'scheduled' && !isUpcoming(r)) return false;
    if (!['open', 'all', 'scheduled'].includes(status) && r.status !== status) return false;
    if (category !== 'all' && r.category !== category) return false;
    if (q) {
      const hay = `${r.ref} ${r.title} ${(r.pickups || [r.pickup]).map((p) => p.address).join(' ')} ${r.requester.name} ${r.rider?.name || ''} ${r.dropoffs.map((d) => `${d.address} ${d.contactName || ''}`).join(' ')}`.toLowerCase();
      if (!q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }).sort((a, b) => (status === 'scheduled' ? a.scheduledAt.localeCompare(b.scheduledAt) : 0));

  function exportList(list) {
    if (!list.length) { toast('There is nothing to export in this view.', 'warn'); return; }
    downloadXlsx(stamp(`requests-${status}`), {
      sheet: 'Requests',
      columns: [
        { header: 'Ref', width: 10, value: (r) => r.ref },
        { header: 'Description', width: 36, value: (r) => r.title },
        { header: 'Status', width: 12, value: (r) => STATUS[r.status]?.label || r.status },
        { header: 'Category', width: 11, value: (r) => CATEGORY[r.category]?.label },
        { header: 'Priority', width: 9, value: (r) => (r.priority === 'urgent' ? 'Urgent' : 'Normal') },
        { header: 'Scheduled pickup', width: 18, value: (r) => (r.scheduledAt ? new Date(r.scheduledAt) : 'ASAP') },
        { header: 'Pickups', width: 40, value: (r) => (r.pickups || [r.pickup]).map((p, i) => `${i + 1}. ${p.address}`).join('\n') },
        { header: 'Drop-offs', width: 50, value: (r) => r.dropoffs.map((d) => `${d.seq}. ${d.address}`).join('\n') },
        { header: 'Requester', width: 20, value: (r) => r.requester.name },
        { header: 'Rider', width: 20, value: (r) => r.rider?.name },
        { header: 'Created', width: 18, value: (r) => new Date(r.createdAt) },
        { header: 'Delivered', width: 18, value: (r) => (r.deliveredAt ? new Date(r.deliveredAt) : null) },
      ],
      rows: list,
    });
    toast(`Exported ${list.length} request${list.length === 1 ? '' : 's'} to Excel`);
  }

  const tableView = (list) => html`
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Request</th><th>Status</th><th class="hide-sm">Route</th>${staff ? html`<th class="hide-sm">Requester</th>` : ''}<th>Rider</th><th class="hide-sm">When</th></tr></thead>
      <tbody>${list.map((r) => html`
        <tr class="click" data-href="#/requests/${r.id}" tabindex="0">
          <td style="min-width:240px">
            <span class="req-title">${r.title}</span>
            <span class="req-sub"><span class="mono">${r.ref}</span>${urgentBadge(r.priority)}${categoryBadge(r.category)}${scheduleBadge(r)}
              ${r.handling.slice(0, 3).map((h) => html`<span title="${HANDLING[h].label}">${ic(HANDLING[h].icon, 'sm')}</span>`)}</span>
          </td>
          <td>${statusBadge(r.status)}</td>
          <td class="hide-sm" style="max-width:280px">
            <div class="req-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ic('pin', 'sm')}${r.pickup.address.split(',')[0]}${r.pickups?.length > 1 ? ` +${r.pickups.length - 1}` : ''} → ${r.dropoffs[0]?.address.split(',')[0]}${r.dropoffs.length > 1 ? ` +${r.dropoffs.length - 1}` : ''}</div>
          </td>
          ${staff ? html`<td class="hide-sm"><span class="row" style="gap:8px">${avatar(r.requester.name, 'sm')}<span>${r.requester.name}</span></span></td>` : ''}
          <td>${r.rider ? html`<span class="row" style="gap:8px">${avatar(r.rider.name, 'sm')}<span class="nowrap">${r.rider.name}</span></span>` : html`<span class="muted">—</span>`}</td>
          <td class="hide-sm nowrap muted">${isUpcoming(r) ? html`${ic('calendar', 'sm')} ${fmtDateTime(r.scheduledAt)}` : timeAgo(r.updatedAt)}</td>
        </tr>`)}</tbody></table></div></div>`;

  const cardView = (list) => html`<div class="grid g-3">${list.map((r) => html`
    <a class="req-card ${r.priority === 'urgent' ? 'urgent' : ''} cat-${r.category}" href="#/requests/${r.id}">
      <div class="row between"><span class="mono muted">${r.ref}</span>${statusBadge(r.status)}</div>
      <div><b style="font-size:15px">${r.title}</b><div class="row wrap" style="gap:6px;margin-top:6px">${urgentBadge(r.priority)}${categoryBadge(r.category)}${scheduleBadge(r)}</div></div>
      <div class="route-mini">
        ${(r.pickups || [r.pickup]).map((p) => html`<div><i class="p"></i><span class="t">${p.address}</span>${p.collected ? ic('check', 'sm') : ''}</div>`)}
        ${r.dropoffs.map((d) => html`<div><i class="d"></i><span class="t">${d.address}</span>${d.status === 'delivered' ? ic('check', 'sm') : ''}</div>`)}
      </div>
      <div class="row between" style="border-top:1px solid var(--line);padding-top:10px">
        <span class="row" style="gap:8px">${r.rider ? html`${avatar(r.rider.name, 'sm')}<span style="font-size:13px">${r.rider.name}</span>` : html`<span class="muted" style="font-size:13px">No rider yet</span>`}</span>
        <span class="muted" style="font-size:12px">${timeAgo(r.createdAt)}</span>
      </div>
    </a>`)}</div>`;

  const paint = () => {
    const list = filtered();
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>${staff ? 'Requests' : 'My requests'}</h1><p>${staff ? 'Every delivery request across your company.' : 'Deliveries you have requested.'}</p></div>
        <div class="row wrap">
          ${ctx.user.role === 'manager' ? readOnlyChip() : ''}
          ${exportBtn()}
          ${canRequest(ctx.user) ? html`<a class="btn" href="#/requests/new?schedule=1">${ic('calendarPlus', 'sm')} Schedule</a>
            <a class="btn primary" href="#/requests/new">${ic('plus', 'sm')} New request</a>` : ''}
        </div>
      </div>
      <div class="tabs" role="tablist">${TABS.map(([k, label]) => html`<button role="tab" data-s="${k}" class="${status === k ? 'on' : ''}" aria-selected="${status === k}">${label}<span class="n">${counts(k)}</span></button>`)}</div>
      <div class="toolbar">
        <div class="search" style="width:340px">${ic('search', 'sm')}<input id="q" value="${q}" placeholder="Search title, address, contact, RR-…" aria-label="Search"></div>
        ${staff ? html`<div class="seg" role="group" aria-label="Category">
          ${[['all', 'All'], ['general', 'General'], ['triangle', 'Triangle'], ['finance', 'Finance']].map(([k, l]) => html`<button data-c="${k}" class="${category === k ? 'on' : ''}">${l}</button>`)}
        </div>` : ''}
        <span class="grow"></span>
        <div class="seg" role="group" aria-label="Layout">
          <button data-v="table" class="${view === 'table' ? 'on' : ''}" aria-label="Table view">${ic('list', 'sm')}</button>
          <button data-v="cards" class="${view === 'cards' ? 'on' : ''}" aria-label="Card view">${ic('board', 'sm')}</button>
        </div>
      </div>
      ${list.length ? (view === 'cards' ? cardView(list) : tableView(list))
        : html`<div class="card">${empty(status === 'scheduled' ? 'calendar' : 'inbox', q ? 'No matches' : status === 'scheduled' ? 'No scheduled pickups' : 'No requests here',
          q ? `Nothing matches “${q}”.` : status === 'scheduled' ? 'Book future deliveries ahead of time and they will be listed here.' : 'Requests in this state will show up here.',
          canRequest(ctx.user) ? (status === 'scheduled' ? html`<a class="btn primary" href="#/requests/new?schedule=1">${ic('calendarPlus', 'sm')} Schedule a delivery</a>`
            : html`<a class="btn primary" href="#/requests/new">${ic('plus', 'sm')} Create a request</a>`) : '')}</div>`}`);

    el.querySelector('[data-export]').addEventListener('click', () => exportList(list));

    el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { status = b.dataset.s; paint(); }));
    el.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => { category = b.dataset.c; paint(); }));
    el.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      view = b.dataset.v; try { localStorage.setItem('rr-req-view', view); } catch {} paint();
    }));
    el.querySelectorAll('tr[data-href]').forEach((tr) => {
      tr.addEventListener('click', () => { location.hash = tr.dataset.href; });
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = tr.dataset.href; });
    });
    const input = el.querySelector('#q');
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { q = input.value.trim(); const pos = input.selectionStart; paint(); const i = el.querySelector('#q'); i.focus(); i.setSelectionRange(pos, pos); }, 180);
    });
  };
  paint();
  ctx.poll(async () => {
    if (el.querySelector('#q') === document.activeElement) return;
    try { ({ requests } = await api.get('/api/requests?status=all')); paint(); } catch {}
  }, 30000);
}
