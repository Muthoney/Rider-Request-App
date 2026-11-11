import { api } from '../api.js';
import { html, ic, raw, CATEGORY, HANDLING, toast, busy, toLocalInput, esc, fmtDateTime, timeAgo } from '../ui.js';
import { parseWhatsApp, parsePin } from '../whatsapp.js';
import { renderMap, placePoints } from '../map.js';
import { isInKenya } from '../kenya.js';
import { quote, routeKm, estimateMinutes, kes } from '../fuel.js';

const SAMPLE = `[07/11/2026, 09:14] Joy (Studio): Hi dispatch 👋
Item: Campaign proofs for Triangle sign-off
Pickup: Example Media HQ, Westlands (Reception)
📍 Location: https://maps.google.com/?q=-1.2649,36.8028
Drop 1: Triangle Agency, Argwings Kodhek Rd, Kilimani
Contact: Joseph Kip 0711 000 202
https://www.google.com/maps/@-1.2905,36.7840,17z
Drop 2: Print House, Enterprise Rd, Industrial Area
Contact: Print desk 0711 000 203
Note: fragile – keep upright, signature needed`;

const blankStop = () => ({ address: '', contactName: '', contactPhone: '', lat: null, lng: null, instructions: '' });
const MAX_DAYS = 180;
const dayStr = (d) => toLocalInput(d.toISOString()).slice(0, 10);
/** Quick schedule presets (local time). */
function presets() {
  const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
  const soon = new Date(Date.now() + 2 * 3600e3); soon.setMinutes(soon.getMinutes() < 30 ? 30 : 60, 0, 0);
  const monday = at(((8 - new Date().getDay()) % 7) || 7, 9);
  return [
    ['In 2 hours', soon], ['Tomorrow 9:00', at(1, 9)], ['Tomorrow 14:00', at(1, 14)], ['Next Monday 9:00', monday],
  ].filter(([, d]) => d > new Date());
}

