import { api } from '../api.js';
import {
  html, ic, statusBadge, categoryBadge, urgentBadge, fmtDateTime, fmtTime, HANDLING, telHref, mapsHref, empty, greeting, firstName, busy,
  scheduleBadge, timeAgo, routeMini, tagBadges,
} from '../ui.js';
import { recordCollection, recordHandover } from './request-detail.js';
import { setShift, acceptJob } from './actions.js';
import { onTracker } from '../tracker.js';

export async function render(el, ctx) {
  let tab = ctx.query.get('tab') || 'active';
  let requests, runs, open = [];
  let shift = { onShift: !!ctx.user.onShift, onShiftSince: ctx.user.onShiftSince };
  const load = async () => {
    const [a, b, me, avail] = await Promise.all([api.get('/api/requests?status=all'), api.get('/api/runs'), api.get('/api/auth/me'), api.get('/api/jobs/available')]);
    requests = a.requests; runs = b.runs; open = avail.jobs;
    shift = { onShift: !!me.user.onShift, onShiftSince: me.user.onShiftSince };
    ctx.setUser({ onShift: shift.onShift, onShiftSince: shift.onShiftSince });
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
      <div class="stops">
        <div class="stop pickup" style="padding:14px 18px">
          <span class="n">P</span>
          <div><div class="addr">${r.pickup.address}</div>
            <div class="row wrap" style="gap:12px;margin-top:4px">${r.pickup.contactName ? html`<span class="contact">${ic('user', 'sm')}${r.pickup.contactName}</span>` : ''}
              ${r.pickup.contactPhone ? html`<a class="contact" href="${telHref(r.pickup.contactPhone)}">${ic('phone', 'sm')}Call</a>` : ''}
              <a class="contact" href="${mapsHref(r.pickup)}" target="_blank" rel="noopener noreferrer">${ic('external', 'sm')}Navigate</a></div></div>
          <span>${r.collectedAt ? html`<span class="badge s-delivered">${ic('check')}${fmtTime(r.collectedAt)}</span>` : ''}</span>
        </div>
        ${r.dropoffs.map((d) => html`
        <div class="stop ${d.status}" style="padding:14px 18px">
          <span class="n">${d.status === 'delivered' ? ic('check') : d.seq}</span>
          <div><div class="addr">${d.address}</div>
            ${d.instructions ? html`<div class="muted" style="font-size:13px">“${d.instructions}”</div>` : ''}
            <div class="row wrap" style="gap:12px;margin-top:4px">${d.contactName ? html`<span class="contact">${ic('user', 'sm')}${d.contactName}</span>` : ''}
              ${d.contactPhone ? html`<a class="contact" href="${telHref(d.contactPhone)}">${ic('phone', 'sm')}Call</a>` : ''}
              <a class="contact" href="${mapsHref(d)}" target="_blank" rel="noopener noreferrer">${ic('external', 'sm')}Navigate</a></div>
            ${d.status === 'failed' ? html`<div class="error-text">Not delivered: ${d.note}</div>` : ''}</div>
          <span>${r.status === 'collected' && d.status !== 'delivered'
            ? html`<button class="btn sm ${d === next ? 'primary' : ''}" data-h="${r.id}:${d.id}">${ic('hand', 'sm')} ${d.status === 'failed' ? 'Retry' : 'Hand over'}</button>`
            : d.status === 'delivered' ? html`<span class="badge s-delivered">${fmtTime(d.handledAt)}</span>` : ''}</span>
        </div>`)}
      </div>
      ${r.status === 'assigned' ? html`<div class="job-actions" style="padding-top:14px;border-top:1px solid var(--line)">
        <a class="btn lg" href="${mapsHref(r.pickup)}" target="_blank" rel="noopener noreferrer">${ic('pin', 'sm')} Go to pickup</a>
        <button class="btn primary lg" data-c="${r.id}">${ic('package', 'sm')} Record collection</button></div>` : ''}
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
        <p>${shift.onShift ? `You're on shift since ${fmtTime(shift.onShiftSince)}.` : "You're off shift. Switch on to start receiving jobs and sharing your location."}${activeRun ? ` Active run: ${activeRun.name}.` : ''}</p>
        <div class="row wrap">
          <button class="shift-toggle ${shift.onShift ? 'on' : ''}" id="shift" aria-pressed="${shift.onShift ? 'true' : 'false'}"><span class="knob">${ic('power', 'sm')}</span><span class="txt">${shift.onShift ? 'On shift' : 'Off shift'}</span></button>
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
      if (note) note.innerHTML = String(html`${ic(t.status === 'live' ? 'gps' : 'gpsOff', 'sm')} ${t.message}${t.active ? ' Keep this app open while riding — phones pause GPS when the app is in the background.' : ''}`);
    });
    el.querySelector('#shift').addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const res = await setShift(ctx, { id: ctx.user.id, name: ctx.user.name }, !shift.onShift);
      if (res) { shift = { onShift: res.onShift, onShiftSince: res.onShiftSince }; paint(); }
    }));
    el.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; paint(); }));
    el.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      const r = open.find((x) => x.id === +b.dataset.accept);
      const res = await acceptJob(r);
      await load();
      if (res) tab = 'active';
      if (ctx.isCurrent()) paint();
    })));
    el.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', async () => {
      const r = requests.find((x) => x.id === +b.dataset.c);
      if (await recordCollection(r)) { await load(); paint(); }
    }));
    el.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', async () => {
      const [rid, did] = b.dataset.h.split(':').map(Number);
      const r = requests.find((x) => x.id === rid);
      if (await recordHandover(r, r.dropoffs.find((d) => d.id === did))) { await load(); paint(); }
    }));
  };
  paint();
  ctx.poll(async () => { if (!document.querySelector('.modal-back')) { try { await load(); paint(); } catch {} } }, 20000);
}
