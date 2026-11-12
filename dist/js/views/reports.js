// Rider performance for dispatchers, managers and administrators: client ratings (overall and by
// criterion), deliveries, delivery time, failed drop-offs, incidents, hours worked and overtime.
import { api } from '../api.js';
import { html, ic, avatar, tagBadges, empty, toast, exportBtn, fmtDateTime } from '../ui.js';
import { downloadXlsx, stamp } from '../xlsx.js';
import { starsShow } from './request-detail.js';

const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
const hrs = (m) => `${(m / 60).toFixed(1)} h`;

export async function render(el, ctx) {
  let days = 30;
  let perf, shifts;
  const load = async () => {
    const from = new Date(Date.now() - days * 864e5).toISOString();
    const to = new Date().toISOString();
    [perf, shifts] = await Promise.all([
      api.get(`/api/reports/riders?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      api.get(`/api/shifts/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    ]);
  };
  await load();

  const rows = () => perf.riders.map((p) => ({ ...p, hours: shifts.riders.find((s) => s.rider.id === p.rider.id) || { minutes: 0, overtimeMinutes: 0, approvedOvertimeMinutes: 0, unapprovedOvertimeMinutes: 0, shifts: 0 } }));
  const cell = (v) => (v == null ? html`<span class="muted">—</span>` : html`${starsShow(v)} <span class="muted">${v.toFixed(1)}</span>`);

  const paint = () => {
    const list = rows();
    const rated = list.filter((r) => r.ratings.count);
    const avg = rated.length ? rated.reduce((s, r) => s + r.ratings.stars * r.ratings.count, 0) / rated.reduce((s, r) => s + r.ratings.count, 0) : null;
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>Rider performance</h1><p>Client ratings, delivery record, incidents, hours and overtime for the last ${days} days.</p></div>
        <div class="row wrap"><div class="seg" role="group" aria-label="Period">${PERIODS.map(([d, l]) => html`<button data-d="${d}" class="${days === d ? 'on' : ''}">${l}</button>`)}</div>${exportBtn()}</div>
      </div>
      <div class="stats" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="card stat"><div class="k"><span class="dot s-delivered">${ic('star', 'sm')}</span>Average rating</div><div class="v">${avg ? avg.toFixed(1) : '—'}<small>${rated.reduce((s, r) => s + r.ratings.count, 0)} ratings</small></div></div>
        <div class="card stat"><div class="k"><span class="dot s-collected">${ic('checkCircle', 'sm')}</span>Deliveries</div><div class="v">${list.reduce((s, r) => s + r.deliveries, 0)}</div></div>
        <div class="card stat"><div class="k"><span class="dot s-pending">${ic('clock', 'sm')}</span>Hours worked</div><div class="v">${(list.reduce((s, r) => s + r.hours.minutes, 0) / 60).toFixed(0)}<small>h</small></div></div>
        <div class="card stat"><div class="k"><span class="dot s-failed">${ic('sos', 'sm')}</span>Incidents</div><div class="v">${list.reduce((s, r) => s + r.incidents, 0)}</div></div>
      </div>
      ${list.length ? html`<section class="card"><div class="table-wrap"><table class="table perf">
        <thead><tr><th>Rider</th><th>Rating</th><th class="hide-sm">Professionalism</th><th class="hide-sm">Timeliness</th><th class="hide-sm">Communication</th><th class="hide-sm">Handling</th>
          <th>Deliveries</th><th class="hide-sm">Avg time</th><th class="hide-sm">Failed</th><th class="hide-sm">Incidents</th><th>Hours</th><th>Overtime</th></tr></thead>
        <tbody>${list.map((r) => html`<tr>
          <td><span class="row" style="gap:8px">${avatar(r.rider.name, 'sm')}<span><b>${r.rider.name}</b><span class="row" style="gap:4px">${tagBadges(r.rider.tags)}</span></span></span></td>
          <td class="nowrap">${r.ratings.count ? html`${starsShow(r.ratings.stars)} <b>${r.ratings.stars.toFixed(1)}</b> <span class="muted">(${r.ratings.count})</span>` : html`<span class="muted">No ratings</span>`}</td>
          <td class="hide-sm nowrap">${cell(r.ratings.professionalism)}</td><td class="hide-sm nowrap">${cell(r.ratings.timeliness)}</td>
          <td class="hide-sm nowrap">${cell(r.ratings.communication)}</td><td class="hide-sm nowrap">${cell(r.ratings.handling)}</td>
          <td>${r.deliveries}</td><td class="hide-sm">${r.avgDeliveryMinutes != null ? `${r.avgDeliveryMinutes} min` : '—'}</td>
          <td class="hide-sm">${r.failedDropoffs}</td><td class="hide-sm">${r.incidents}</td>
          <td class="nowrap">${hrs(r.hours.minutes)} <span class="muted">· ${r.hours.shifts} shift${r.hours.shifts === 1 ? '' : 's'}</span></td>
          <td class="nowrap">${r.hours.overtimeMinutes ? html`${hrs(r.hours.overtimeMinutes)}${r.hours.unapprovedOvertimeMinutes ? html` <span class="badge s-failed" title="Not approved">${hrs(r.hours.unapprovedOvertimeMinutes)} unapproved</span>` : ''}` : html`<span class="muted">—</span>`}</td>
        </tr>`)}</tbody></table></div></section>` : html`<div class="card">${empty('chart', 'No riders yet', 'Add rider accounts to see their performance.')}</div>`}
      ${list.some((r) => r.comments.length) ? html`<section class="card" style="margin-top:20px"><div class="card-head"><h2>Recent client feedback</h2></div>
        <div class="list">${list.flatMap((r) => r.comments.map((c) => ({ ...c, rider: r.rider.name }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map((c) => html`
          <div class="list-item">${starsShow(c.stars)}<div class="grow"><b>${c.rider}</b> · <span class="mono">${c.ref}</span> · <span class="muted">${fmtDateTime(c.createdAt)}</span><div class="req-sub">“${c.comment}”</div></div></div>`)}</div></section>` : ''}`);
    el.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', async () => { days = +b.dataset.d; await load(); paint(); }));
    el.querySelector('[data-export]')?.addEventListener('click', () => {
      downloadXlsx(stamp('rider-performance'), {
        sheet: 'Rider performance',
        columns: [
          { header: 'Rider', width: 22, value: (r) => r.rider.name },
          { header: 'Ratings', width: 9, value: (r) => r.ratings.count },
          { header: 'Average stars', width: 12, value: (r) => r.ratings.stars },
          { header: 'Professionalism', width: 14, value: (r) => r.ratings.professionalism },
          { header: 'Timeliness', width: 11, value: (r) => r.ratings.timeliness },
          { header: 'Communication', width: 14, value: (r) => r.ratings.communication },
          { header: 'Handling', width: 10, value: (r) => r.ratings.handling },
          { header: 'Deliveries', width: 10, value: (r) => r.deliveries },
          { header: 'Avg delivery (min)', width: 16, value: (r) => r.avgDeliveryMinutes },
          { header: 'Failed drop-offs', width: 14, value: (r) => r.failedDropoffs },
          { header: 'Incidents', width: 10, value: (r) => r.incidents },
          { header: 'Hours', width: 8, value: (r) => Math.round((r.hours.minutes / 60) * 100) / 100 },
          { header: 'Overtime (h)', width: 12, value: (r) => Math.round((r.hours.overtimeMinutes / 60) * 100) / 100 },
          { header: 'Approved overtime (h)', width: 18, value: (r) => Math.round((r.hours.approvedOvertimeMinutes / 60) * 100) / 100 },
        ],
        rows: list,
      });
      toast('Exported to Excel');
    });
  };
  paint();
}
