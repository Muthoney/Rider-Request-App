// Fuel consumption tracker and delivery quote calculator.
import { api } from '../api.js';
import { html, ic, toast, busy, fmtDateTime, empty } from '../ui.js';
import { quote, kes } from '../fuel.js';

/** EPRA publishes new maximum pump prices on the 14th of each month (effective the 15th). */
export function nextReview(updatedAt) {
  const d = new Date(`${updatedAt}T00:00:00+03:00`);
  const r = new Date(d); r.setDate(15);
  if (d.getDate() >= 15) r.setMonth(r.getMonth() + 1);
  return r;
}
export const priceIsStale = (updatedAt) => Date.now() >= +nextReview(updatedAt);

const SOURCE = { gps: 'GPS track', estimate: 'Estimated', google: 'Google route', manual: 'Entered' };

export function breakdown(q, settings) {
  return html`<div class="quote">
    <div><span>Base fee</span><b>${kes(q.baseFee)}</b></div>
    <div><span>Fuel · ${q.km} km ÷ ${settings.kmPerLitre} km/L = ${q.litres} L × ${kes(settings.fuelPrice)}</span><b>${kes(q.fuelCost)}</b></div>
    <div><span>Rider time · ${q.minutes} min × ${kes(settings.timeRatePerHour)}/h</span><b>${kes(q.timeCost)}</b></div>
    <div class="total"><span>Quote <small>(rounded up to KES 10)</small></span><b>${kes(q.total)}</b></div>
  </div>`;
}