export async function render(el, ctx) {
  const editing = !!ctx.params.id;
  let existing = null;
  if (editing) {
    ({ request: existing } = await api.get(`/api/requests/${ctx.params.id}`));
  }
  const state = existing ? {
    title: existing.title, category: existing.category, priority: existing.priority, scheduledAt: existing.scheduledAt,
    pickup: { ...existing.pickup }, dropoffs: existing.dropoffs.map((d) => ({ ...d })), handling: [...existing.handling],
    handlingNotes: existing.handlingNotes || '', notes: existing.notes || '', source: existing.source, version: existing.version,
  } : {
    title: '', category: 'general', priority: 'normal', scheduledAt: null, pickup: blankStop(), dropoffs: [blankStop()],
    handling: [], handlingNotes: '', notes: '', source: 'form',
  };
  if (!existing) {
    state.pickup.address = '';
  }
  let fuelSettings = null;
  api.get('/api/fuel/settings').then((r) => { fuelSettings = r.settings; refreshSummary(); }).catch(() => {});
  let schedule = !!state.scheduledAt;
  // Opened from a "Schedule" button: start in scheduling mode with tomorrow 9:00 proposed.
  if (!editing && ctx.query.get('schedule') === '1') {
    schedule = true;
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    state.scheduledAt = d.toISOString();
  }
  let parsed = null;
  const showImport = ctx.query.get('import') === '1';

  const PIN_HINT = 'Kenya only. Without a pin, the map uses the landmark or street named in the address.';
  const pinField = (prefix, stop, i) => html`
    <div class="field">
      <label for="${prefix}-pin">Map pin <span class="muted" style="font-weight:500">(optional)</span></label>
      <div class="row" style="gap:8px">
        <div class="input-icon grow">${ic('pin', 'sm')}<input class="input" id="${prefix}-pin" data-pin="${i}" placeholder="Paste a Google Maps link or “-1.28, 36.82”"
          value="${stop.lat != null ? `${stop.lat}, ${stop.lng}` : ''}"></div>
        <button type="button" class="btn" data-find="${i}" title="Find the address in Kenya">${ic('search', 'sm')} Find in Kenya</button>
      </div>
      <div class="place-results" data-results="${i}" hidden></div>
      <span class="hint" data-pin-status="${i}">${stop.lat != null ? html`<span class="coord-ok">${ic('check', 'sm')} Pin placed</span>` : PIN_HINT}</span>
    </div>`;

  const dropoffHtml = (d, i, n) => html`
    <div class="dropoff-edit" data-drop="${i}">
      <div class="dh">
        <span class="num">${i + 1}</span><b class="grow">Drop-off ${i + 1}</b>
        <button type="button" class="icon-btn" data-move="${i}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ic('arrowUp', 'sm')}</button>
        <button type="button" class="icon-btn" data-move="${i}" data-dir="1" aria-label="Move down" ${i === n - 1 ? 'disabled' : ''}>${ic('arrowDown', 'sm')}</button>
        <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove drop-off ${i + 1}" ${n === 1 ? 'disabled' : ''}>${ic('trash', 'sm')}</button>
      </div>
      <div class="form-grid">
        <div class="field full"><label for="d${i}-address">Address</label>
          <input class="input" id="d${i}-address" data-k="address" value="${d.address}" placeholder="Building, street, area" required></div>
        <div class="field"><label for="d${i}-cn">Recipient</label><input class="input" id="d${i}-cn" data-k="contactName" value="${d.contactName || ''}" placeholder="Name"></div>
        <div class="field"><label for="d${i}-cp">Phone</label><input class="input" id="d${i}-cp" data-k="contactPhone" type="tel" value="${d.contactPhone || ''}" placeholder="+254 7…"></div>
        <div class="field full"><label for="d${i}-ins">Instructions for this stop</label><input class="input" id="d${i}-ins" data-k="instructions" value="${d.instructions || ''}" placeholder="e.g. Leave with reception, ask for Mercy"></div>
        <div class="full">${pinField(`d${i}`, d, i)}</div>
      </div>
    </div>`;

  function readDom() {
    const f = el.querySelector('#rf');
    state.title = f.title.value;
    state.category = f.category.value;
    state.priority = f.urgent.checked ? 'urgent' : 'normal';
    schedule = f.when.value === 'later';
    state.scheduledAt = schedule && f.sDate.value && f.sTime.value ? new Date(`${f.sDate.value}T${f.sTime.value}`).toISOString() : null;
    state.pickup.address = f.p_address.value;
    state.pickup.contactName = f.p_contactName.value;
    state.pickup.contactPhone = f.p_contactPhone.value;
    state.handling = [...f.querySelectorAll('input[name=handling]:checked')].map((x) => x.value);
    state.handlingNotes = f.handlingNotes.value;
    state.notes = f.notes.value;
    el.querySelectorAll('[data-drop]').forEach((box) => {
      const d = state.dropoffs[+box.dataset.drop];
      box.querySelectorAll('[data-k]').forEach((inp) => { d[inp.dataset.k] = inp.value; });
    });
  }

  function summary() {
    const pts = [
      { label: 'P', kind: 'pickup', address: state.pickup.address, lat: state.pickup.lat, lng: state.pickup.lng },
      ...state.dropoffs.map((d, i) => ({ label: String(i + 1), kind: 'drop', address: d.address, lat: d.lat, lng: d.lng })),
    ].filter((p) => p.address || p.lat != null);
    const placed = placePoints(pts).filter((p) => !p.unplaced);
    let est = null;
    if (fuelSettings && placed.length >= 2) {
      const km = routeKm(placed, fuelSettings.roadFactor);
      est = quote({ km, minutes: estimateMinutes(km, state.dropoffs.length + 1) }, fuelSettings);
    }
    return html`
      <div class="card-head"><h3>Summary</h3>${state.priority === 'urgent' ? html`<span class="badge p-urgent">${ic('flag')}Urgent</span>` : ''}</div>
      <div class="card-body stack">
        ${pts.length ? raw(renderMap(pts, { width: 360, height: 210, compact: true })) : html`<div class="map" style="height:150px;display:grid;place-items:center;color:var(--muted)">${ic('pin')} Add addresses to preview the route</div>`}
        <dl class="kv" style="grid-template-columns:96px 1fr">
          <dt>Category</dt><dd>${CATEGORY[state.category].label}</dd>
          <dt>Pickup</dt><dd>${schedule && state.scheduledAt ? html`<span class="badge s-scheduled">${ic('calendar')}Scheduled</span> ${new Date(state.scheduledAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} <span class="muted">(${timeAgo(state.scheduledAt)})</span>` : schedule ? html`<span class="muted">Choose a date and time</span>` : 'As soon as possible'}</dd>
          <dt>Stops</dt><dd>1 pickup · ${state.dropoffs.length} drop-off${state.dropoffs.length > 1 ? 's' : ''}</dd>
          <dt>Handling</dt><dd>${state.handling.length ? state.handling.map((h) => HANDLING[h].label).join(', ') : 'Standard'}</dd>
          <dt>Quote</dt><dd>${est ? html`<b>${kes(est.total)}</b> <span class="muted">≈ ${est.km} km · ${est.minutes} min · ${est.energy} ${est.unit} ${est.vehicle === 'electric' ? 'electricity' : 'fuel'}</span>` : html`<span class="muted">Add Kenyan addresses or pins to estimate</span>`}</dd>
        </dl>
        ${state.category !== 'general' ? html`<div class="alert info">${ic(CATEGORY[state.category].icon, 'sm')}<span>${CATEGORY[state.category].label} work is reserved for designated riders. Dispatch must record a reason to substitute.</span></div>` : ''}
      </div>`;
  }

  function importPreview() {
    if (!parsed) return '';
    const p = parsed;
    return html`
      <div class="parsed">
        ${p.title ? html`<div><span>Item</span><b>${p.title}</b></div>` : ''}
        <div><span>Pickup</span><b>${p.pickup.address || '—'}</b>${p.pickup.lat != null ? ic('pin', 'sm') : ''}</div>
        ${p.dropoffs.map((d, i) => html`<div><span>Drop ${i + 1}</span><span><b>${d.address}</b>${d.contactName ? html`<br><span class="muted">${d.contactName} ${d.contactPhone || ''}</span>` : ''}</span>${d.lat != null ? ic('pin', 'sm') : ''}</div>`)}
        ${p.handling.length ? html`<div><span>Handling</span><span>${p.handling.map((h) => HANDLING[h].label).join(', ')}</span></div>` : ''}
        <div><span>Pins</span><span>${p.pins.filter((x) => x.lat != null).length} found</span></div>
      </div>
      ${p.warnings.map((w) => html`<div class="alert warn" style="font-size:12.5px">${ic('alert', 'sm')}<span>${w}</span></div>`)}
      <button type="button" class="btn primary block" id="wa-apply">${ic('wand', 'sm')} Fill the form</button>`;
  }

  function paint() {
    el.innerHTML = String(html`
    <div class="crumbs"><a href="#/requests">Requests</a>${ic('chevronRight', 'sm')}<span>${editing ? existing.ref : 'New'}</span></div>
    <div class="page-head">
      <div><h1>${editing ? `Edit ${existing.ref}` : schedule ? 'Schedule a delivery' : 'New delivery request'}</h1>
        <p>${editing ? 'Changes are version-checked, so you will never overwrite someone else’s update.' : 'Tell us what is moving, where from and where to. A dispatcher will assign a rider.'}</p></div>
    </div>
    <div class="grid g-main-wide">
      <form id="rf" class="stack" novalidate>
        <div class="alert err" id="form-err" hidden role="alert"></div>
        <section class="card">
          <div class="card-head"><span class="section-title"><span class="si">${ic('package', 'sm')}</span><h2>What's being delivered</h2></span></div>
          <div class="card-body stack">
            <div class="field"><label for="title">Description</label>
              <input class="input" id="title" name="title" maxlength="120" required value="${state.title}" placeholder="e.g. Signed contracts for client review"></div>
            <div class="field"><span class="label">Category</span>
              <div class="choice-cards" role="radiogroup" aria-label="Category">${Object.entries(CATEGORY).map(([k, c]) => html`
                <label class="choice"><input type="radio" name="category" value="${k}" ${state.category === k ? 'checked' : ''}>
                  <b>${ic(c.icon, 'sm')}${c.label}</b><small>${c.desc}</small></label>`)}</div>
            </div>
            <label class="switch"><input type="checkbox" name="urgent" ${state.priority === 'urgent' ? 'checked' : ''}> ${ic('flag', 'sm')} Urgent</label>
          </div>
        </section>

        <section class="card" id="when-card">
          <div class="card-head"><span class="section-title"><span class="si">${ic('calendar', 'sm')}</span><div><h2>When</h2><p>Send a rider now, or schedule the pickup for a future date</p></div></span></div>
          <div class="card-body stack">
            <div class="choice-cards two" role="radiogroup" aria-label="Pickup time">
              <label class="choice"><input type="radio" name="when" value="now" ${!schedule ? 'checked' : ''}>
                <b>${ic('clock', 'sm')}As soon as possible</b><small>The next available rider is assigned.</small></label>
              <label class="choice"><input type="radio" name="when" value="later" ${schedule ? 'checked' : ''}>
                <b>${ic('calendarPlus', 'sm')}Schedule for later</b><small>Choose a date and time, up to ${MAX_DAYS} days ahead.</small></label>
            </div>
            <div class="schedule-box stack-sm" data-schedule ${schedule ? '' : 'hidden'}>
              <div class="form-grid">
                <div class="field"><label for="sDate">Pickup date</label>
                  <input class="input" type="date" id="sDate" name="sDate" min="${dayStr(new Date())}" max="${dayStr(new Date(Date.now() + MAX_DAYS * 864e5))}" value="${toLocalInput(state.scheduledAt).slice(0, 10)}"></div>
                <div class="field"><label for="sTime">Pickup time</label>
                  <input class="input" type="time" id="sTime" name="sTime" step="900" value="${toLocalInput(state.scheduledAt).slice(11, 16)}"></div>
              </div>
              <div class="chips" role="group" aria-label="Quick picks">${presets().map(([label, d]) => html`
                <button type="button" class="chip" data-preset="${d.toISOString()}">${ic('clock', 'sm')}${label}</button>`)}</div>
              <span class="hint" id="s-hint">The request shows as <b>Scheduled</b>. Dispatch assigns a rider before the pickup time, and the rider is notified.</span>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><span class="section-title"><span class="si">${ic('pin', 'sm')}</span><h2>Pickup</h2></span></div>
          <div class="card-body form-grid">
            <div class="field full"><label for="p_address">Pickup address</label>
              <input class="input" id="p_address" name="p_address" required value="${state.pickup.address}" placeholder="Where should the rider collect from?"></div>
            <div class="field"><label for="p_cn">Contact at pickup</label><input class="input" id="p_cn" name="p_contactName" value="${state.pickup.contactName || ''}" placeholder="Name"></div>
            <div class="field"><label for="p_cp">Phone</label><input class="input" id="p_cp" name="p_contactPhone" type="tel" value="${state.pickup.contactPhone || ''}" placeholder="+254 7…"></div>
            <div class="full">${pinField('p', state.pickup, 'p')}</div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <span class="section-title"><span class="si">${ic('route', 'sm')}</span><h2>Drop-offs</h2></span>
            <span class="muted">${state.dropoffs.length} of 12</span>
          </div>
          <div class="card-body stack" id="drops">
            ${state.dropoffs.map((d, i) => dropoffHtml(d, i, state.dropoffs.length))}
            <button type="button" class="btn" id="add-drop" ${state.dropoffs.length >= 12 ? 'disabled' : ''}>${ic('plus', 'sm')} Add another drop-off</button>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><span class="section-title"><span class="si">${ic('hand', 'sm')}</span><h2>Item handling</h2></span></div>
          <div class="card-body stack">
            <div class="chips">${Object.entries(HANDLING).map(([k, h]) => html`
              <label class="chip"><input type="checkbox" name="handling" value="${k}" ${state.handling.includes(k) ? 'checked' : ''}>${ic(h.icon, 'sm')}${h.label}</label>`)}</div>
            <div class="field"><label for="hn">Handling notes</label><textarea class="input" id="hn" name="handlingNotes" maxlength="1000" placeholder="Anything the rider must know about the items">${state.handlingNotes}</textarea></div>
            <div class="field"><label for="notes">Notes for dispatch</label><textarea class="input" id="notes" name="notes" maxlength="2000" placeholder="Deadlines, cost centre, context…">${state.notes}</textarea></div>
          </div>
          <div class="card-foot row between">
            <a class="btn ghost" href="${editing ? `#/requests/${existing.id}` : '#/requests'}">Cancel</a>
            <button class="btn primary lg" type="submit" data-busy=" Saving…">${ic('check', 'sm')} ${editing ? 'Save changes' : 'Submit request'}</button>
          </div>
        </section>
      </form>

      <aside class="stack sticky">
        <section class="card wa">
          <div class="card-head">
            <span class="section-title"><span class="wa-ic">${ic('whatsapp', 'sm')}</span><div><h3>Import from WhatsApp</h3><p>Paste a message and map pins</p></div></span>
          </div>
          <div class="card-body stack-sm">
            <textarea class="input" id="wa-text" rows="${showImport ? 9 : 5}" placeholder="Paste the WhatsApp message here…" aria-label="WhatsApp message"></textarea>
            <div class="row"><button type="button" class="btn sm" id="wa-parse">${ic('wand', 'sm')} Read message</button><button type="button" class="btn sm ghost" id="wa-sample">Try an example</button></div>
            <div id="wa-out">${importPreview()}</div>
            <p class="faint" style="font-size:12px">Paste-in import only: reading a message here sends nothing to WhatsApp.</p>
          </div>
        </section>
        <section class="card" id="summary">${summary()}</section>
      </aside>
    </div>`);
    wire();
  }

  let summaryTimer;
  const refreshSummary = () => { clearTimeout(summaryTimer); summaryTimer = setTimeout(() => { readDom(); el.querySelector('#summary').innerHTML = String(summary()); }, 250); };

  function wire() {
    const f = el.querySelector('#rf');
    f.addEventListener('input', refreshSummary);
    const box = el.querySelector('[data-schedule]');
    const setWhen = (iso) => { const v = toLocalInput(iso); f.sDate.value = v.slice(0, 10); f.sTime.value = v.slice(11, 16); };
    f.addEventListener('change', (e) => {
      if (e.target.name === 'when') {
        const later = f.when.value === 'later';
        box.hidden = !later;
        if (later && !f.sDate.value) {
          const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
          setWhen(d.toISOString());
        }
        if (later) f.sDate.focus();
      }
      refreshSummary();
    });
    el.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      setWhen(b.dataset.preset);
      el.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('on', x === b));
      refreshSummary();
    }));
    el.querySelectorAll('[data-pin]').forEach((inp) => inp.addEventListener('change', () => {
      const key = inp.dataset.pin;
      const stop = key === 'p' ? state.pickup : state.dropoffs[+key];
      const status = el.querySelector(`[data-pin-status="${key}"]`);
      const v = inp.value.trim();
      if (!v) { stop.lat = stop.lng = null; status.textContent = PIN_HINT; refreshSummary(); return; }
      const pin = parsePin(v);
      if (pin && pin.lat != null && !isInKenya(pin.lat, pin.lng)) {
        stop.lat = stop.lng = null;
        status.innerHTML = `<span class="error-text">${esc('That pin is outside Kenya. Use a location in Kenya.')}</span>`;
      } else if (pin && pin.lat != null) {
        stop.lat = pin.lat; stop.lng = pin.lng;
        status.innerHTML = String(html`<span class="coord-ok">${ic('check', 'sm')} Pin placed at ${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}</span>`);
      } else {
        stop.lat = stop.lng = null;
        status.innerHTML = `<span class="error-text">${esc(pin?.unresolved ? 'Short links can’t be read. Open it and copy the full link or coordinates.' : 'No coordinates found in that text.')}</span>`;
      }
      refreshSummary();
    }));
    el.querySelectorAll('[data-find]').forEach((b) => b.addEventListener('click', () => findPlace(b.dataset.find, b)));
    el.querySelector('#add-drop').addEventListener('click', () => {
      readDom(); state.dropoffs.push(blankStop()); paint();
      el.querySelector(`#d${state.dropoffs.length - 1}-address`)?.focus();
    });
    el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      readDom(); state.dropoffs.splice(+b.dataset.remove, 1); paint();
    }));
    el.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
      readDom();
      const i = +b.dataset.move, j = i + +b.dataset.dir;
      [state.dropoffs[i], state.dropoffs[j]] = [state.dropoffs[j], state.dropoffs[i]];
      paint();
      el.querySelector(`[data-move="${j}"][data-dir="${b.dataset.dir}"]`)?.focus();
    }));

    const ta = el.querySelector('#wa-text');
    el.querySelector('#wa-sample').addEventListener('click', () => { ta.value = SAMPLE; el.querySelector('#wa-parse').click(); });
    el.querySelector('#wa-parse').addEventListener('click', () => {
      if (!ta.value.trim()) { toast('Paste a message first.', 'warn'); ta.focus(); return; }
      parsed = parseWhatsApp(ta.value);
      el.querySelector('#wa-out').innerHTML = String(importPreview());
      el.querySelector('#wa-apply')?.addEventListener('click', applyImport);
    });
    el.querySelector('#wa-apply')?.addEventListener('click', applyImport);

    f.addEventListener('submit', submit);
  }

  async function findPlace(key, btn) {
    readDom();
    const stop = key === 'p' ? state.pickup : state.dropoffs[+key];
    const box = el.querySelector(`[data-results="${key}"]`);
    const q = stop.address.trim();
    if (q.length < 2) { toast('Type the address first, e.g. “Yaya Centre, Argwings Kodhek Rd”.', 'warn'); return; }
    await busy(btn, async () => {
      try {
        const { results, source } = await api.get(`/api/geocode?q=${encodeURIComponent(q)}`);
        box.hidden = false;
        box.innerHTML = String(results.length ? html`
          ${results.map((r, n) => html`<button type="button" class="place" data-n="${n}">${ic('pin', 'sm')}<span class="grow"><b>${r.label}</b><small>${r.address}</small></span>${r.approximate ? html`<span class="badge b-outline">≈ area</span>` : ''}</button>`)}
          <small class="faint">${source === 'google' ? 'Results from Google Maps, limited to Kenya' : 'Kenyan landmarks, streets and areas (approximate)'}</small>`
          : html`<p class="muted" style="font-size:13px">Nothing found in Kenya for “${q}”. Try a landmark, building, street or area name.</p>`);
        box.querySelectorAll('[data-n]').forEach((x) => x.addEventListener('click', () => {
          const r = results[+x.dataset.n];
          stop.lat = r.lat; stop.lng = r.lng;
          el.querySelector(`[data-pin="${key}"]`).value = `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`;
          el.querySelector(`[data-pin-status="${key}"]`).innerHTML = String(html`<span class="coord-ok">${ic('check', 'sm')} Pinned to ${r.address}${r.approximate ? ' (approximate)' : ''}</span>`);
          box.hidden = true;
          refreshSummary();
        }));
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  function applyImport() {
    readDom();
    const p = parsed;
    const keepText = el.querySelector('#wa-text').value;
    if (p.title) state.title = p.title;
    if (p.pickup.address) state.pickup = { ...state.pickup, ...strip(p.pickup) };
    if (p.dropoffs.length) state.dropoffs = p.dropoffs.slice(0, 12).map((d) => ({ ...blankStop(), ...strip(d) }));
    state.handling = [...new Set([...state.handling, ...p.handling])];
    if (p.notes && !state.notes) state.notes = p.notes;
    if (/triangle/i.test(keepText) && state.category === 'general') state.category = 'triangle';
    else if (/\b(finance|cash|cheque|bank)\b/i.test(keepText) && state.category === 'general') state.category = 'finance';
    if (/\burgent|asap|immediately\b/i.test(keepText)) state.priority = 'urgent';
    state.source = 'whatsapp';
    parsed = null;
    paint();
    el.querySelector('#wa-text').value = keepText;
    toast('Form filled from the message — check the details before submitting.');
  }
  const strip = (s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== ''));

  async function submit(e) {
    e.preventDefault();
    readDom();
    const f = el.querySelector('#rf');
    const errBox = el.querySelector('#form-err');
    errBox.hidden = true;
    f.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
    const missing = [];
    if (!state.title.trim()) missing.push(f.title);
    if (!state.pickup.address.trim()) missing.push(f.p_address);
    state.dropoffs.forEach((d, i) => { if (!d.address.trim()) missing.push(el.querySelector(`#d${i}-address`)); });
    if (schedule && !state.scheduledAt) missing.push(f.sDate.value ? f.sTime : f.sDate);
    if (missing.length) {
      missing.forEach((x) => x.setAttribute('aria-invalid', 'true'));
      errBox.innerHTML = String(html`${ic('alert', 'sm')}<span>Fill in the highlighted fields: a description, the pickup address, every drop-off address${schedule ? ', and the pickup date and time' : ''}.</span>`);
      errBox.hidden = false; missing[0].focus();
      return;
    }
    if (schedule && new Date(state.scheduledAt) < Date.now()) {
      f.sTime.setAttribute('aria-invalid', 'true');
      errBox.innerHTML = String(html`${ic('alert', 'sm')}<span>The scheduled pickup is in the past. Choose a future date and time.</span>`);
      errBox.hidden = false; f.sDate.focus();
      return;
    }
    const payload = {
      title: state.title, category: state.category, priority: state.priority, scheduledAt: state.scheduledAt,
      pickup: state.pickup, dropoffs: state.dropoffs.map(({ address, contactName, contactPhone, lat, lng, instructions }) => ({ address, contactName, contactPhone, lat, lng, instructions })),
      handling: state.handling, handlingNotes: state.handlingNotes, notes: state.notes, source: state.source,
    };
    await busy(f.querySelector('[type=submit]'), async () => {
      try {
        const res = editing
          ? await api.patch(`/api/requests/${existing.id}`, { ...payload, version: state.version })
          : await api.post('/api/requests', payload);
        toast(editing ? 'Changes saved' : res.request.scheduledAt ? `Request ${res.request.ref} scheduled for ${fmtDateTime(res.request.scheduledAt)}` : `Request ${res.request.ref} submitted`);
        ctx.refreshBadges();
        ctx.navigate(`/requests/${res.request.id}`);
      } catch (err) {
        if (err.code === 'stale') {
          errBox.innerHTML = String(html`${ic('alert', 'sm')}<span><b>Someone else updated this request while you were editing.</b> Reload to see their changes, then re-apply yours.</span>
            <button type="button" class="btn sm" id="reload">Reload</button>`);
          errBox.hidden = false;
          errBox.querySelector('#reload').addEventListener('click', () => render(el, ctx));
        } else {
          errBox.innerHTML = String(html`${ic('alert', 'sm')}<span>${err.message}</span>`);
          errBox.hidden = false;
        }
        errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  if (editing && !['pending', 'assigned'].includes(existing.status)) {
    el.innerHTML = String(html`<div class="card"><div class="empty"><div class="art">${ic('lock')}</div><h3>This request can't be edited</h3><p>Requests are locked once items are collected.</p><a class="btn" href="#/requests/${existing.id}">Back to request</a></div></div>`);
    return;
  }
  paint();
  if (showImport) el.querySelector('#wa-text').focus();
}
