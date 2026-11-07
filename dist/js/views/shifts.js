import { api } from '../api.js';
import { html, ic, avatar, tagBadges, fmtTime, fmtDateTime, empty, busy } from '../ui.js';
import { setShift } from './actions.js';
import { onTracker } from '../tracker.js';

const STAFF = ['admin', 'manager', 'dispatcher'];
const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60e3)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };

export async function render(el, ctx) {
  const staff = STAFF.includes(ctx.user.role);
  let riders = [];
  let log = [];
  let me = { ...ctx.user };
  let trackerOff = () => {};
  ctx.onCleanup(() => trackerOff());

  const load = async () => {
    const from = new Date(Date.now() - 7 * 864e5).toISOString();
    const [shifts, stats] = await Promise.all([
      api.get(`/api/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(Date.now() + 864e5).toISOString())}`),
      staff ? api.get('/api/stats') : Promise.resolve(null),
    ]);
    log = shifts.shifts.slice().sort((a, b) => b.startsAt.localeCompare(a.startsAt));
    riders = staff ? stats.riders : [{ id: me.id, name: me.name, tags: me.tags, onShift: !!me.onShift, onShiftSince: me.onShiftSince }];
  };
  await load();

  const todayMs = (rd) => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const t0 = start.getTime(), t1 = Date.now();
    let ms = log.filter((s) => s.rider.id === rd.id).reduce((sum, s) => sum + Math.max(0, Math.min(+new Date(s.endsAt), t1) - Math.max(+new Date(s.startsAt), t0)), 0);
    if (rd.onShift && rd.onShiftSince) ms += t1 - Math.max(+new Date(rd.onShiftSince), t0);
    return ms;
  };

  const toggle = (rd, big = false) => html`
    <button class="shift-toggle ${rd.onShift ? 'on' : ''} ${big ? 'big' : ''}" data-toggle="${rd.id}" aria-pressed="${rd.onShift ? 'true' : 'false'}"
      aria-label="${rd.name}: ${rd.onShift ? 'on shift, switch off' : 'off shift, switch on'}">
      <span class="knob">${ic('power', 'sm')}</span><span class="txt">${rd.onShift ? 'On shift' : 'Off shift'}</span>
    </button>`;

  const card = (rd) => html`
    <section class="card rider-shift ${rd.onShift ? 'is-on' : ''}">
      <div class="row" style="gap:12px">
        ${avatar(rd.name)}
        <div class="grow"><b>${rd.name}</b>
          <div class="req-sub"><span class="${rd.onShift ? 'onshift' : 'offshift'}"></span>${rd.onShift ? `Since ${fmtTime(rd.onShiftSince)} · ${dur(Date.now() - new Date(rd.onShiftSince))}` : 'Not on shift'}</div>
          <div class="row" style="gap:4px;margin-top:4px">${tagBadges(rd.tags)}</div>
        </div>
      </div>
      <div class="row between" style="margin-top:14px">
        <span class="muted" style="font-size:12.5px">Today: <b>${dur(todayMs(rd))}</b>${rd.openJobs != null ? ` · ${rd.openJobs} open job${rd.openJobs === 1 ? '' : 's'}` : ''}</span>
        ${toggle(rd)}
      </div>
    </section>`;

  const logTable = () => log.length ? html`<div class="table-wrap"><table class="table"><thead><tr>${staff ? html`<th>Rider</th>` : ''}<th>Started</th><th>Ended</th><th>Length</th></tr></thead><tbody>
    ${log.slice(0, 50).map((s) => html`<tr>${staff ? html`<td>${s.rider.name}</td>` : ''}<td class="nowrap">${fmtDateTime(s.startsAt)}</td><td class="nowrap">${fmtDateTime(s.endsAt)}</td><td class="nowrap muted">${dur(new Date(s.endsAt) - new Date(s.startsAt))}</td></tr>`)}
    </tbody></table></div>` : html`<div class="card-body muted">No completed shifts in the last 7 days.</div>`;

  const paint = () => {
    const on = riders.filter((r) => r.onShift);
    const totalToday = riders.reduce((s, r) => s + todayMs(r), 0);
    if (staff) {
      el.innerHTML = String(html`
        <div class="page-head">
          <div><h1>Shifts</h1><p>Switch riders on and off shift. Riders on shift show on the dispatch board and share their live GPS position.</p></div>
          <div class="row wrap"><a class="btn" href="#/live">${ic('gps', 'sm')} Live map</a></div>
        </div>
        <div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="card stat"><div class="k"><span class="dot s-delivered">${ic('power', 'sm')}</span>On shift now</div><div class="v">${on.length}<small>of ${riders.length}</small></div></div>
          <div class="card stat"><div class="k"><span class="dot s-pending">${ic('bike', 'sm')}</span>Off shift</div><div class="v">${riders.length - on.length}</div></div>
          <div class="card stat"><div class="k"><span class="dot s-collected">${ic('clock', 'sm')}</span>Rider hours today</div><div class="v">${(totalToday / 3600e3).toFixed(1)}<small>h</small></div></div>
        </div>
        ${riders.length ? html`<div class="shift-grid">${riders.map(card)}</div>` : html`<div class="card">${empty('bike', 'No riders yet', 'Add rider accounts under Manage accounts.')}</div>`}
        <section class="card" style="margin-top:20px">
          <div class="card-head"><div><h2>Shift log</h2><p>Completed shifts in the last 7 days</p></div></div>
          ${logTable()}
        </section>`);
    } else {
      const rd = riders[0];
      el.innerHTML = String(html`
        <div class="page-head"><div><h1>My shift</h1><p>Switch on when you start work. While you're on shift, dispatch can see your live location.</p></div></div>
        <section class="card shift-hero ${rd.onShift ? 'is-on' : ''}">
          <div class="stack" style="align-items:center;text-align:center">
            ${toggle(rd, true)}
            <div><h2>${rd.onShift ? 'You are on shift' : 'You are off shift'}</h2>
              <p class="muted">${rd.onShift ? `Since ${fmtTime(rd.onShiftSince)} · ${dur(Date.now() - new Date(rd.onShiftSince))}` : 'Dispatch will not assign you new work until you switch on.'}</p></div>
            <div class="loc-status" id="loc"></div>
            <span class="muted" style="font-size:13px">Worked today: <b>${dur(todayMs(rd))}</b></span>
          </div>
        </section>
        <section class="card" style="margin-top:20px">
          <div class="card-head"><div><h2>My recent shifts</h2><p>Last 7 days</p></div></div>
          ${logTable()}
        </section>`);
      trackerOff();
      trackerOff = onTracker((t) => {
        const box = el.querySelector('#loc');
        if (box) box.innerHTML = String(html`<span class="loc ${t.status}">${ic(t.status === 'live' ? 'gps' : 'gpsOff', 'sm')}${t.message}</span>`);
      });
    }
    el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      const rd = riders.find((r) => r.id === +b.dataset.toggle);
      const res = await setShift(ctx, rd, !rd.onShift);
      if (!res) return;
      if (rd.id === me.id) me = { ...me, onShift: res.onShift, onShiftSince: res.onShiftSince };
      await load();
      if (ctx.isCurrent()) paint();
    })));
  };
  paint();
  ctx.poll(async () => { try { await load(); paint(); } catch {} }, 30000);
}