export async function render(el, ctx) {
  const canEdit = ['admin', 'manager'].includes(ctx.user.role);
  let days = 7;
  let report;
  let mode = 'manual';
  const load = async () => { report = await api.get(`/api/fuel/report?days=${days}`); };
  await load();

  const paint = () => {
    const s = report.settings;
    const stale = priceIsStale(s.fuelPriceUpdatedAt);
    const t = report.totals;
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>Fuel &amp; quotes</h1><p>Fuel use from riders' GPS tracks, trip costs, and a quote calculator based on distance, time and the current Kenyan pump price.</p></div>
        <div class="seg" role="group" aria-label="Period">${[7, 30, 90].map((d) => html`<button data-days="${d}" class="${days === d ? 'on' : ''}">${d} days</button>`)}</div>
      </div>
      ${stale ? html`<div class="alert warn" style="margin-bottom:16px">${ic('alert', 'sm')}<span>EPRA has published new pump prices since ${new Date(s.fuelPriceUpdatedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}. ${canEdit ? 'Update the fuel price below so quotes stay accurate.' : 'Ask a manager to update the fuel price.'}</span></div>` : ''}
      <div class="stats">
        <div class="card stat hero"><div class="k"><span class="dot">${ic('fuel', 'sm')}</span>${s.fuelType === 'diesel' ? 'Diesel' : 'Super petrol'} · Nairobi</div><div class="v">${s.fuelPrice}<small>KES/L</small></div><div class="s">Price from ${new Date(s.fuelPriceUpdatedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })} · next EPRA review ${nextReview(s.fuelPriceUpdatedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</div></div>
        <div class="card stat"><div class="k"><span class="dot s-assigned">${ic('gps', 'sm')}</span>Distance (GPS)</div><div class="v">${t.gpsKm.toFixed(1)}<small>km</small></div><div class="s">Last ${days} days</div></div>
        <div class="card stat"><div class="k"><span class="dot s-collected">${ic('fuel', 'sm')}</span>Fuel used</div><div class="v">${t.litres.toFixed(1)}<small>L</small></div><div class="s">At ${s.kmPerLitre} km/L</div></div>
        <div class="card stat"><div class="k"><span class="dot s-pending">${ic('coins', 'sm')}</span>Fuel cost</div><div class="v">${Math.round(t.fuelCost).toLocaleString('en-KE')}<small>KES</small></div></div>
        <div class="card stat"><div class="k"><span class="dot s-delivered">${ic('checkCircle', 'sm')}</span>Quoted deliveries</div><div class="v">${Math.round(t.quoted).toLocaleString('en-KE')}<small>KES</small></div><div class="s">${t.deliveries} delivered</div></div>
      </div>

      <div class="grid g-2" style="align-items:start">
        <section class="card">
          <div class="card-head"><span class="section-title"><span class="si">${ic('calc', 'sm')}</span><div><h2>Quote calculator</h2><p>Base fee + fuel + rider time</p></div></span></div>
          <form class="card-body stack" id="calc" novalidate>
            <div class="seg" role="radiogroup" aria-label="Calculate from">
              <label><input type="radio" name="mode" value="manual" ${mode === 'manual' ? 'checked' : ''}>${ic('route', 'sm')} Distance &amp; time</label>
              <label><input type="radio" name="mode" value="places" ${mode === 'places' ? 'checked' : ''}>${ic('pin', 'sm')} From addresses</label>
            </div>
            <div class="form-grid" data-mode="manual" ${mode === 'manual' ? '' : 'hidden'}>
              <div class="field"><label for="qk">Distance travelled (km)</label><input class="input" id="qk" name="km" type="number" min="0" max="2000" step="0.1" inputmode="decimal" value="10"></div>
              <div class="field"><label for="qm">Time taken (minutes)</label><input class="input" id="qm" name="minutes" type="number" min="0" max="1440" step="1" inputmode="numeric" value="40"></div>
            </div>
            <div class="stack-sm" data-mode="places" ${mode === 'places' ? '' : 'hidden'}>
              <div class="field"><label for="qf">From</label><input class="input" id="qf" name="from" placeholder="e.g. Sarit Centre, Westlands"></div>
              <div class="field"><label for="qt">To</label><input class="input" id="qt" name="to" placeholder="e.g. Industrial Area, Enterprise Road"></div>
              <div class="field"><label for="qm2">Time taken (minutes) <span class="muted">(optional, estimated if blank)</span></label><input class="input" id="qm2" name="minutes2" type="number" min="0" max="1440" inputmode="numeric"></div>
              <button type="submit" class="btn" data-busy=" Calculating…">${ic('calc', 'sm')} Calculate quote</button>
              <p class="faint" style="font-size:12px">Places must be in Kenya. Uses Google road distance when configured, otherwise a straight-line estimate × ${s.roadFactor}.</p>
            </div>
            <div id="qout"></div>
          </form>
        </section>

        <section class="card">
          <div class="card-head"><span class="section-title"><span class="si">${ic('fuel', 'sm')}</span><div><h2>Pricing</h2><p>${canEdit ? 'Update when EPRA publishes new prices (the 14th of each month)' : 'Set by managers'}</p></div></span></div>
          <form class="card-body stack" id="settings" novalidate>
            <div class="form-grid">
              <div class="field"><label for="fp">Pump price (KES per litre)</label><input class="input" id="fp" name="fuelPrice" type="number" step="0.01" min="50" max="1000" value="${s.fuelPrice}" ${canEdit ? '' : 'disabled'}></div>
              <div class="field"><label for="ft">Fuel</label><select class="input" id="ft" name="fuelType" ${canEdit ? '' : 'disabled'}>
                <option value="petrol" ${s.fuelType === 'petrol' ? 'selected' : ''}>Super petrol</option><option value="diesel" ${s.fuelType === 'diesel' ? 'selected' : ''}>Diesel</option></select></div>
              <div class="field"><label for="fd">Price effective from</label><input class="input" id="fd" name="fuelPriceUpdatedAt" type="date" value="${s.fuelPriceUpdatedAt}" ${canEdit ? '' : 'disabled'}></div>
              <div class="field"><label for="fk">Motorcycle efficiency (km per litre)</label><input class="input" id="fk" name="kmPerLitre" type="number" step="0.5" min="5" max="120" value="${s.kmPerLitre}" ${canEdit ? '' : 'disabled'}></div>
              <div class="field"><label for="fr">Rider time (KES per hour)</label><input class="input" id="fr" name="timeRatePerHour" type="number" step="1" min="0" value="${s.timeRatePerHour}" ${canEdit ? '' : 'disabled'}></div>
              <div class="field"><label for="fb">Base fee per trip (KES)</label><input class="input" id="fb" name="baseFee" type="number" step="1" min="0" value="${s.baseFee}" ${canEdit ? '' : 'disabled'}></div>
              <div class="field"><label for="fo">Road factor</label><input class="input" id="fo" name="roadFactor" type="number" step="0.05" min="1" max="3" value="${s.roadFactor}" ${canEdit ? '' : 'disabled'}><span class="hint">Straight-line distance × this ≈ road distance</span></div>
            </div>
            <p class="error-text" id="serr" hidden></p>
            ${canEdit ? html`<div><button class="btn primary" type="submit" data-busy=" Saving…">${ic('check', 'sm')} Save pricing</button></div>` : ''}
            <p class="faint" style="font-size:12px">${s.isDefault ? 'Using built-in defaults: ' : ''}EPRA maximum pump price for Super Petrol in Nairobi was KES 226.96/L for 15 Oct – 14 Nov 2026. Check epra.go.ke for the current figure.</p>
          </form>
        </section>
      </div>

      <section class="card" style="margin-top:20px">
        <div class="card-head"><div><h2>Fuel by rider</h2><p>Distance from each rider's GPS track over the last ${days} days</p></div></div>
        ${report.riders.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Rider</th><th class="num">Shift hours</th><th class="num">GPS km</th><th class="num">Litres</th><th class="num">Fuel cost</th><th class="num">Deliveries</th><th class="num hide-sm">Quoted</th></tr></thead><tbody>
          ${report.riders.map((r) => html`<tr><td><b>${r.name}</b></td><td class="num">${r.shiftHours}</td><td class="num">${r.gpsKm}</td><td class="num">${r.litres}</td><td class="num">${kes(r.fuelCost)}</td><td class="num">${r.deliveries}</td><td class="num hide-sm">${kes(r.quoted)}</td></tr>`)}
        </tbody></table></div>` : empty('gpsOff', 'No rider activity yet', 'Distance appears here once riders go on shift and share their location.')}
      </section>

      <section class="card" style="margin-top:20px">
        <div class="card-head"><div><h2>Delivered trips</h2><p>Distance from GPS where the rider shared location, otherwise estimated from the route</p></div></div>
        ${report.trips.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Request</th><th class="hide-sm">Rider</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Fuel</th><th class="num">Quote</th><th class="hide-sm">Delivered</th></tr></thead><tbody>
          ${report.trips.map((x) => html`<tr>
            <td><a href="#/requests/${x.id}" class="mono">${x.ref}</a> <span class="muted">${x.title}</span></td><td class="hide-sm">${x.rider.name}</td>
            <td class="num nowrap">${x.km} km <span class="badge ${x.source === 'gps' ? 's-delivered' : 'b-outline'}" title="${SOURCE[x.source]}">${x.source === 'gps' ? 'GPS' : '≈'}</span></td>
            <td class="num nowrap">${x.minutes} min</td><td class="num nowrap">${x.litres} L · ${kes(x.fuelCost)}</td><td class="num nowrap"><b>${kes(x.total)}</b></td>
            <td class="hide-sm nowrap muted">${fmtDateTime(x.deliveredAt)}</td></tr>`)}
        </tbody></table></div>` : empty('package', 'No deliveries in this period', 'Delivered requests appear here with their fuel cost and quote.')}
      </section>`);
    wire();
  };

  function showQuote(q, source) {
    el.querySelector('#qout').innerHTML = String(html`${breakdown(q, report.settings)}<p class="faint" style="font-size:12px;margin-top:6px">Distance: ${SOURCE[source] || source}</p>`);
  }

  function wire() {
    el.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', async () => { days = +b.dataset.days; await load(); paint(); }));
    const calc = el.querySelector('#calc');
    const manual = () => showQuote(quote({ km: calc.km.value, minutes: calc.minutes.value }, report.settings), 'manual');
    calc.addEventListener('input', (e) => { if (['km', 'minutes'].includes(e.target.name)) manual(); });
    calc.addEventListener('change', (e) => {
      if (e.target.name !== 'mode') return;
      mode = calc.mode.value;
      calc.querySelectorAll('[data-mode]').forEach((x) => { x.hidden = x.dataset.mode !== mode; });
      if (mode === 'manual') manual(); else el.querySelector('#qout').innerHTML = '';
    });
    calc.addEventListener('submit', (e) => {
      e.preventDefault();
      if (mode !== 'places') return;
      const from = calc.from.value.trim(), to = calc.to.value.trim();
      if (!from || !to) { toast('Enter both places.', 'warn'); return; }
      busy(calc.querySelector('[type=submit]'), async () => {
        try {
          const places = await Promise.all([from, to].map(async (q) => {
            const r = await api.get(`/api/geocode?q=${encodeURIComponent(q)}`);
            if (!r.results.length) throw new Error(`“${q}” wasn't found in Kenya. Try a landmark, street or area.`);
            return r.results[0];
          }));
          const res = await api.post('/api/fuel/quote', { stops: places.map((p) => ({ lat: p.lat, lng: p.lng })), minutes: calc.minutes2.value ? +calc.minutes2.value : undefined });
          showQuote(res.quote, res.source);
          el.querySelector('#qout').insertAdjacentHTML('beforeend', String(html`<p class="faint" style="font-size:12px">${places[0].address} → ${places[1].address}</p>`));
        } catch (err) { toast(err.message, 'err'); }
      });
    });
    if (mode === 'manual') manual();

    const form = el.querySelector('#settings');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('#serr');
      err.hidden = true;
      busy(form.querySelector('[type=submit]'), async () => {
        try {
          const body = Object.fromEntries(['fuelPrice', 'kmPerLitre', 'timeRatePerHour', 'baseFee', 'roadFactor'].map((k) => [k, Number(form[k].value)]));
          body.fuelType = form.fuelType.value;
          body.fuelPriceUpdatedAt = form.fuelPriceUpdatedAt.value || undefined;
          await api.patch('/api/fuel/settings', body);
          toast('Pricing saved');
          await load(); paint();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    });
  }
  paint();
}
