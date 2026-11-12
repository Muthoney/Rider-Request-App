// Dispatch board: three distinct zones — waiting requests, available riders (on shift) and
// unavailable riders (off shift). On phones each zone is a tab. Managers see it read-only.
import { api } from '../api.js';
import {
  html, ic, statusBadge, categoryBadge, urgentBadge, avatar, timeAgo, fmtDateTime, fmtTime, tagBadges, HANDLING, toast,
  canWrite, readOnlyChip, isScheduledLater, scheduleBadge, vehicleBadge, confirmDialog,
} from '../ui.js';
import { assign, pickRiderDialog, availBadge, ratingBadge, lastSeen } from './actions.js';
import { openModal } from '../ui.js';

const TABS = [
  ['waiting', 'Waiting', 'clock'],
  ['available', 'Available', 'power'],
  ['unavailable', 'Unavailable', 'bike'],
];

export async function render(el, ctx) {
  const writer = canWrite(ctx.user);
  let filter = 'all';
  let tab = 'waiting';
  try { tab = localStorage.getItem('rr-dispatch-tab') || 'waiting'; } catch {}
  let requests, riders, summary = null, openIncidents = 0;
  const load = async () => {
    const [a, b] = await Promise.all([api.get('/api/requests?status=open'), api.get('/api/stats')]);
    requests = a.requests; riders = b.riders; summary = b.availability; openIncidents = b.openIncidents || 0;
  };
  await load();

  const match = (r) => filter === 'all' || (filter === 'urgent' ? r.priority === 'urgent' : r.category === filter);

  const ticket = (r) => {
    const locked = r.status === 'collected';
    const drag = writer && !locked;
    return html`
    <article class="ticket ${r.priority === 'urgent' ? 'urgent' : ''} cat-${r.category} ${locked ? 'locked' : ''} ${writer ? '' : 'ro'}" ${drag ? html`draggable="true"` : ''} data-id="${r.id}"
      aria-label="${r.ref} ${r.title}">
      <div class="t-top"><span class="mono muted" style="font-size:12px">${r.ref}</span>${urgentBadge(r.priority)}${categoryBadge(r.category)}<span class="grow"></span>${r.status !== 'pending' ? statusBadge(r.status) : ''}</div>
      <a class="t-title" href="#/requests/${r.id}">${r.title}</a>
      <div class="route-mini" style="font-size:12.5px">
        <div><i class="p"></i><span class="t">${r.pickup.address}${r.pickups?.length > 1 ? ` (+${r.pickups.length - 1} pickup${r.pickups.length > 2 ? 's' : ''})` : ''}</span></div>
        <div><i class="d"></i><span class="t">${r.dropoffs[0].address}${r.dropoffs.length > 1 ? ` (+${r.dropoffs.length - 1})` : ''}</span></div>
      </div>
      <div class="row between" style="gap:6px">
        ${r.scheduledAt ? scheduleBadge(r) || html`<span class="muted t-when">${ic('calendar', 'sm')}${fmtDateTime(r.scheduledAt)}</span>` : html`<span class="muted t-when">${ic('clock', 'sm')}${timeAgo(r.createdAt)}</span>`}
        <span class="row" style="gap:4px;color:var(--muted)">${r.handling.slice(0, 4).map((h) => html`<span title="${HANDLING[h].label}">${ic(HANDLING[h].icon, 'sm')}</span>`)}</span>
        ${locked ? html`<span title="Rider fixed after collection" class="muted">${ic('lock', 'sm')}</span>`
          : writer ? html`<button class="btn sm ${r.status === 'pending' ? 'primary' : 'ghost'}" data-pick="${r.id}" aria-label="Assign ${r.ref}">${ic('bike', 'sm')}<span>${r.status === 'pending' ? 'Assign' : ''}</span></button>` : ''}
      </div>
    </article>`;
  };

  const riderLane = (rd, on) => {
    const jobs = requests.filter((r) => r.rider?.id === rd.id && match(r));
    return html`
    <section class="lane rider-lane ${on ? 'avail' : 'unavail'}" data-lane="${rd.id}" data-on="${on ? '1' : '0'}" aria-label="${rd.name}, ${on ? 'available' : 'off shift'}">
      <div class="lane-head">
        <span class="av-wrap ${on ? 'on' : ''}">${avatar(rd.name)}</span>
        <div class="grow">
          <b>${rd.name} ${vehicleBadge(rd.vehicle)}</b>
          <small>${on ? html`<span class="onshift"></span>In ${fmtTime(rd.onShiftSince)} · ${lastSeen(rd)}` : html`<span class="offshift"></span>Clocked out`} · ${rd.openJobs} open${on ? ` · ${rd.doneToday} done today` : ''}</small>
          <div class="row wrap" style="gap:4px;margin-top:4px">${availBadge(rd)}${ratingBadge(rd)}${tagBadges(rd.tags)}</div>
          ${on ? html`<div class="load" title="${rd.openJobs} open job${rd.openJobs === 1 ? '' : 's'}"><i style="width:${Math.min(100, rd.openJobs * 25)}%"></i></div>` : ''}
        </div>
      </div>
      <div class="lane-body">${jobs.length ? jobs.map(ticket)
        : html`<div class="drop-hint">${ic(on ? 'bike' : 'power')}<p>${writer ? (on ? 'Ready for work: drop a request here' : 'Off shift. Drop here to assign anyway') : on ? 'No open jobs' : 'Off shift'}</p></div>`}</div>
    </section>`;
  };

  const paint = () => {
    const waiting = requests.filter((r) => r.status === 'pending' && match(r));
    const dueNow = waiting.filter((r) => !isScheduledLater(r));
    const later = waiting.filter(isScheduledLater).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const RANK = { available: 0, assigned: 1, on_delivery: 2, on_break: 3 };
    const avail = riders.filter((rd) => rd.onShift).sort((a, b) => (a.unresponsive - b.unresponsive) || (RANK[a.availability] ?? 1) - (RANK[b.availability] ?? 1) || a.openJobs - b.openJobs || a.name.localeCompare(b.name));
    const unavail = riders.filter((rd) => !rd.onShift);
    const counts = { waiting: waiting.length, available: avail.length, unavailable: unavail.length };
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>Dispatch board</h1><p>${writer
          ? 'Drag a waiting request onto an available rider, or tap Assign. Riders can also accept open jobs themselves.'
          : 'Live view of waiting work and rider availability.'}</p></div>
        <div class="row wrap">
          ${writer ? '' : readOnlyChip()}
          <div class="seg" role="group" aria-label="Filter requests">
            ${[['all', 'All'], ['urgent', 'Urgent'], ['triangle', 'Triangle'], ['finance', 'Finance'], ['general', 'General']].map(([k, l]) => html`<button data-f="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`)}
          </div>
          ${writer ? html`<button class="btn" id="announce">${ic('megaphone', 'sm')}<span>Announce</span></button>` : ''}
          <button class="icon-btn" id="refresh" aria-label="Refresh" title="Refresh">${ic('refresh')}</button>
        </div>
      </div>
      ${summary ? html`<div class="avail-strip" aria-label="Rider availability">
        <span class="as s-delivered"><b>${summary.readyNow}</b>Ready now</span>
        <span class="as s-assigned"><b>${summary.assigned}</b>Assigned</span>
        <span class="as s-collected"><b>${summary.on_delivery}</b>On delivery</span>
        <span class="as s-pending"><b>${summary.on_break}</b>On break</span>
        <span class="as"><b>${summary.offline}</b>Offline</span>
        ${summary.unresponsive ? html`<span class="as s-failed"><b>${summary.unresponsive}</b>Not responding</span>` : ''}
        ${openIncidents ? html`<a class="as s-failed" href="#/incidents"><b>${openIncidents}</b>Open incident${openIncidents > 1 ? 's' : ''}</a>` : ''}
      </div>` : ''}
      <div class="dispatch-tabs" role="tablist" aria-label="Board sections">
        ${TABS.map(([k, label, icon]) => html`<button role="tab" class="dt-${k} ${tab === k ? 'on' : ''}" aria-selected="${tab === k}" data-tab="${k}">
          ${ic(icon, 'sm')}<span>${label}</span><b>${counts[k]}</b></button>`)}
      </div>
      <div class="dispatch" id="board" data-tab="${tab}">
        <section class="zone zone-waiting lane unassigned" data-lane="none" aria-label="Waiting requests">
          <header class="zone-head">
            <span class="zi">${ic('clock', 'sm')}</span>
            <div class="grow"><h2>Waiting requests</h2><small>${waiting.length} without a rider · priority order</small></div>
          </header>
          <div class="lane-body">
            ${dueNow.length ? dueNow.map(ticket) : html`<div class="drop-hint">${ic('checkCircle')}<p>${later.length ? 'Nothing due now' : 'All caught up'}</p></div>`}
            ${later.length ? html`<div class="sub-head">${ic('calendar', 'sm')} Scheduled later <span class="n">${later.length}</span></div>${later.map(ticket)}` : ''}
          </div>
        </section>
        <div class="zone-riders">
          <section class="zone zone-available" aria-label="Available riders">
            <header class="zone-head">
              <span class="zi">${ic('power', 'sm')}</span>
              <div class="grow"><h2>Riders on shift</h2><small>${avail.length} of ${riders.length} clocked in · ready riders first</small></div>
              ${avail.length ? html`<span class="live-pill"><i></i>On shift</span>` : ''}
            </header>
            ${avail.length ? html`<div class="rider-grid">${avail.map((rd) => riderLane(rd, true))}</div>`
              : html`<div class="zone-empty">${ic('power')}<p><b>No riders on shift.</b> ${writer ? html`Switch riders on from <a href="#/shifts">Shifts</a>.` : 'Riders appear here when they switch on.'}</p></div>`}
          </section>
          <section class="zone zone-unavailable" aria-label="Unavailable riders">
            <header class="zone-head">
              <span class="zi">${ic('bike', 'sm')}</span>
              <div class="grow"><h2>Offline riders</h2><small>${unavail.length} clocked out</small></div>
            </header>
            ${unavail.length ? html`<div class="rider-grid compact">${unavail.map((rd) => riderLane(rd, false))}</div>`
              : html`<div class="zone-empty">${ic('checkCircle')}<p>Every rider is on shift.</p></div>`}
          </section>
        </div>
      </div>`);
    wire();
  };

  async function doAssign(id, riderId) {
    const r = requests.find((x) => x.id === id);
    if (!r) return;
    if ((r.rider?.id ?? null) === riderId) return;
    const rd = riders.find((x) => x.id === riderId);
    if (rd && !rd.onShift && !(await confirmDialog({
      title: `${rd.name} is clocked out`, message: `Assign ${r.ref} anyway? They'll be notified, but they aren't working right now.`, confirm: 'Assign anyway', iconName: 'power',
    }))) return;
    const res = await assign(r, riderId);
    if (res) { await load(); paint(); ctx.refreshBadges(); }
  }

  function wire() {
    el.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; paint(); }));
    el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      if (!b.matches('button')) return;
      tab = b.dataset.tab;
      try { localStorage.setItem('rr-dispatch-tab', tab); } catch {}
      el.querySelector('#board').dataset.tab = tab;
      el.querySelectorAll('.dispatch-tabs button').forEach((x) => { const on = x.dataset.tab === tab; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); });
    }));
    el.querySelector('#refresh').addEventListener('click', async () => { await load(); paint(); toast('Board refreshed'); });
    el.querySelector('#announce')?.addEventListener('click', async () => {
      const data = await openModal({
        title: 'Send an announcement', subtitle: 'Shown in the app straight away. Mark it important to also send it by SMS to anyone who does not see it.', iconName: 'megaphone',
        body: html`<div class="field"><label for="an-t">Message</label><textarea class="input" id="an-t" name="text" maxlength="300" rows="3" required placeholder="e.g. Heavy traffic on Mombasa Road — use Lang'ata Road" autofocus></textarea></div>
          <div class="field"><label for="an-a">Send to</label><select class="input" id="an-a" name="audience"><option value="on_shift">Riders on shift</option><option value="riders">All riders</option><option value="everyone">Everyone in the company</option></select></div>
          <label class="switch"><input type="checkbox" name="important"> Important (SMS if not seen)</label>`,
        actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('send', 'sm')} Send</button>`,
        onMount: ({ form, close }) => form.addEventListener('submit', (e) => { e.preventDefault(); if (form.text.value.trim()) close({ text: form.text.value.trim(), audience: form.audience.value, important: form.important.checked }); }),
      });
      if (!data) return;
      try { const r = await api.post('/api/announcements', data); toast(`Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`); } catch (err) { toast(err.message, 'err'); }
    });
    if (!writer) return;
    el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', async (e) => {
      e.preventDefault();
      const r = requests.find((x) => x.id === +b.dataset.pick);
      const choice = await pickRiderDialog({ request: r, riders });
      if (choice) await doAssign(r.id, choice.riderId);
    }));
    let dragId = null;
    el.querySelectorAll('.ticket[draggable]').forEach((t) => {
      t.addEventListener('dragstart', (e) => { dragId = +t.dataset.id; t.classList.add('dragging'); el.querySelector('#board').classList.add('dragging-on'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.dataset.id); });
      t.addEventListener('dragend', () => { t.classList.remove('dragging'); el.querySelector('#board')?.classList.remove('dragging-on'); el.querySelectorAll('.lane').forEach((l) => l.classList.remove('drop-ok')); });
    });
    el.querySelectorAll('.lane').forEach((lane) => {
      lane.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); lane.classList.add('drop-ok'); } });
      lane.addEventListener('dragleave', (e) => { if (!lane.contains(e.relatedTarget)) lane.classList.remove('drop-ok'); });
      lane.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        lane.classList.remove('drop-ok');
        const id = dragId; dragId = null;
        if (!id) return;
        await doAssign(id, lane.dataset.lane === 'none' ? null : +lane.dataset.lane);
      });
    });
  }
  paint();
  const refresh = async () => {
    if (document.querySelector('.modal-back') || el.querySelector('.dragging')) return;
    try { await load(); paint(); } catch {}
  };
  ctx.onLive(refresh, ['change', 'riders', 'incident', 'shifts']);
  ctx.poll(refresh, 20000);
}
