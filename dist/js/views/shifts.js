import { api } from '../api.js';
import { html, ic, avatar, tagBadges, fmtTime, fmtDateTime, empty, busy, canWrite, readOnlyChip, vehicleBadge, exportBtn, toast, openModal } from '../ui.js';
import { availBadge } from './actions.js';
import { downloadXlsx, stamp } from '../xlsx.js';
import { setShift } from './actions.js';
import { onTracker } from '../tracker.js';

const STAFF = ['admin', 'manager', 'dispatcher'];
const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60e3)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };

export async function render(el, ctx) {
  const staff = STAFF.includes(ctx.user.role);
  const writer = canWrite(ctx.user);
  let riders = [];
  let log = [];
  let report = { shifts: [] };
  let pendingOt = [];
  let mine = null;
  let me = { ...ctx.user };
  let trackerOff = () => {};
  ctx.onCleanup(() => trackerOff());

  const load = async () => {
    const from = new Date(Date.now() - 7 * 864e5).toISOString();
    const to = new Date(Date.now() + 864e5).toISOString();
    const [shifts, stats, rep, ot, sm] = await Promise.all([
      api.get(`/api/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      staff ? api.get('/api/stats') : Promise.resolve(null),
      api.get(`/api/shifts/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).catch(() => ({ shifts: [] })),
      api.get(`/api/overtime${staff ? '?status=pending' : ''}`).catch(() => ({ overtime: [] })),
      staff ? Promise.resolve(null) : api.get('/api/shift/me').catch(() => null),
    ]);
    log = shifts.shifts.slice().sort((a, b) => b.startsAt.localeCompare(a.startsAt));
    report = rep;
    pendingOt = ot.overtime;
    mine = sm;
    if (sm) me = { ...me, onShift: sm.shift.onShift, onShiftSince: sm.shift.since };
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

  const toggle = (rd, big = false) => (staff && !writer ? html`<span class="badge ${rd.onShift ? 's-delivered' : 'b-outline'} dot">${rd.onShift ? 'On shift' : 'Off shift'}</span>` : html`
    <button class="shift-toggle ${rd.onShift ? 'on' : ''} ${big ? 'big' : ''}" data-toggle="${rd.id}" aria-pressed="${rd.onShift ? 'true' : 'false'}"
      aria-label="${rd.name}: ${rd.onShift ? 'on shift, switch off' : 'off shift, switch on'}">
      <span class="knob">${ic('power', 'sm')}</span><span class="txt">${rd.onShift ? 'Clocked in' : 'Clocked out'}</span>
    </button>`);

  const card = (rd) => html`
    <section class="card rider-shift ${rd.onShift ? 'is-on' : ''}">
      <div class="row" style="gap:12px">
        ${avatar(rd.name)}
        <div class="grow"><b>${rd.name}</b> ${vehicleBadge(rd.vehicle)}
          <div class="req-sub"><span class="${rd.onShift ? 'onshift' : 'offshift'}"></span>${rd.onShift ? `Since ${fmtTime(rd.onShiftSince)} · ${dur(Date.now() - new Date(rd.onShiftSince))}` : 'Not on shift'}</div>
          <div class="row wrap" style="gap:4px;margin-top:4px">${tagBadges(rd.tags)}${rd.onShift ? availBadge(rd) : ''}
            ${rd.shift?.overLimit ? html`<span class="badge s-failed">${ic('clock')}Past shift by ${dur((rd.shift.overtimeMinutes - rd.shift.approvedMinutes) * 60e3)}</span>` : rd.shift?.overtimeMinutes ? html`<span class="badge s-pending">${ic('clock')}Approved overtime</span>` : ''}</div>
        </div>
      </div>
      <div class="row between" style="margin-top:14px">
        <span class="muted" style="font-size:12.5px">Today: <b>${dur(todayMs(rd))}</b>${rd.openJobs != null ? ` · ${rd.openJobs} open job${rd.openJobs === 1 ? '' : 's'}` : ''}</span>
        <span class="row" style="gap:6px">${writer && rd.onShift ? html`<button class="btn sm ghost" data-offer="${rd.id}" title="Authorise overtime for ${rd.name}">${ic('clock', 'sm')} Overtime</button>` : ''}${toggle(rd)}</span>
      </div>
    </section>`;

  const done = () => report.shifts.filter((x) => !x.inProgress);
  const logTable = () => done().length ? html`<div class="table-wrap"><table class="table"><thead><tr>${staff ? html`<th>Rider</th>` : ''}<th>Started</th><th>Ended</th><th>Length</th><th>Standard</th><th>Overtime</th></tr></thead><tbody>
    ${done().slice(0, 60).map((s) => html`<tr>${staff ? html`<td>${s.rider.name}</td>` : ''}<td class="nowrap">${fmtDateTime(s.startsAt)}</td><td class="nowrap">${fmtDateTime(s.endsAt)}</td>
      <td class="nowrap">${dur(s.minutes * 60e3)}</td><td class="nowrap muted">${dur(s.plannedMinutes * 60e3)}</td>
      <td class="nowrap">${s.overtimeMinutes ? html`${dur(s.overtimeMinutes * 60e3)}${s.unapprovedOvertimeMinutes ? html` <span class="badge s-failed">${dur(s.unapprovedOvertimeMinutes * 60e3)} not approved</span>` : html` <span class="badge s-delivered">approved</span>`}` : html`<span class="muted">—</span>`}</td></tr>`)}
    </tbody></table></div>` : html`<div class="card-body muted">No completed shifts in the last 7 days.</div>`;

  const otStatus = { pending: ['s-pending', 'Waiting'], approved: ['s-delivered', 'Approved'], rejected: ['s-failed', 'Rejected'] };
  const approvals = () => (pendingOt.length ? html`<section class="card" style="margin-top:20px">
    <div class="card-head"><div><h2>${ic('clock', 'sm')} Overtime waiting for a decision</h2><p>Riders asking to work past their standard shift</p></div><span class="badge s-pending">${pendingOt.length}</span></div>
    <div class="list">${pendingOt.map((o) => html`<div class="list-item">${avatar(o.rider.name, 'sm')}
      <div class="grow"><b>${o.rider.name}</b> · ${o.minutes} min${o.requestedByRider ? '' : html` <span class="badge b-outline">offered by ${o.requestedBy}</span>`}<div class="req-sub">${o.reason || 'No reason given'} · ${fmtDateTime(o.createdAt)}</div></div>
      ${o.requestedByRider && writer ? html`<button class="btn sm" data-decide="${o.id}:0">Reject</button><button class="btn sm primary" data-decide="${o.id}:1">Approve</button>` : html`<span class="badge s-pending">Rider to accept</span>`}
    </div>`)}</div></section>` : '');

  const myShiftCard = () => {
    if (!mine?.shift?.onShift) return '';
    const sh = mine.shift;
    const pct = Math.min(100, Math.round((sh.workedMinutes / Math.max(1, sh.plannedMinutes + sh.approvedMinutes)) * 100));
    const offers = sh.requests.filter((o) => o.status === 'pending' && !o.requestedByRider);
    const waiting = sh.requests.find((o) => o.status === 'pending' && o.requestedByRider);
    return html`<section class="card" style="margin-top:20px">
      <div class="card-head"><div><h2>${ic('clock', 'sm')} This shift</h2><p>Standard shift ${dur(sh.plannedMinutes * 60e3)}${sh.approvedMinutes ? ` + ${dur(sh.approvedMinutes * 60e3)} approved overtime` : ''}</p></div>
        <span class="badge ${sh.state === 'over_unapproved' ? 's-failed' : sh.state === 'overtime_approved' ? 's-pending' : 's-delivered'}">${sh.state === 'over_unapproved' ? 'Past your shift' : sh.state === 'overtime_approved' ? 'On overtime' : 'Within shift'}</span></div>
      <div class="card-body stack">
        <div class="shift-bar ${sh.state}"><i style="width:${pct}%"></i></div>
        <div class="row between"><span>Worked <b>${dur(sh.workedMinutes * 60e3)}</b></span><span class="muted">${sh.remainingMinutes >= 0 ? `${dur(sh.remainingMinutes * 60e3)} left` : `${dur(-sh.remainingMinutes * 60e3)} over`}</span></div>
        ${offers.map((o) => html`<div class="alert info">${ic('clock', 'sm')}<span class="grow"><b>${o.requestedBy}</b> authorised ${o.minutes} min overtime${o.reason ? `: ${o.reason}` : ''}.</span>
          <button class="btn sm" data-decide="${o.id}:0">Decline</button><button class="btn sm primary" data-decide="${o.id}:1">Accept</button></div>`)}
        ${waiting ? html`<div class="alert warn">${ic('clock', 'sm')}<span>You asked for ${waiting.minutes} min overtime. Waiting for dispatch.</span></div>`
          : html`<form class="row wrap" id="ot-form" style="gap:8px;align-items:flex-end">
            <div class="field" style="min-width:140px"><label for="ot-m">Request overtime</label><select class="input" id="ot-m" name="minutes">${[30, 60, 90, 120, 180, 240].filter((m) => m <= sh.overtimeMaxMinutes).map((m) => html`<option value="${m}">${dur(m * 60e3)}</option>`)}</select></div>
            <div class="field grow"><label for="ot-r">Reason</label><input class="input" id="ot-r" name="reason" maxlength="300" placeholder="e.g. Finishing the Finance run"></div>
            <button class="btn" type="submit">${ic('send', 'sm')} Ask dispatch</button></form>`}
        ${sh.requests.filter((o) => o.status !== 'pending').map((o) => html`<p class="muted" style="font-size:13px"><span class="badge ${otStatus[o.status][0]}">${otStatus[o.status][1]}</span> ${o.minutes} min${o.decidedBy ? ` · ${o.decidedBy}` : ''}${o.note ? ` · “${o.note}”` : ''}</p>`)}
      </div></section>`;
  };

  const paint = () => {
    const on = riders.filter((r) => r.onShift);
    const totalToday = riders.reduce((s, r) => s + todayMs(r), 0);
    if (staff) {
      el.innerHTML = String(html`
        <div class="page-head">
          <div><h1>Shifts</h1><p>${writer ? 'Switch riders on and off shift. ' : ''}Riders on shift show as available on the dispatch board and share their live GPS position.</p></div>
          <div class="row wrap">${writer ? '' : readOnlyChip()}<a class="btn" href="#/live">${ic('gps', 'sm')} Live map</a></div>
        </div>
        <div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="card stat"><div class="k"><span class="dot s-delivered">${ic('power', 'sm')}</span>On shift now</div><div class="v">${on.length}<small>of ${riders.length}</small></div></div>
          <div class="card stat"><div class="k"><span class="dot s-pending">${ic('bike', 'sm')}</span>Off shift</div><div class="v">${riders.length - on.length}</div></div>
          <div class="card stat"><div class="k"><span class="dot s-collected">${ic('clock', 'sm')}</span>Rider hours today</div><div class="v">${(totalToday / 3600e3).toFixed(1)}<small>h</small></div></div>
        </div>
        ${riders.length ? html`<div class="shift-grid">${riders.map(card)}</div>` : html`<div class="card">${empty('bike', 'No riders yet', 'Add rider accounts under Manage accounts.')}</div>`}
        ${approvals()}
        <section class="card" style="margin-top:20px">
          <div class="card-head"><div><h2>Shift log</h2><p>Completed shifts in the last 7 days</p></div>${exportBtn()}</div>
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
        ${myShiftCard()}
        <section class="card" style="margin-top:20px">
          <div class="card-head"><div><h2>My recent shifts</h2><p>Last 7 days</p></div>${exportBtn()}</div>
          ${logTable()}
        </section>`);
      trackerOff();
      trackerOff = onTracker((t) => {
        const box = el.querySelector('#loc');
        if (box) box.innerHTML = String(html`<span class="loc ${t.status}">${ic(t.status === 'live' ? 'gps' : 'gpsOff', 'sm')}${t.message}</span>`);
      });
    }
    el.querySelector('[data-export]')?.addEventListener('click', () => {
      if (!done().length) { toast('No shifts to export yet.', 'warn'); return; }
      downloadXlsx(stamp('shift-log'), {
        sheet: 'Shift log',
        columns: [
          { header: 'Rider', width: 22, value: (x) => x.rider.name },
          { header: 'Started', width: 18, value: (x) => new Date(x.startsAt) },
          { header: 'Ended', width: 18, value: (x) => new Date(x.endsAt) },
          { header: 'Hours', width: 9, value: (x) => Math.round((x.minutes / 60) * 100) / 100 },
          { header: 'Standard (h)', width: 12, value: (x) => Math.round((x.plannedMinutes / 60) * 100) / 100 },
          { header: 'Overtime (h)', width: 12, value: (x) => Math.round((x.overtime / 60) * 100) / 100 },
          { header: 'Approved overtime (h)', width: 18, value: (x) => Math.round((x.approved / 60) * 100) / 100 },
        ],
        rows: done().map((x) => ({ ...x, overtime: x.overtimeMinutes, approved: x.approvedOvertimeMinutes })),
      });
      toast(`Exported ${done().length} shift${done().length === 1 ? '' : 's'} to Excel`);
    });
    el.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      const [oid, yes] = b.dataset.decide.split(':');
      try { await api.post(`/api/overtime/${oid}/decide`, { approve: yes === '1' }); toast(yes === '1' ? 'Overtime approved.' : 'Overtime declined.'); await load(); paint(); }
      catch (err) { toast(err.message, 'err'); }
    })));
    el.querySelector('#ot-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      busy(f.querySelector('button'), async () => {
        try { await api.post('/api/overtime', { minutes: Number(f.minutes.value), reason: f.reason.value.trim() || null }); toast('Overtime request sent to dispatch.'); await load(); paint(); }
        catch (err) { toast(err.message, 'err'); }
      });
    });
    el.querySelectorAll('[data-offer]').forEach((b) => b.addEventListener('click', async () => {
      const rd = riders.find((r) => r.id === +b.dataset.offer);
      const data = await openModal({
        title: `Authorise overtime for ${rd.name}`, subtitle: 'The rider is asked to accept. Approved overtime is shown on shift reports.', iconName: 'clock',
        body: html`<div class="field"><label for="of-m">Overtime</label><select class="input" id="of-m" name="minutes">${[30, 60, 90, 120, 180, 240].map((m) => html`<option value="${m}">${dur(m * 60e3)}</option>`)}</select></div>
          <div class="field"><label for="of-r">Reason</label><input class="input" id="of-r" name="reason" maxlength="300" placeholder="e.g. Late Finance pickup at 6pm"></div>`,
        actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('send', 'sm')} Offer</button>`,
        onMount: ({ form, close }) => form.addEventListener('submit', (ev) => { ev.preventDefault(); close({ minutes: Number(form.minutes.value), reason: form.reason.value.trim() || null }); }),
      });
      if (!data) return;
      try { await api.post(`/api/riders/${rd.id}/overtime`, data); toast(`Overtime offered to ${rd.name}.`); await load(); paint(); } catch (err) { toast(err.message, 'err'); }
    }));
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
  ctx.onLive(async () => { try { await load(); paint(); } catch {} }, ['shifts', 'riders']);
  ctx.poll(async () => { if (!document.querySelector('.modal-back') && !el.querySelector('#ot-form:focus-within')) { try { await load(); paint(); } catch {} } }, 30000);
}
