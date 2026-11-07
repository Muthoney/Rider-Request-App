import { api } from '../api.js';
import { html, ic, avatar, openModal, toast, confirmDialog, tagBadges, toLocalInput, fromLocalInput } from '../ui.js';

const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export async function render(el, ctx) {
  const staff = ['admin', 'manager', 'dispatcher'].includes(ctx.user.role);
  let week = startOfWeek(new Date());
  let riders = [];
  if (staff) riders = (await api.get('/api/stats')).riders;
  else riders = [{ id: ctx.user.id, name: ctx.user.name, tags: ctx.user.tags }];
  let shifts = [];
  const load = async () => {
    ({ shifts } = await api.get(`/api/shifts?from=${encodeURIComponent(week.toISOString())}&to=${encodeURIComponent(addDays(week, 7).toISOString())}`));
  };
  await load();

  const paint = () => {
    const days = [...Array(7)].map((_, i) => addDays(week, i));
    const today = new Date().toDateString();
    const now = Date.now();
    const total = shifts.reduce((s, x) => s + (new Date(x.endsAt) - new Date(x.startsAt)) / 3600e3, 0);
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>${staff ? 'Shifts' : 'My shifts'}</h1><p>${staff ? 'Plan who is on the road. The dispatch board shows who is on shift right now.' : 'Your scheduled hours this week.'}</p></div>
        <div class="row wrap">
          <button class="icon-btn" id="prev" aria-label="Previous week">${ic('chevronLeft')}</button>
          <b style="min-width:190px;text-align:center">${days[0].toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</b>
          <button class="icon-btn" id="next" aria-label="Next week">${ic('chevronRight')}</button>
          <button class="btn sm" id="today">This week</button>
          ${staff ? html`<button class="btn primary" id="add">${ic('plus', 'sm')} Add shift</button>` : ''}
        </div>
      </div>
      <div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="card stat"><div class="k"><span class="dot s-assigned">${ic('calendar', 'sm')}</span>Shifts this week</div><div class="v">${shifts.length}</div></div>
        <div class="card stat"><div class="k"><span class="dot s-collected">${ic('clock', 'sm')}</span>Scheduled hours</div><div class="v">${Math.round(total)}<small>h</small></div></div>
        <div class="card stat"><div class="k"><span class="dot s-delivered">${ic('bike', 'sm')}</span>On shift now</div><div class="v">${new Set(shifts.filter((s) => new Date(s.startsAt) <= now && new Date(s.endsAt) > now).map((s) => s.rider.id)).size}</div></div>
      </div>
      <div class="card" style="overflow-x:auto">
        <div class="week">
          <div class="h">Rider</div>
          ${days.map((d) => html`<div class="h ${d.toDateString() === today ? 'today' : ''}">${d.toLocaleDateString([], { weekday: 'short' })}<b>${d.getDate()}</b></div>`)}
          ${riders.map((rd) => html`
            <div class="who">${avatar(rd.name, 'sm')}<div class="grow"><b style="font-size:13px">${rd.name}</b><div class="row" style="gap:4px;margin-top:2px">${tagBadges(rd.tags)}</div></div></div>
            ${days.map((d) => {
              const ds = shifts.filter((s) => s.rider.id === rd.id && new Date(s.startsAt).toDateString() === d.toDateString());
              return html`<div class="cell ${d.toDateString() === today ? 'today' : ''}">
                ${ds.map((s) => html`<div class="shift ${new Date(s.startsAt) <= now && new Date(s.endsAt) > now ? 'now' : ''}" title="${s.note || ''}">
                  <span>${hm(s.startsAt)}–${hm(s.endsAt)}</span>
                  ${staff ? html`<button data-del="${s.id}" aria-label="Remove shift">${ic('x', 'sm')}</button>` : ''}</div>`)}
                ${staff ? html`<button class="add" data-add="${rd.id}" data-day="${d.toISOString()}" aria-label="Add shift for ${rd.name} on ${d.toLocaleDateString()}">${ic('plus', 'sm')}</button>` : ''}
              </div>`;
            })}`)}
        </div>
      </div>`);
    el.querySelector('#prev').addEventListener('click', async () => { week = addDays(week, -7); await load(); paint(); });
    el.querySelector('#next').addEventListener('click', async () => { week = addDays(week, 7); await load(); paint(); });
    el.querySelector('#today').addEventListener('click', async () => { week = startOfWeek(new Date()); await load(); paint(); });
    el.querySelector('#add')?.addEventListener('click', () => addShift());
    el.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addShift(+b.dataset.add, new Date(b.dataset.day))));
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Remove shift?', message: 'The rider will no longer show as on shift for this time.', confirm: 'Remove', danger: true }))) return;
      try { await api.del(`/api/shifts/${b.dataset.del}`); toast('Shift removed'); await load(); paint(); } catch (e) { toast(e.message, 'err'); }
    }));
  };

  async function addShift(riderId, day) {
    const base = day ? new Date(day) : new Date();
    const start = new Date(base); start.setHours(8, 0, 0, 0);
    const end = new Date(base); end.setHours(17, 0, 0, 0);
    const res = await openModal({
      title: 'Add shift', subtitle: 'Riders on shift are highlighted on the dispatch board.', iconName: 'calendar',
      body: html`
        <div class="field"><label for="sr">Rider</label><select class="input" id="sr" name="riderId">${riders.map((r) => html`<option value="${r.id}" ${r.id === riderId ? 'selected' : ''}>${r.name}</option>`)}</select></div>
        <div class="form-grid">
          <div class="field"><label for="ss">Starts</label><input class="input" id="ss" type="datetime-local" name="startsAt" value="${toLocalInput(start.toISOString())}" required></div>
          <div class="field"><label for="se">Ends</label><input class="input" id="se" type="datetime-local" name="endsAt" value="${toLocalInput(end.toISOString())}" required></div>
        </div>
        <div class="seg" aria-label="Presets">
          <button type="button" data-p="7-15">Early 07–15</button><button type="button" data-p="8-17">Day 08–17</button><button type="button" data-p="12-20">Late 12–20</button>
        </div>
        <div class="field"><label for="sn">Note <span class="muted">(optional)</span></label><input class="input" id="sn" name="note" maxlength="200" placeholder="e.g. Covering Westlands"></div>
        <p class="error-text" id="serr" hidden></p>`,
      actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('check', 'sm')} Save shift</button>`,
      onMount: ({ form, close }) => {
        form.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
          const [a, z] = b.dataset.p.split('-').map(Number);
          const d = new Date(form.startsAt.value || base);
          const s = new Date(d); s.setHours(a, 0, 0, 0);
          const e = new Date(d); e.setHours(z, 0, 0, 0);
          form.startsAt.value = toLocalInput(s.toISOString()); form.endsAt.value = toLocalInput(e.toISOString());
        }));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = form.querySelector('#serr');
          try {
            await api.post('/api/shifts', { riderId: +form.riderId.value, startsAt: fromLocalInput(form.startsAt.value), endsAt: fromLocalInput(form.endsAt.value), note: form.note.value.trim() || null });
            close(true);
          } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        });
      },
    });
    if (res) { toast('Shift added'); await load(); paint(); }
  }
  paint();
}
