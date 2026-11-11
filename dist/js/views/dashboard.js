import { api } from '../api.js';
import {
  html, ic, statusBadge, categoryBadge, urgentBadge, avatar, timeAgo, fmtDateTime, greeting, firstName, empty, routeMini, tagBadges,
  canRequest, readOnlyChip, isUpcoming, scheduleBadge, exportBtn, busy, toast,
} from '../ui.js';
import { activityIcon, exportActivity } from './activity.js';

const STAFF = ['admin', 'manager', 'dispatcher'];

function chart(days) {
  const W = 560, H = 210, L = 30, B = 26, T = 12;
  const max = Math.max(4, ...days.flatMap((d) => [d.created, d.delivered]));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const plotW = W - L - 6, plotH = H - B - T;
  const colW = plotW / days.length;
  const barW = Math.min(16, colW / 3.2);
  const y = (v) => T + plotH - (v / top) * plotH;
  const grid = [0, 1, 2, 3, 4].map((i) => {
    const v = i * step;
    return `<line class="grid-line" x1="${L}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }).join('');
  const bar = (x, v, cls) => {
    if (!v) return '';
    const h = Math.max(2, plotH * (v / top));
    const r = Math.min(4, h / 2);
    const yb = T + plotH, yt = yb - h;
    return `<path class="${cls}" d="M${x} ${yb} V${yt + r} Q${x} ${yt} ${x + r} ${yt} H${x + barW - r} Q${x + barW} ${yt} ${x + barW} ${yt + r} V${yb} Z"/>`;
  };
  const cols = days.map((d, i) => {
    const cx = L + colW * i + colW / 2;
    const label = new Date(d.date).toLocaleDateString([], { weekday: 'short' });
    return `<g class="col" data-i="${i}">
      <rect class="hl" x="${L + colW * i + 2}" y="${T}" width="${colW - 4}" height="${plotH}" rx="8"/>
      ${bar(cx - barW - 1, d.created, 'bar-1')}${bar(cx + 1, d.delivered, 'bar-2')}
      <text class="axis-label" x="${cx}" y="${H - 6}" text-anchor="middle">${i === days.length - 1 ? 'Today' : label}</text>
      <rect class="hit" x="${L + colW * i}" y="0" width="${colW}" height="${H}"/></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Requests created and delivered over the last 7 days">${grid}${cols}</svg>`;
}

function wireChart(root, days) {
  const box = root.querySelector('.chart');
  if (!box) return;
  const tip = document.createElement('div');
  tip.className = 'tooltip'; tip.hidden = true;
  box.append(tip);
  box.querySelectorAll('g.col').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      const d = days[+g.dataset.i];
      const r = g.querySelector('.hit').getBoundingClientRect();
      const b = box.getBoundingClientRect();
      tip.innerHTML = String(html`<b>${new Date(d.date).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}</b>
        <div class="r"><span><i style="background:var(--series-1)"></i>Created</span><b style="margin:0">${d.created}</b></div>
        <div class="r"><span><i style="background:var(--series-2)"></i>Delivered</span><b style="margin:0">${d.delivered}</b></div>`);
      tip.style.left = `${r.left - b.left + r.width / 2}px`;
      tip.style.top = `${30}px`;
      tip.hidden = false;
    });
    g.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

export async function render(el, ctx) {
  const staff = STAFF.includes(ctx.user.role);
  const load = () => Promise.all([
    api.get('/api/stats'),
    api.get('/api/requests?status=open'),
    api.get('/api/activity?limit=8'),
  ]);
  let [stats, { requests }, { activity }] = await load();

  const queueItem = (r) => html`
    <a class="list-item" href="#/requests/${r.id}">
      <span class="stop-n" style="display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:var(--surface-3)">${ic(r.category === 'triangle' ? 'triangle' : r.category === 'finance' ? 'coins' : 'box')}</span>
      <div class="grow">
        <div class="row wrap" style="gap:6px"><span class="req-title">${r.title}</span>${urgentBadge(r.priority)}${categoryBadge(r.category)}${scheduleBadge(r)}</div>
        <div class="req-sub"><span class="mono">${r.ref}</span>·<span>${r.dropoffs.length} drop-off${r.dropoffs.length > 1 ? 's' : ''}</span>·<span>${r.scheduledAt ? `Pickup ${fmtDateTime(r.scheduledAt)}` : `Requested ${timeAgo(r.createdAt)}`}</span></div>
      </div>
      ${ic('chevronRight', 'sm')}
    </a>`;

  const activityCard = () => html`
    <section class="card">
      <div class="card-head"><h2>Recent activity</h2>
        <div class="row" style="gap:6px">${exportBtn('data-export-activity', 'Export')}<a class="btn sm ghost" href="#/activity">All ${ic('chevronRight', 'sm')}</a></div></div>
      ${activity.length ? html`<div class="timeline">${activity.map((a) => html`
        <div class="tl a-${a.action}"><span class="ic">${ic(activityIcon(a.action))}</span>
          <div><div class="msg">${a.message}${a.ref ? html` · <a href="#/requests/${a.requestId}" class="mono">${a.ref}</a>` : ''}</div><div class="when">${timeAgo(a.createdAt)}</div></div></div>`)}</div>`
      : empty('activity', 'No activity yet', 'Actions on requests will appear here.')}
    </section>`;

  const chartCard = () => html`
    <section class="card">
      <div class="card-head">
        <div><h2>Last 7 days</h2><p>Requests created vs delivered per day</p></div>
        <div class="legend" aria-hidden="true"><span><i style="background:var(--series-1)"></i>Created</span><span><i style="background:var(--series-2)"></i>Delivered</span></div>
      </div>
      <div class="card-body">
        <div class="chart"></div>
        <details class="data-table"><summary>Show as table</summary>
          <table class="table"><thead><tr><th>Day</th><th>Created</th><th>Delivered</th></tr></thead>
          <tbody>${stats.days.map((d) => html`<tr><td>${new Date(d.date).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</td><td>${d.created}</td><td>${d.delivered}</td></tr>`)}</tbody></table>
        </details>
      </div>
    </section>`;

  const movingCard = (moving) => html`
    <section class="card">
      <div class="card-head"><div><h2>On the move</h2><p>Assigned and in-transit deliveries</p></div></div>
      ${moving.length ? html`<div class="grid g-2" style="padding:16px">${moving.map((r) => html`
        <a class="req-card ${r.priority === 'urgent' ? 'urgent' : ''} cat-${r.category}" href="#/requests/${r.id}">
          <div class="row between"><span class="mono muted">${r.ref}</span>${statusBadge(r.status)}</div>
          <b>${r.title}</b>
          ${routeMini(r, 1)}
          <div class="row" style="gap:8px">${avatar(r.rider?.name, 'sm')}<span class="muted" style="font-size:13px">${r.rider?.name}</span></div>
        </a>`)}</div>`
      : empty('bike', 'Nothing on the road', 'Assigned deliveries will show up here.')}
    </section>`;

  /** Requester home: one big call to action, WhatsApp import, then their deliveries. */
  const requesterHtml = () => {
    const s = stats.byStatus;
    const queue = requests.filter((r) => r.status === 'pending').slice(0, 6);
    const moving = requests.filter((r) => r.status !== 'pending').slice(0, 6);
    const upcoming = requests.filter(isUpcoming).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).slice(0, 5);
    return html`
    <div class="page-head">
      <div>
        <h1>${greeting()}, ${firstName(ctx.user.name)}</h1>
        <p>${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })} · Here is how your deliveries are moving.</p>
      </div>
    </div>

    <section class="cta-hero" aria-label="Request a delivery">
      <div class="cta-copy">
        <span class="cta-kicker">${ic('bike', 'sm')} Need something delivered?</span>
        <h2>Book a rider in under a minute</h2>
        <p>Add the pickup and drop-offs. Dispatch, or the first available rider, takes it from there.</p>
      </div>
      <div class="cta-actions">
        <a class="cta-btn" href="#/requests/new">${ic('plus', 'lg')}<span>Request a delivery</span></a>
        <a class="cta-ghost" href="#/requests/new?schedule=1">${ic('calendarPlus', 'sm')} Schedule for later</a>
      </div>
    </section>

    <a class="wa-banner" href="#/requests/new?import=1">
      <span class="wa-logo">${ic('whatsapp', 'lg')}</span>
      <span class="grow"><b>Got a WhatsApp request?</b><span>Paste the message and any map pins. We'll fill in the pickup, drop-offs and contacts for you.</span></span>
      <span class="btn sm wa-go">${ic('wand', 'sm')} Import a message</span>
    </a>

    <div class="stats four">
      <div class="card stat hero">
        <div class="k"><span class="dot">${ic('clock', 'sm')}</span>Waiting for a rider</div>
        <div class="v">${s.pending || 0}</div>
        <div class="s">${s.pending ? 'A rider will be assigned shortly' : 'Nothing waiting'}</div>
      </div>
      <div class="card stat">
        <div class="k"><span class="dot s-scheduled">${ic('calendar', 'sm')}</span>Scheduled</div>
        <div class="v">${stats.scheduled || 0}</div><div class="s">Future pickups</div>
      </div>
      <div class="card stat">
        <div class="k"><span class="dot s-collected">${ic('package', 'sm')}</span>In transit</div>
        <div class="v">${s.collected || 0}</div><div class="s">Collected, en route</div>
      </div>
      <div class="card stat">
        <div class="k"><span class="dot s-delivered">${ic('checkCircle', 'sm')}</span>Delivered today</div>
        <div class="v">${stats.deliveredToday}</div><div class="s">${s.delivered || 0} all time</div>
      </div>
    </div>

    <div class="grid g-main-wide">
      <div class="stack">
        <section class="card">
          <div class="card-head">
            <div><h2>Waiting for a rider</h2><p>Your requests that don't have a rider yet</p></div>
            <a class="btn sm ghost" href="#/requests?status=pending">View all ${ic('chevronRight', 'sm')}</a>
          </div>
          ${queue.length ? html`<div class="list">${queue.map(queueItem)}</div>`
            : empty('checkCircle', 'Nothing waiting', 'Every request you made has a rider.', html`<a class="btn primary" href="#/requests/new">${ic('plus', 'sm')} Request a delivery</a>`)}
        </section>
        ${movingCard(moving)}
        ${chartCard()}
      </div>
      <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>Upcoming</h2><p>Scheduled pickups</p></div><a class="btn sm ghost" href="#/requests?status=scheduled">All ${ic('chevronRight', 'sm')}</a></div>
          ${upcoming.length ? html`<div class="list">${upcoming.map((r) => html`
            <a class="list-item" href="#/requests/${r.id}">
              <span class="date-chip"><b>${new Date(r.scheduledAt).getDate()}</b><small>${new Date(r.scheduledAt).toLocaleDateString([], { month: 'short' })}</small></span>
              <div class="grow"><span class="req-title">${r.title}</span><div class="req-sub"><span class="mono">${r.ref}</span>·${fmtDateTime(r.scheduledAt)}${r.rider ? html`·${r.rider.name}` : ''}</div></div>
              ${statusBadge(r.status)}
            </a>`)}</div>`
          : html`<div class="card-body stack-sm" style="justify-items:start"><p class="muted" style="font-size:13px">No scheduled pickups. Book future deliveries ahead of time.</p>
              <a class="btn sm" href="#/requests/new?schedule=1">${ic('calendarPlus', 'sm')} Schedule a delivery</a></div>`}
        </section>
        ${activityCard()}
      </div>
    </div>`;
  };

  const paint = () => {
    if (!staff) {
      el.innerHTML = String(requesterHtml());
      el.querySelector('.chart').innerHTML = chart(stats.days);
      wireChart(el, stats.days);
      wireExport();
      return;
    }
    const s = stats.byStatus;
    const queue = requests.filter((r) => r.status === 'pending').slice(0, 6);
    const moving = requests.filter((r) => r.status !== 'pending').slice(0, 6);
    const onShift = stats.riders.filter((r) => r.onShift).length;
    el.innerHTML = String(html`
    <div class="page-head">
      <div>
        <h1>${greeting()}, ${firstName(ctx.user.name)}</h1>
        <p>${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })} · ${onShift} of ${stats.riders.length} riders on shift</p>
      </div>
      <div class="row wrap">
        ${ctx.user.role === 'manager' ? readOnlyChip() : ''}
        <a class="btn" href="#/dispatch">${ic('board', 'sm')} Open dispatch board</a>
        ${canRequest(ctx.user) ? html`<a class="btn" href="#/requests/new?schedule=1">${ic('calendarPlus', 'sm')} Schedule</a>
          <a class="btn primary" href="#/requests/new">${ic('plus', 'sm')} New request</a>` : ''}
      </div>
    </div>

    <div class="stats">
      <div class="card stat hero">
        <div class="k"><span class="dot">${ic('clock', 'sm')}</span>Waiting for a rider</div>
        <div class="v">${s.pending || 0}</div>
        <div class="s">${stats.reservedWaiting ? `${stats.reservedWaiting} reserved (Triangle/Finance)` : 'No reserved work waiting'}</div>
      </div>
      <div class="card stat">
        <div class="k"><span class="dot s-assigned">${ic('bike', 'sm')}</span>Assigned</div>
        <div class="v">${s.assigned || 0}</div><div class="s">Heading to pickup</div>
      </div>
      <div class="card stat">
        <div class="k"><span class="dot s-collected">${ic('package', 'sm')}</span>In transit</div>
        <div class="v">${s.collected || 0}</div><div class="s">Collected, en route</div>
      </div>
      <div class="card stat">
        <div class="k"><span class="dot s-delivered">${ic('checkCircle', 'sm')}</span>Delivered today</div>
        <div class="v">${stats.deliveredToday}</div><div class="s">${s.delivered || 0} all time</div>
      </div>
      <div class="card stat">
        <div class="k"><span class="dot p-urgent">${ic('flag', 'sm')}</span>Urgent open</div>
        <div class="v">${stats.urgentOpen}</div>
        <div class="s">${stats.avgMinutes ? `Avg. ${stats.avgMinutes} min to deliver (7d)` : 'No deliveries this week yet'}</div>
      </div>
    </div>

    <div class="grid g-main-wide">
      <div class="stack">
        <section class="card">
          <div class="card-head">
            <div><h2>Priority queue</h2><p>Urgent first, then Triangle and Finance, then by time</p></div>
            <a class="btn sm ghost" href="#/requests?status=pending">View all ${ic('chevronRight', 'sm')}</a>
          </div>
          ${queue.length ? html`<div class="list">${queue.map(queueItem)}</div>`
          : empty('checkCircle', 'Queue is clear', 'Every request has a rider. Nice work.')}
        </section>
        ${movingCard(moving)}
        ${chartCard()}
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>Riders</h2><p>Open jobs and shift status</p></div><a class="btn sm ghost" href="#/shifts">Shifts</a></div>
          <div class="list">${stats.riders.map((r) => html`
            <div class="list-item">
              ${avatar(r.name)}
              <div class="grow">
                <div class="row" style="gap:6px"><b>${r.name}</b>${tagBadges(r.tags)}</div>
                <div class="req-sub"><span class="${r.onShift ? 'onshift' : 'offshift'}"></span>${r.onShift ? 'On shift' : 'Off shift'} · ${r.openJobs} open · ${r.doneToday} done today</div>
                <div class="load"><i style="width:${Math.min(100, r.openJobs * 25)}%"></i></div>
              </div>
            </div>`)}</div>
        </section>
        ${activityCard()}
      </div>
    </div>`);
    el.querySelector('.chart').innerHTML = chart(stats.days);
    wireChart(el, stats.days);
    wireExport();
  };
  function wireExport() {
    el.querySelector('[data-export-activity]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try {
        const { activity: all } = await api.get('/api/activity?limit=5000');
        exportActivity(all, 'activity');
      } catch (err) { toast(err.message, 'err'); }
    }));
  }
  paint();
  ctx.poll(async () => {
    try { [stats, { requests }, { activity }] = await load(); if (ctx.isCurrent()) { paint(); ctx.refreshBadges(); } } catch {}
  }, 30000);
}
