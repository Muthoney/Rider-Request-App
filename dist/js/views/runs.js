import { api } from '../api.js';
import { html, ic, avatar, statusBadge, timeAgo, fmtTime, openModal, toast, busy, empty, confirmDialog } from '../ui.js';

const RUN_STATUS = { planned: ['Planned', 's-pending'], active: ['On the road', 's-collected'], done: ['Finished', 's-delivered'] };

export async function render(el, ctx) {
  const staff = ['admin', 'manager', 'dispatcher'].includes(ctx.user.role);
  let { runs } = await api.get('/api/runs');
  let tab = 'current';

  const runCard = (run) => {
    const stops = run.requests.flatMap((r) => r.dropoffs.map((d) => ({ r, d })));
    const done = stops.filter((s) => s.d.status === 'delivered').length;
    const pct = stops.length ? Math.round((done / stops.length) * 100) : 0;
    const [label, cls] = RUN_STATUS[run.status];
    const mine = run.rider.id === ctx.user.id;
    return html`
    <section class="card run">
      <div class="card-head">
        <div class="row">${avatar(run.rider.name)}<div><h3>${run.name}</h3><p>${run.rider.name} · ${run.requests.length} request${run.requests.length === 1 ? '' : 's'} · ${stops.length} stops</p></div></div>
        <span class="badge dot ${cls}">${label}</span>
      </div>
      <div class="card-body stack">
        <div>
          <div class="row between" style="font-size:12.5px;margin-bottom:6px"><span class="muted">${done} of ${stops.length} drop-offs delivered</span><b>${pct}%</b></div>
          <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
        </div>
        <div class="run-stops">${run.requests.map((r) => html`
          <a class="run-stop" href="#/requests/${r.id}">
            <span class="mono muted" style="font-size:12px">${r.ref}</span>
            <span class="grow" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.title}</span>
            ${statusBadge(r.status)}
          </a>`)}</div>
        <div class="row between muted" style="font-size:12.5px">
          <span>${run.startedAt ? `Started ${fmtTime(run.startedAt)}` : `Created ${timeAgo(run.createdAt)}`}${run.finishedAt ? ` · finished ${fmtTime(run.finishedAt)}` : ''}</span>
          <span class="row" style="gap:6px">
            ${run.status === 'planned' && staff ? html`<button class="btn sm ghost danger" data-run="${run.id}" data-a="delete">${ic('trash', 'sm')} Remove</button>` : ''}
            ${run.status === 'planned' && (staff || mine) ? html`<button class="btn sm primary" data-run="${run.id}" data-a="start">${ic('play', 'sm')} Start run</button>` : ''}
            ${run.status === 'active' && (staff || mine) ? html`<button class="btn sm" data-run="${run.id}" data-a="finish">${ic('stop', 'sm')} Finish run</button>` : ''}
          </span>
        </div>
      </div>
    </section>`;
  };

  const paint = () => {
    const current = runs.filter((r) => r.status !== 'done');
    const past = runs.filter((r) => r.status === 'done');
    const list = tab === 'current' ? current : past;
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>Runs</h1><p>Group a rider's jobs into one trip and track it from start to finish.</p></div>
        ${staff ? html`<button class="btn primary" id="new-run">${ic('plus', 'sm')} Plan a run</button>` : ''}
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" data-t="current" class="${tab === 'current' ? 'on' : ''}">Planned &amp; active<span class="n">${current.length}</span></button>
        <button role="tab" data-t="past" class="${tab === 'past' ? 'on' : ''}">Finished<span class="n">${past.length}</span></button>
      </div>
      ${list.length ? html`<div class="grid g-2">${list.map(runCard)}</div>`
        : html`<div class="card">${empty('route', tab === 'current' ? 'No runs planned' : 'No finished runs', staff ? 'Plan a run to batch several assigned jobs for one rider.' : 'Runs your dispatcher plans for you appear here.',
          staff && tab === 'current' ? html`<button class="btn primary" data-new>${ic('plus', 'sm')} Plan a run</button>` : '')}</div>`}`);
    el.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; paint(); }));
    el.querySelectorAll('#new-run, [data-new]').forEach((b) => b.addEventListener('click', planRun));
    el.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'delete' && !(await confirmDialog({ title: 'Remove this run?', message: 'The jobs stay assigned to the rider; only the grouping is removed.', confirm: 'Remove run', danger: true }))) return;
      await busy(b, async () => {
        try {
          await api.post(`/api/runs/${b.dataset.run}/${a}`);
          toast(a === 'start' ? 'Run started — ride safe!' : a === 'finish' ? 'Run finished' : 'Run removed');
          ({ runs } = await api.get('/api/runs')); paint();
        } catch (err) { toast(err.message, 'err'); }
      });
    }));
  };

  async function planRun() {
    const [{ requests }, stats] = await Promise.all([api.get('/api/requests?status=open'), api.get('/api/stats')]);
    const eligible = requests.filter((r) => r.rider && !r.runId && ['assigned', 'collected'].includes(r.status));
    const riders = stats.riders.filter((rd) => eligible.some((r) => r.rider.id === rd.id));
    if (!riders.length) { toast('No assigned jobs are free to group. Assign requests on the dispatch board first.', 'warn'); return; }
    const res = await openModal({
      title: 'Plan a run', subtitle: 'Pick a rider, then the jobs to batch together.', iconName: 'route', wide: true,
      body: html`
        <div class="field"><label for="rr">Rider</label>
          <select class="input" id="rr" name="riderId">${riders.map((rd) => html`<option value="${rd.id}">${rd.name}${rd.onShift ? ' · on shift' : ''}</option>`)}</select></div>
        <div class="field"><label for="rn">Run name <span class="muted">(optional)</span></label><input class="input" id="rn" name="name" maxlength="80" placeholder="e.g. Westlands morning loop"></div>
        <div class="field"><span class="label">Jobs</span><div class="pick-list" id="jobs"></div></div>
        <p class="error-text" id="rerr" hidden></p>`,
      actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('route', 'sm')} Create run</button>`,
      onMount: ({ form, close }) => {
        const fill = () => {
          const rid = +form.riderId.value;
          form.querySelector('#jobs').innerHTML = String(html`${eligible.filter((r) => r.rider.id === rid).map((r) => html`
            <label class="pick"><input type="checkbox" name="req" value="${r.id}" checked>
              <div class="grow"><b>${r.title}</b><div class="req-sub"><span class="mono">${r.ref}</span>· ${r.dropoffs.length} stop${r.dropoffs.length > 1 ? 's' : ''} · ${r.dropoffs[0].address}</div></div>
              ${statusBadge(r.status)}</label>`)}`);
        };
        form.riderId.addEventListener('change', fill);
        fill();
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const ids = [...form.querySelectorAll('[name=req]:checked')].map((x) => +x.value);
          const err = form.querySelector('#rerr');
          if (!ids.length) { err.textContent = 'Select at least one job.'; err.hidden = false; return; }
          try {
            const out = await api.post('/api/runs', { riderId: +form.riderId.value, name: form.name.value.trim() || null, requestIds: ids });
            close(out.run);
          } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        });
      },
    });
    if (res) { toast(`Run “${res.name}” planned`); ({ runs } = await api.get('/api/runs')); tab = 'current'; paint(); }
  }

  paint();
  ctx.poll(async () => { if (!document.querySelector('.modal-back')) { try { ({ runs } = await api.get('/api/runs')); paint(); } catch {} } }, 30000);
}
