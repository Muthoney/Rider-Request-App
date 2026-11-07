import { api } from '../api.js';
import { html, ic, statusBadge, categoryBadge, urgentBadge, fmtDateTime, fmtTime, HANDLING, telHref, mapsHref, empty, greeting, firstName } from '../ui.js';
import { recordCollection, recordHandover } from './request-detail.js';

export async function render(el, ctx) {
  let tab = 'active';
  let requests, runs, shifts;
  const load = async () => {
    const now = new Date();
    const [a, b, c] = await Promise.all([
      api.get('/api/requests?status=all'), api.get('/api/runs'),
      api.get(`/api/shifts?from=${encodeURIComponent(new Date(now - 864e5).toISOString())}&to=${encodeURIComponent(new Date(+now + 7 * 864e5).toISOString())}`),
    ]);
    requests = a.requests; runs = b.runs; shifts = c.shifts;
  };
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
          <div class="req-sub"><span class="mono">${r.ref}</span>${r.scheduledAt ? html`· ${ic('calendar', 'sm')} ${fmtDateTime(r.scheduledAt)}` : ''}${r.runName ? html`· ${ic('route', 'sm')} ${r.runName}` : ''}</div>
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

  const paint = () => {
    const active = requests.filter((r) => ['assigned', 'collected'].includes(r.status));
    const done = requests.filter((r) => r.status === 'delivered');
    const now = Date.now();
    const cur = shifts.find((s) => new Date(s.startsAt) <= now && new Date(s.endsAt) > now);
    const nextShift = shifts.find((s) => new Date(s.startsAt) > now);
    const activeRun = runs.find((r) => r.status === 'active');
    const todayDone = done.filter((r) => new Date(r.deliveredAt).toDateString() === new Date().toDateString()).length;
    const list = tab === 'active' ? active : done.slice(0, 30);
    el.innerHTML = String(html`
      <div class="hello">
        <h1>${greeting()}, ${firstName(ctx.user.name)} 👋</h1>
        <p>${cur ? `You're on shift until ${fmtTime(cur.endsAt)}.` : nextShift ? `Next shift: ${fmtDateTime(nextShift.startsAt)}.` : 'No upcoming shifts scheduled.'}${activeRun ? ` Active run: ${activeRun.name}.` : ''}</p>
        <div class="row wrap">
          <div class="pill"><b>${active.filter((r) => r.status === 'assigned').length}</b><small>To collect</small></div>
          <div class="pill"><b>${active.filter((r) => r.status === 'collected').length}</b><small>In your bag</small></div>
          <div class="pill"><b>${todayDone}</b><small>Delivered today</small></div>
        </div>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" data-t="active" class="${tab === 'active' ? 'on' : ''}">Active jobs<span class="n">${active.length}</span></button>
        <button role="tab" data-t="done" class="${tab === 'done' ? 'on' : ''}">Completed<span class="n">${done.length}</span></button>
      </div>
      ${list.length ? html`<div class="grid g-2">${list.map(job)}</div>`
        : html`<div class="card">${empty(tab === 'active' ? 'bike' : 'checkCircle', tab === 'active' ? 'No jobs right now' : 'Nothing completed yet', tab === 'active' ? 'When dispatch assigns you a delivery it will appear here.' : 'Delivered jobs will be listed here.')}</div>`}
      <p class="faint" style="font-size:12px;margin-top:16px;display:flex;gap:6px;align-items:center">${ic('gpsOff', 'sm')} Background location tracking isn't connected. Collections and handovers are recorded without GPS.</p>`);
    el.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; paint(); }));
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
