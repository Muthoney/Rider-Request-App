import { api } from '../api.js';
import { html, ic, statusBadge, categoryBadge, urgentBadge, avatar, timeAgo, fmtDateTime, tagBadges, HANDLING, toast } from '../ui.js';
import { assign, pickRiderDialog } from './actions.js';

export async function render(el, ctx) {
  let filter = 'all';
  let showOff = true;
  let requests, riders;
  const load = async () => {
    const [a, b] = await Promise.all([api.get('/api/requests?status=open'), api.get('/api/stats')]);
    requests = a.requests; riders = b.riders;
  };
  await load();

  const ticket = (r) => {
    const locked = r.status === 'collected';
    return html`
    <article class="ticket ${r.priority === 'urgent' ? 'urgent' : ''} cat-${r.category} ${locked ? 'locked' : ''}" ${locked ? '' : html`draggable="true"`} data-id="${r.id}"
      aria-label="${r.ref} ${r.title}">
      <div class="t-top"><span class="mono muted" style="font-size:12px">${r.ref}</span>${urgentBadge(r.priority)}${categoryBadge(r.category)}<span class="grow"></span>${r.status !== 'pending' ? statusBadge(r.status) : ''}</div>
      <a class="t-title" href="#/requests/${r.id}">${r.title}</a>
      <div class="route-mini" style="font-size:12.5px">
        <div><i class="p"></i><span class="t">${r.pickup.address}</span></div>
        <div><i class="d"></i><span class="t">${r.dropoffs[0].address}${r.dropoffs.length > 1 ? ` (+${r.dropoffs.length - 1})` : ''}</span></div>
      </div>
      <div class="row between" style="gap:6px">
        <span class="muted" style="font-size:12px;display:inline-flex;gap:4px;align-items:center">${ic(r.scheduledAt ? 'calendar' : 'clock', 'sm')}${r.scheduledAt ? fmtDateTime(r.scheduledAt) : timeAgo(r.createdAt)}</span>
        <span class="row" style="gap:4px;color:var(--muted)">${r.handling.slice(0, 4).map((h) => html`<span title="${HANDLING[h].label}">${ic(HANDLING[h].icon, 'sm')}</span>`)}</span>
        ${locked ? html`<span title="Rider fixed after collection" class="muted">${ic('lock', 'sm')}</span>`
          : html`<button class="btn sm ghost" data-pick="${r.id}" aria-label="Assign ${r.ref}">${ic('bike', 'sm')}</button>`}
      </div>
    </article>`;
  };

  const paint = () => {
    const match = (r) => filter === 'all' || (filter === 'urgent' ? r.priority === 'urgent' : r.category === filter);
    const queue = requests.filter((r) => r.status === 'pending' && match(r));
    const lanes = riders.filter((rd) => showOff || rd.onShift || requests.some((r) => r.rider?.id === rd.id));
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>Dispatch board</h1><p>Drag a request onto a rider to assign it. Reserved work (Triangle, Finance) prompts for a recorded override.</p></div>
        <div class="row wrap">
          <div class="seg" role="group" aria-label="Filter">
            ${[['all', 'All'], ['urgent', 'Urgent'], ['triangle', 'Triangle'], ['finance', 'Finance'], ['general', 'General']].map(([k, l]) => html`<button data-f="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`)}
          </div>
          <label class="switch"><input type="checkbox" id="off" ${showOff ? 'checked' : ''}> Show off-shift</label>
          <button class="icon-btn" id="refresh" aria-label="Refresh" title="Refresh">${ic('refresh')}</button>
        </div>
      </div>
      <div class="board" id="board">
        <section class="lane unassigned" data-lane="none" aria-label="Unassigned queue">
          <div class="lane-head">
            <span class="avatar" style="background:var(--st-pending-bg);color:var(--st-pending)">${ic('clock', 'sm')}</span>
            <div class="grow"><b>Waiting for a rider</b><small>${queue.length} request${queue.length === 1 ? '' : 's'} · priority order</small></div>
          </div>
          <div class="lane-body">${queue.length ? queue.map(ticket) : html`<div class="empty" style="padding:30px 10px">${ic('checkCircle')}<p>All caught up</p></div>`}</div>
        </section>
        ${lanes.map((rd) => {
          const jobs = requests.filter((r) => r.rider?.id === rd.id && match(r));
          return html`
          <section class="lane" data-lane="${rd.id}" aria-label="${rd.name}">
            <div class="lane-head">
              ${avatar(rd.name)}
              <div class="grow">
                <b>${rd.name}</b>
                <small><span class="${rd.onShift ? 'onshift' : 'offshift'}"></span>${rd.onShift ? 'On shift' : 'Off shift'} · ${rd.openJobs} open</small>
              </div>
              <div class="row" style="gap:4px">${tagBadges(rd.tags)}</div>
            </div>
            <div class="lane-body">${jobs.length ? jobs.map(ticket) : html`<div class="empty" style="padding:26px 10px;border:1.5px dashed var(--line-2);border-radius:12px">${ic('bike')}<p style="font-size:12.5px">Drop a request here</p></div>`}</div>
          </section>`;
        })}
      </div>`);
    wire();
  };

  async function doAssign(id, riderId) {
    const r = requests.find((x) => x.id === id);
    if (!r) return;
    if ((r.rider?.id ?? null) === riderId) return;
    const res = await assign(r, riderId);
    if (res) { await load(); paint(); ctx.refreshBadges(); }
  }

  function wire() {
    el.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; paint(); }));
    el.querySelector('#off').addEventListener('change', (e) => { showOff = e.target.checked; paint(); });
    el.querySelector('#refresh').addEventListener('click', async () => { await load(); paint(); toast('Board refreshed'); });
    el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', async (e) => {
      e.preventDefault();
      const r = requests.find((x) => x.id === +b.dataset.pick);
      const choice = await pickRiderDialog({ request: r, riders });
      if (choice) await doAssign(r.id, choice.riderId);
    }));
    let dragId = null;
    el.querySelectorAll('.ticket[draggable]').forEach((t) => {
      t.addEventListener('dragstart', (e) => { dragId = +t.dataset.id; t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.dataset.id); });
      t.addEventListener('dragend', () => { t.classList.remove('dragging'); el.querySelectorAll('.lane').forEach((l) => l.classList.remove('drop-ok')); });
    });
    el.querySelectorAll('.lane').forEach((lane) => {
      lane.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); lane.classList.add('drop-ok'); } });
      lane.addEventListener('dragleave', (e) => { if (!lane.contains(e.relatedTarget)) lane.classList.remove('drop-ok'); });
      lane.addEventListener('drop', async (e) => {
        e.preventDefault();
        lane.classList.remove('drop-ok');
        const id = dragId; dragId = null;
        if (!id) return;
        await doAssign(id, lane.dataset.lane === 'none' ? null : +lane.dataset.lane);
      });
    });
  }
  paint();
  ctx.poll(async () => {
    if (document.querySelector('.modal-back') || el.querySelector('.dragging')) return;
    try { await load(); paint(); } catch {}
  }, 15000);
}
