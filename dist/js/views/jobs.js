import { api } from '../api.js';
import {
  html, ic, statusBadge, categoryBadge, urgentBadge, fmtDateTime, fmtTime, HANDLING, telHref, mapsHref, empty, greeting, firstName, busy,
  scheduleBadge, timeAgo, routeMini, tagBadges, toast,
} from '../ui.js';
import { recordCollection, recordHandover, pickupsOf, nextPickup, applyPending, ackChange } from './request-detail.js';
import { setShift, acceptJob } from './actions.js';
import { onTracker } from '../tracker.js';
import { pendingActions } from '../offline.js';
import { detailsBlock } from '../stops.js';

export const AVAIL = {
  available: { label: 'Available', icon: 'checkCircle', tone: 's-delivered', hint: 'Ready for new jobs' },
  assigned: { label: 'Assigned', icon: 'bike', tone: 's-assigned', hint: 'Heading to a pickup' },
  on_delivery: { label: 'On delivery', icon: 'package', tone: 's-collected', hint: 'Carrying items' },
  on_break: { label: 'On break', icon: 'coffee', tone: 's-pending', hint: 'Not taking jobs' },
  offline: { label: 'Offline', icon: 'power', tone: 'b-outline', hint: 'Clocked out' },
};

export async function render(el, ctx) {
  let tab = ctx.query.get('tab') || 'active';
  let requests, runs, open = [];
  let shift = { onShift: !!ctx.user.onShift, onShiftSince: ctx.user.onShiftSince };
  let availability = null;
  let offline = null;
  let dispatchPhone = null;
  const load = async () => {
    const [a, b, me, avail, sm] = await Promise.all([api.get('/api/requests?status=all'), api.get('/api/runs'), api.get('/api/auth/me'),
      api.get('/api/jobs/available').catch(() => ({ jobs: [] })), api.get('/api/shift/me').catch(() => null)]);
    const pending = await pendingActions();
    requests = a.requests.map((r) => applyPending(r, pending.filter((e) => e.requestId === r.id)));
    runs = b.runs; open = avail.jobs || [];
    offline = a.__offline ? a.__cachedAt : null;
    shift = { onShift: !!me.user.onShift, onShiftSince: me.user.onShiftSince };
    availability = sm?.availability || null;
    ctx.setUser({ onShift: shift.onShift, onShiftSince: shift.onShiftSince });
    if (dispatchPhone == null) dispatchPhone = (await api.get('/api/ops/settings').catch(() => null))?.settings?.dispatchPhone || '';
  };
  let trackerOff = () => {};
  ctx.onCleanup(() => trackerOff());
  await load();

  const job = (r) => {
    const next = r.dropoffs.find((d) => d.status !== 'delivered');
    return html`
    <section class="card job">
      <div class="job-head">
        <span class="avatar lg" style="background:${r.status === 'assigned' ? 'var(--st-assigned-bg)' : r.status === 'collected' ? 'var(--st-collected-bg)' : 'var(--st-delivered-bg)'};color:${r.status === 'assigned' ? 'var(--st-assigned)' : r.status === 'collected' ? 'var(--st-collected)' : 'var(--st-delivered)'}">${ic(r.status === 'assigned' ? 'pin' : r.status === 'collected' ? 'package' : 'checkCircle')}</span>
        <div class="grow">
          <div class="row wrap" style="gap:6px">${statusBadge(r.status)}${urgentBadge(r.priority)}${categoryBadge(r.category)}</div>
          <a href="#/requests/${r.id}" style="text-decoration:none"><h3 style="margin-top:6px">${r.title}</h3></a>
          <div class="req-sub"><span class="mono">${r.ref}</span>${r.scheduledAt ? html`· ${ic('calendar', 'sm')} Pickup ${fmtDateTime(r.scheduledAt)}` : ''}${r.runName ? html`· ${ic('route', 'sm')} ${r.runName}` : ''}</div>
        </div>
      </div>
      ${r.handling.length ? html`<div class="chips" style="padding:0 18px 12px">${r.handling.map((h) => html`<span class="badge">${ic(HANDLING[h].icon)}${HANDLING[h].label}</span>`)}</div>` : ''}
      ${(r.changesToConfirm || []).map((c) => html`<div class="alert err change-alert" style="margin:0 18px 12px">${ic('pin', 'sm')}<span class="grow"><b>${c.kind === 'pickup' ? 'Pickup' : `Drop-off ${c.seq}`} changed</b> by ${c.by}:<br><s class="muted">${c.from.address}</s> → <b>${c.to.address}</b></span>
        <button class="btn sm danger solid" data-ack="${r.id}:${c.id}">${ic('check', 'sm')} Confirm</button></div>`)}
      ${r.pendingSync ? html`<div class="alert info" style="margin:0 18px 12px">${ic('cloud', 'sm')}<span>Saved on this phone · waiting to sync</span></div>` : ''}
      <div class="stops">
        ${pickupsOf(r).map((p, i, all) => html`
        <div class="stop pickup ${p.collected ? 'collected' : ''}" style="padding:14px 18px">
          <span class="n">${p.collected ? ic('check') : all.length > 1 ? `P${p.seq}` : 'P'}</span>
          <div><div class="addr">${p.address}</div>${detailsBlock(p.details)}
            <div class="row wrap" style="gap:12px;margin-top:4px">${p.contactName ? html`<span class="contact">${ic('user', 'sm')}${p.contactName}</span>` : ''}
              ${p.contactPhone ? html`<a class="contact" href="${telHref(p.contactPhone)}" data-contact="${r.id}:pickup:${p.seq}">${ic('phone', 'sm')}Call</a>` : ''}
              <a class="contact" href="${mapsHref(p)}" target="_blank" rel="noopener noreferrer">${ic('external', 'sm')}Navigate</a></div></div>
          <span>${p.pendingSync ? html`<span class="badge s-pending">${ic('cloud')}To sync</span>` : p.collected ? html`<span class="badge s-delivered">${ic('check')}${fmtTime(p.collectedAt)}</span>`
            : r.status === 'assigned' && all.length > 1 ? html`<button class="btn sm ${p === nextPickup(r) ? 'primary' : ''}" data-cp="${r.id}:${p.seq}">${ic('package', 'sm')} Collect</button>` : ''}</span>
        </div>`)}
        ${r.dropoffs.map((d) => html`
        <div class="stop ${d.status}" style="padding:14px 18px">
          <span class="n">${d.status === 'delivered' ? ic('check') : d.seq}</span>
          <div><div class="addr">${d.address}</div>${detailsBlock(d.details)}
            ${d.instructions ? html`<div class="muted" style="font-size:13px">“${d.instructions}”</div>` : ''}
            <div class="row wrap" style="gap:12px;margin-top:4px">${d.contactName ? html`<span class="contact">${ic('user', 'sm')}${d.contactName}</span>` : ''}
              ${d.contactPhone ? html`<a class="contact" href="${telHref(d.contactPhone)}" data-contact="${r.id}:dropoff:${d.seq}">${ic('phone', 'sm')}Call</a>` : ''}
              <a class="contact" href="${mapsHref(d)}" target="_blank" rel="noopener noreferrer">${ic('external', 'sm')}Navigate</a></div>
            ${d.status === 'failed' ? html`<div class="error-text">Not delivered: ${d.note}</div>` : ''}</div>
          <span>${d.pendingSync ? html`<span class="badge s-pending">${ic('cloud')}To sync</span>` : r.status === 'collected' && d.status !== 'delivered'
            ? html`<button class="btn sm ${d === next ? 'primary' : ''}" data-h="${r.id}:${d.id}">${ic('hand', 'sm')} ${d.status === 'failed' ? 'Retry' : 'Hand over'}</button>`
            : d.status === 'delivered' ? html`<span class="badge s-delivered">${fmtTime(d.handledAt)}</span>` : ''}</span>
        </div>`)}
      </div>
      ${r.status === 'assigned' ? html`<div class="job-actions" style="padding-top:14px;border-top:1px solid var(--line)">
        <a class="btn lg" href="${mapsHref(nextPickup(r) || r.pickup)}" target="_blank" rel="noopener noreferrer">${ic('pin', 'sm')} Go to pickup${pickupsOf(r).length > 1 ? ` ${nextPickup(r)?.seq}` : ''}</a>
        <button class="btn primary lg" data-c="${r.id}">${ic('package', 'sm')} ${pickupsOf(r).length > 1 ? `Collect pickup ${nextPickup(r)?.seq}` : 'Record collection'}</button></div>` : ''}
    </section>`;
  };

  /** A waiting job the rider may take. Only jobs matching their designation are offered by the server. */
  const openJob = (r) => html`
    <section class="card job open-job ${r.priority === 'urgent' ? 'urgent' : ''} cat-${r.category}">
      <div class="job-head">
        <span class="avatar lg" style="background:var(--st-pending-bg);color:var(--st-pending)">${ic(r.category === 'triangle' ? 'triangle' : r.category === 'finance' ? 'coins' : 'box')}</span>
        <div class="grow">
          <div class="row wrap" style="gap:6px">${urgentBadge(r.priority)}${categoryBadge(r.category)}${scheduleBadge(r)}</div>
          <a href="#/requests/${r.id}" style="text-decoration:none"><h3 style="margin-top:6px">${r.title}</h3></a>
          <div class="req-sub"><span class="mono">${r.ref}</span>· ${r.dropoffs.length} drop-off${r.dropoffs.length > 1 ? 's' : ''} · ${r.scheduledAt ? `pickup ${fmtDateTime(r.scheduledAt)}` : `requested ${timeAgo(r.createdAt)}`}</div>
        </div>
      </div>
      <div style="padding:0 18px 14px">${routeMini(r, 2)}</div>
      ${r.handling.length ? html`<div class="chips" style="padding:0 18px 12px">${r.handling.map((h) => html`<span class="badge">${ic(HANDLING[h].icon)}${HANDLING[h].label}</span>`)}</div>` : ''}
      <div class="job-actions" style="padding-top:14px;border-top:1px solid var(--line)">
        <a class="btn lg" href="#/requests/${r.id}">${ic('eye', 'sm')} Details</a>
        <button class="btn primary lg" data-accept="${r.id}" data-busy=" Accepting…" ${shift.onShift ? '' : 'disabled title="Switch on shift to accept jobs"'}>${ic('hand2', 'sm')} Accept job</button>
      </div>
    </section>`;

  const paint = () => {
    const active = requests.filter((r) => ['assigned', 'collected'].includes(r.status));
    const done = requests.filter((r) => r.status === 'delivered');
    const activeRun = runs.find((r) => r.status === 'active');
    const todayDone = done.filter((r) => new Date(r.deliveredAt).toDateString() === new Date().toDateString()).length;
    const list = tab === 'active' ? active : tab === 'open' ? open : done.slice(0, 30);
    const tags = ctx.user.tags || [];
    el.innerHTML = String(html`
      <div class="hello">
        <h1>${greeting()}, ${firstName(ctx.user.name)} 👋</h1>
        <p>${shift.onShift ? `Clocked in since ${fmtTime(shift.onShiftSince)}.` : "You're clocked out. Clock in to start receiving jobs and sharing your location."}${activeRun ? ` Active run: ${activeRun.name}.` : ''}</p>
        ${offline ? html`<div class="alert warn" style="margin:10px 0">${ic('wifiOff', 'sm')}<span><b>Offline.</b> Showing jobs saved ${timeAgo(new Date(offline).toISOString())}. Record collections and drop-offs as normal; they sync when you're back online.</span></div>` : ''}
        <div class="avail-bar">
          ${(() => { const a = AVAIL[availability?.availability || (shift.onShift ? 'available' : 'offline')]; return html`<span class="badge dot ${a.tone} avail-now" title="${a.hint}">${a.label}</span>`; })()}
          ${shift.onShift && ['available', 'on_break'].includes(availability?.availability || 'available') ? html`<div class="seg avail-seg" role="group" aria-label="Your status">
            <button data-avail="available" class="${availability?.availability !== 'on_break' ? 'on' : ''}" ${offline ? 'disabled' : ''}>${ic('checkCircle', 'sm')} Available</button>
            <button data-avail="on_break" class="${availability?.availability === 'on_break' ? 'on' : ''}" ${offline ? 'disabled' : ''}>${ic('coffee', 'sm')} On break</button>
          </div>` : shift.onShift ? html`<span class="muted" style="font-size:12.5px">Your status follows your jobs. Finish them to go on break.</span>` : ''}
          ${availability?.shift?.overLimit ? html`<a class="badge s-failed" href="#/shifts">${ic('clock')}Past your shift — request overtime</a>` : ''}
        </div>
        <div class="row wrap">
          <button class="shift-toggle ${shift.onShift ? 'on' : ''}" id="shift" aria-pressed="${shift.onShift ? 'true' : 'false'}" ${offline ? 'disabled title="Clocking in/out needs a connection"' : ''}><span class="knob">${ic('power', 'sm')}</span><span class="txt">${shift.onShift ? 'Clocked in' : 'Clocked out'}</span></button>
          <div class="pill"><b>${active.filter((r) => r.status === 'assigned').length}</b><small>To collect</small></div>
          <div class="pill"><b>${active.filter((r) => r.status === 'collected').length}</b><small>In your bag</small></div>
          <div class="pill"><b>${todayDone}</b><small>Delivered today</small></div>
          <button class="pill pill-open" data-t="open"><b>${open.length}</b><small>Open to accept</small></button>
        </div>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" data-t="active" class="${tab === 'active' ? 'on' : ''}">My active jobs<span class="n">${active.length}</span></button>
        <button role="tab" data-t="open" class="${tab === 'open' ? 'on' : ''}">Available to accept<span class="n ${open.length ? 'hot' : ''}">${open.length}</span></button>
        <button role="tab" data-t="done" class="${tab === 'done' ? 'on' : ''}">Completed<span class="n">${done.length}</span></button>
      </div>
      ${tab === 'open' ? html`<div class="alert ${shift.onShift ? 'info' : 'warn'}" style="margin-bottom:14px">${ic(shift.onShift ? 'hand2' : 'power', 'sm')}<span>${shift.onShift
        ? html`Jobs shown match your designation${tags.length ? html` (${tagBadges(tags)})` : ' (general work)'}. Accept one to make it yours. Dispatch can still assign you other work.`
        : 'Switch on shift to accept jobs.'}</span></div>` : ''}
      ${list.length ? html`<div class="grid g-2">${list.map(tab === 'open' ? openJob : job)}</div>`
        : html`<div class="card">${tab === 'open' ? empty('hand2', 'No open jobs for you', 'Waiting jobs that match your designation appear here. Dispatch may also assign you work directly.')
          : empty(tab === 'active' ? 'bike' : 'checkCircle', tab === 'active' ? 'No jobs right now' : 'Nothing completed yet', tab === 'active' ? 'Accept an open job, or wait for dispatch to assign you one.' : 'Delivered jobs will be listed here.')}</div>`}
      <p class="faint" id="gps-note" style="font-size:12px;margin-top:16px;display:flex;gap:6px;align-items:center"></p>`);
    trackerOff();
    trackerOff = onTracker((t) => {
      const note = el.querySelector('#gps-note');
      if (note) note.innerHTML = String(html`${ic(t.status === 'live' ? 'gps' : 'gpsOff', 'sm')} ${t.message}${t.active && !t.background ? ' Keep this app open while riding — browsers pause GPS in the background. The Android app keeps tracking with the screen off.' : ''}`);
    });
    el.querySelector('#shift').addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const res = await setShift(ctx, { id: ctx.user.id, name: ctx.user.name }, !shift.onShift);
      if (res) { shift = { onShift: res.onShift, onShiftSince: res.onShiftSince }; paint(); }
    }));
    el.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; paint(); }));
    el.querySelectorAll('[data-avail]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      if (availability?.availability === b.dataset.avail || (b.dataset.avail === 'available' && availability?.availability !== 'on_break')) return;
      try {
        const res = await api.post(`/api/riders/${ctx.user.id}/availability`, { status: b.dataset.avail });
        availability = { ...availability, ...res.rider };
        toast(b.dataset.avail === 'on_break' ? 'You are on break. Dispatch can see it.' : 'You are available for jobs.');
        paint();
      } catch (err) { toast(err.message, 'warn'); }
    })));
    el.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      const [rid, cid] = b.dataset.ack.split(':').map(Number);
      const r = requests.find((x) => x.id === rid);
      const c = r.changesToConfirm.find((x) => x.id === cid);
      await ackChange(r, c);
      await load(); paint();
    })));
    el.querySelectorAll('[data-contact]').forEach((a) => a.addEventListener('click', () => {
      const [rid, ...target] = a.dataset.contact.split(':');
      api.post(`/api/requests/${rid}/contact`, { target: target.join(':'), channel: 'call' }).catch(() => {});
    }));
    el.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      const r = open.find((x) => x.id === +b.dataset.accept);
      const res = await acceptJob(r);
      await load();
      if (res) tab = 'active';
      if (ctx.isCurrent()) paint();
    })));
    const afterProof = async (res, r) => {
      if (res?.needsAck) { const c = (r.changesToConfirm || []).find((x) => x.id === res.needsAck); if (c) await ackChange(r, c); }
      if (res) { await load().catch(() => {}); paint(); }
    };
    el.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', async () => {
      const r = requests.find((x) => x.id === +b.dataset.c);
      await afterProof(await recordCollection(r), r);
    }));
    el.querySelectorAll('[data-cp]').forEach((b) => b.addEventListener('click', async () => {
      const [rid, seq] = b.dataset.cp.split(':').map(Number);
      const r = requests.find((x) => x.id === rid);
      await afterProof(await recordCollection(r, pickupsOf(r).find((p) => p.seq === seq)), r);
    }));
    el.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', async () => {
      const [rid, did] = b.dataset.h.split(':').map(Number);
      const r = requests.find((x) => x.id === rid);
      await afterProof(await recordHandover(r, r.dropoffs.find((d) => d.id === did)), r);
    }));
  };
  paint();
  const refresh = async () => { if (!document.querySelector('.modal-back')) { try { await load(); paint(); } catch {} } };
  ctx.onLive(refresh, ['change', 'request', 'riders', 'shifts']);
  const onSynced = () => refresh();
  window.addEventListener('rr-synced', onSynced);
  ctx.onCleanup(() => window.removeEventListener('rr-synced', onSynced));
  ctx.poll(refresh, 30000);
}
