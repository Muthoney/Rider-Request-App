// Fuel & energy tracker and delivery quote calculator, for petrol and electric motorcycles.
import { api } from '../api.js';
import { html, ic, toast, busy, fmtDateTime, empty, canWrite, readOnlyChip, vehicleBadge, exportBtn } from '../ui.js';
import { quote, kes, VEHICLE_LABEL } from '../fuel.js';
import { downloadXlsx, stamp } from '../xlsx.js';

/** EPRA publishes new maximum pump prices on the 14th of each month (effective the 15th). */
export function nextReview(updatedAt) {
  const d = new Date(`${updatedAt}T00:00:00+03:00`);
  const r = new Date(d); r.setDate(15);
  if (d.getDate() >= 15) r.setMonth(r.getMonth() + 1);
  return r;
}
export const priceIsStale = (updatedAt) => Date.now() >= +nextReview(updatedAt);

const SOURCE = { gps: 'GPS track', estimate: 'Estimated', google: 'Google route', manual: 'Entered' };
const fmtNum = (n, dp = 1) => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: dp });

export function breakdown(q, settings) {
  const electric = q.vehicle === 'electric';
  const unit = q.unit || (electric ? 'kWh' : 'L');
  const eff = q.efficiency ?? (electric ? settings.kmPerKwh : settings.kmPerLitre);
  const price = q.unitPrice ?? (electric ? settings.electricityPrice : settings.fuelPrice);
  const amount = q.energy ?? q.litres;
  return html`<div class="quote">
    <div><span>Base fee</span><b>${kes(q.baseFee)}</b></div>
    <div><span>${electric ? html`${ic('zap', 'sm')} Electricity` : 'Fuel'} · ${q.km} km ÷ ${eff} km/${unit} = ${amount} ${unit} × ${kes(price)}</span><b>${kes(q.fuelCost)}</b></div>
    <div><span>Rider time · ${q.minutes} min × ${kes(settings.timeRatePerHour)}/h</span><b>${kes(q.timeCost)}</b></div>
    <div class="total"><span>Quote <small>(rounded up to KES 10)</small></span><b>${kes(q.total)}</b></div>
  </div>`;
}

/** One line comparing the other vehicle type for the same trip. */
function comparison(q, other) {
  if (!other) return '';
  const diff = other.fuelCost - q.fuelCost;
  const label = other.vehicle === 'electric' ? 'an electric motorcycle' : 'a petrol motorcycle';
  return html`<p class="compare ${diff < 0 ? 'cheaper' : ''}">${ic(other.vehicle === 'electric' ? 'zap' : 'fuel', 'sm')}
    On ${label}: energy ${kes(other.fuelCost)} · quote ${kes(other.total)}${diff < 0 ? html` · <b>saves ${kes(-diff)}</b>` : diff > 0 ? ` · costs ${kes(diff)} more` : ''}</p>`;
}

export async function render(el, ctx) {
  const canEdit = canWrite(ctx.user);
  let days = 7;
  let report;
  let mode = 'manual';
  let vehicle = null;
  const load = async () => { report = await api.get(`/api/fuel/report?days=${days}`); vehicle ??= report.settings.defaultVehicle || 'petrol'; };
  await load();

  const paint = () => {
    const s = report.settings;
    const stale = priceIsStale(s.fuelPriceUpdatedAt);
    const t = report.totals;
    const evRiders = report.riders.filter((r) => r.vehicle === 'electric').length;
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>Fuel &amp; quotes</h1><p>Energy use from riders' GPS tracks, for petrol and electric motorcycles, trip costs, and a quote calculator.</p></div>
        <div class="row wrap">
          ${canEdit ? '' : readOnlyChip()}
          <div class="seg" role="group" aria-label="Period">${[7, 30, 90].map((d) => html`<button data-days="${d}" class="${days === d ? 'on' : ''}">${d} days</button>`)}</div>
        </div>
      </div>
      ${stale ? html`<div class="alert warn" style="margin-bottom:16px">${ic('alert', 'sm')}<span>EPRA has published new pump prices since ${new Date(s.fuelPriceUpdatedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}. ${canEdit ? 'Update the fuel price below so quotes stay accurate.' : 'Ask a dispatcher or administrator to update the fuel price.'}</span></div>` : ''}
      <div class="stats">
        <div class="card stat hero"><div class="k"><span class="dot">${ic('fuel', 'sm')}</span>${s.fuelType === 'diesel' ? 'Diesel' : 'Super petrol'} · Nairobi</div><div class="v">${s.fuelPrice}<small>KES/L</small></div>
          <div class="s">${ic('zap', 'sm')} Electricity KES ${s.electricityPrice}/kWh · next EPRA review ${nextReview(s.fuelPriceUpdatedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</div></div>
        <div class="card stat"><div class="k"><span class="dot s-assigned">${ic('gps', 'sm')}</span>Distance (GPS)</div><div class="v">${t.gpsKm.toFixed(1)}<small>km</small></div><div class="s">Last ${days} days</div></div>
        <div class="card stat"><div class="k"><span class="dot s-collected">${ic('fuel', 'sm')}</span>Energy used</div><div class="v">${fmtNum(t.litres)}<small>L</small></div>
          <div class="s">${ic('zap', 'sm')} ${fmtNum(t.kwh)} kWh electric${evRiders ? ` · ${evRiders} EV rider${evRiders === 1 ? '' : 's'}` : ''}</div></div>
        <div class="card stat"><div class="k"><span class="dot s-pending">${ic('coins', 'sm')}</span>Energy cost</div><div class="v">${Math.round(t.fuelCost).toLocaleString('en-KE')}<small>KES</small></div>
          <div class="s">Petrol ${kes(t.petrolCost)} · Electric ${kes(t.electricCost)}</div></div>
        <div class="card stat"><div class="k"><span class="dot s-delivered">${ic('checkCircle', 'sm')}</span>Quoted deliveries</div><div class="v">${Math.round(t.quoted).toLocaleString('en-KE')}<small>KES</small></div><div class="s">${t.deliveries} delivered</div></div>
      </div>

      <div class="grid g-2" style="align-items:start">
        <section class="card">
          <div class="card-head"><span class="section-title"><span class="si">${ic('calc', 'sm')}</span><div><h2>Quote calculator</h2><p>Base fee + energy + rider time</p></div></span></div>
          <form class="card-body stack" id="calc" novalidate>
            <div class="seg vehicle-seg" role="radiogroup" aria-label="Motorcycle">
              <label><input type="radio" name="vehicle" value="petrol" ${vehicle === 'petrol' ? 'checked' : ''}>${ic('fuel', 'sm')} Petrol</label>
              <label><input type="radio" name="vehicle" value="electric" ${vehicle === 'electric' ? 'checked' : ''}>${ic('zap', 'sm')} Electric</label>
            </div>
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
          <div class="card-head"><span class="section-title"><span class="si">${ic('fuel', 'sm')}</span><div><h2>Pricing</h2><p>${canEdit ? 'Update the pump price when EPRA publishes new prices (the 14th of each month)' : 'Set by dispatchers and administrators'}</p></div></span></div>
          <form class="card-body stack" id="settings" novalidate>
            <fieldset class="price-group"><legend>${ic('fuel', 'sm')} Petrol motorcycles</legend>
              <div class="form-grid">
                <div class="field"><label for="fp">Pump price (KES per litre)</label><input class="input" id="fp" name="fuelPrice" type="number" step="0.01" min="50" max="1000" value="${s.fuelPrice}" ${canEdit ? '' : 'disabled'}></div>
                <div class="field"><label for="ft">Fuel</label><select class="input" id="ft" name="fuelType" ${canEdit ? '' : 'disabled'}>
                  <option value="petrol" ${s.fuelType === 'petrol' ? 'selected' : ''}>Super petrol</option><option value="diesel" ${s.fuelType === 'diesel' ? 'selected' : ''}>Diesel</option></select></div>
                <div class="field"><label for="fd">Price effective from</label><input class="input" id="fd" name="fuelPriceUpdatedAt" type="date" value="${s.fuelPriceUpdatedAt}" ${canEdit ? '' : 'disabled'}></div>
                <div class="field"><label for="fk">Efficiency (km per litre)</label><input class="input" id="fk" name="kmPerLitre" type="number" step="0.5" min="5" max="120" value="${s.kmPerLitre}" ${canEdit ? '' : 'disabled'}></div>
              </div>
            </fieldset>
            <fieldset class="price-group ev"><legend>${ic('zap', 'sm')} Electric motorcycles</legend>
              <div class="form-grid">
                <div class="field"><label for="fe">Electricity (KES per kWh)</label><input class="input" id="fe" name="electricityPrice" type="number" step="0.1" min="1" max="500" value="${s.electricityPrice}" ${canEdit ? '' : 'disabled'}>
                  <span class="hint">Your charging tariff, or for battery swaps: swap price ÷ battery kWh</span></div>
                <div class="field"><label for="fkw">Efficiency (km per kWh)</label><input class="input" id="fkw" name="kmPerKwh" type="number" step="0.5" min="5" max="200" value="${s.kmPerKwh}" ${canEdit ? '' : 'disabled'}>
                  <span class="hint">Range on a full battery ÷ battery size</span></div>
              </div>
            </fieldset>
            <div class="form-grid">
              <div class="field"><label for="fv">Quotes assume</label><select class="input" id="fv" name="defaultVehicle" ${canEdit ? '' : 'disabled'}>
                ${Object.entries(VEHICLE_LABEL).map(([k, l]) => html`<option value="${k}" ${s.defaultVehicle === k ? 'selected' : ''}>${l}</option>`)}</select>
                <span class="hint">Until a rider is assigned; then the rider's own vehicle is used</span></div>
              <div class="field"><label for="fr">Rider time (KES per hour)</label><input class="input" id="fr" name="timeRatePerHour" type="number" step="1" min="0" value="${s.timeRatePerHour}" ${canEdit ? '' : 'disabled'}></div>
              <div class="field"><label for="fb">Base fee per trip (KES)</label><input class="input" id="fb" name="baseFee" type="number" step="1" min="0" value="${s.baseFee}" ${canEdit ? '' : 'disabled'}></div>
              <div class="field"><label for="fo">Road factor</label><input class="input" id="fo" name="roadFactor" type="number" step="0.05" min="1" max="3" value="${s.roadFactor}" ${canEdit ? '' : 'disabled'}><span class="hint">Straight-line distance × this ≈ road distance</span></div>
            </div>
            <p class="error-text" id="serr" hidden></p>
            ${canEdit ? html`<div><button class="btn primary" type="submit" data-busy=" Saving…">${ic('check', 'sm')} Save pricing</button></div>` : ''}
            <p class="faint" style="font-size:12px">${s.isDefault ? 'Using built-in defaults: ' : ''}EPRA maximum pump price for Super Petrol in Nairobi was KES 226.96/L for 15 Oct – 14 Nov 2026. Check epra.go.ke for the current figure. The electricity default is a placeholder: set your own tariff. Each rider's vehicle is set under Manage accounts.</p>
          </form>
        </section>
      </div>

      <section class="card" style="margin-top:20px">
        <div class="card-head"><div><h2>Energy by rider</h2><p>Distance from each rider's GPS track over the last ${days} days, costed for their vehicle</p></div>${report.riders.length ? exportBtn('data-export-riders') : ''}</div>
        ${report.riders.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Rider</th><th class="hide-sm">Vehicle</th><th class="num">Shift hours</th><th class="num">GPS km</th><th class="num">Energy</th><th class="num">Cost</th><th class="num">Deliveries</th><th class="num hide-sm">Quoted</th></tr></thead><tbody>
          ${report.riders.map((r) => html`<tr><td><b>${r.name}</b></td><td class="hide-sm">${r.vehicle === 'electric' ? vehicleBadge('electric') : html`<span class="badge b-outline">${ic('fuel')}Petrol</span>`}</td>
            <td class="num">${r.shiftHours}</td><td class="num">${r.gpsKm}</td><td class="num nowrap">${r.energy} ${r.unit}</td><td class="num">${kes(r.fuelCost)}</td><td class="num">${r.deliveries}</td><td class="num hide-sm">${kes(r.quoted)}</td></tr>`)}
        </tbody></table></div>` : empty('gpsOff', 'No rider activity yet', 'Distance appears here once riders go on shift and share their location.')}
      </section>

      <section class="card" style="margin-top:20px">
        <div class="card-head"><div><h2>Delivered trips</h2><p>Distance from GPS where the rider shared location, otherwise estimated from the route</p></div>${report.trips.length ? exportBtn('data-export-trips') : ''}</div>
        ${report.trips.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Request</th><th class="hide-sm">Rider</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Energy</th><th class="num">Quote</th><th class="hide-sm">Delivered</th></tr></thead><tbody>
          ${report.trips.map((x) => html`<tr>
            <td><a href="#/requests/${x.id}" class="mono">${x.ref}</a> <span class="muted">${x.title}</span></td><td class="hide-sm">${x.rider.name} ${vehicleBadge(x.vehicle)}</td>
            <td class="num nowrap">${x.km} km <span class="badge ${x.source === 'gps' ? 's-delivered' : 'b-outline'}" title="${SOURCE[x.source]}">${x.source === 'gps' ? 'GPS' : '≈'}</span></td>
            <td class="num nowrap">${x.minutes} min</td><td class="num nowrap">${x.energy ?? x.litres} ${x.unit || 'L'} · ${kes(x.fuelCost)}</td><td class="num nowrap"><b>${kes(x.total)}</b></td>
            <td class="hide-sm nowrap muted">${fmtDateTime(x.deliveredAt)}</td></tr>`)}
        </tbody></table></div>` : empty('package', 'No deliveries in this period', 'Delivered requests appear here with their energy cost and quote.')}
      </section>`);
    wire();
  };

  function showQuote(q, source, other) {
    el.querySelector('#qout').innerHTML = String(html`${breakdown(q, report.settings)}${comparison(q, other)}<p class="faint" style="font-size:12px;margin-top:6px">Distance: ${SOURCE[source] || source}</p>`);
  }

  function wire() {
    el.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', async () => { days = +b.dataset.days; await load(); paint(); }));
    const calc = el.querySelector('#calc');
    const manual = () => {
      const args = { km: calc.km.value, minutes: calc.minutes.value };
      showQuote(quote({ ...args, vehicle }, report.settings), 'manual', quote({ ...args, vehicle: vehicle === 'electric' ? 'petrol' : 'electric' }, report.settings));
    };
    calc.addEventListener('input', (e) => { if (['km', 'minutes'].includes(e.target.name)) manual(); });
    calc.addEventListener('change', (e) => {
      if (e.target.name === 'vehicle') { vehicle = calc.vehicle.value; if (mode === 'manual') manual(); else el.querySelector('#qout').innerHTML = ''; return; }
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
          const res = await api.post('/api/fuel/quote', { vehicle, stops: places.map((p) => ({ lat: p.lat, lng: p.lng })), minutes: calc.minutes2.value ? +calc.minutes2.value : undefined });
          showQuote(res.quote, res.source, res.compare);
          el.querySelector('#qout').insertAdjacentHTML('beforeend', String(html`<p class="faint" style="font-size:12px">${places[0].address} → ${places[1].address}</p>`));
        } catch (err) { toast(err.message, 'err'); }
      });
    });
    if (mode === 'manual') manual();

    el.querySelector('[data-export-riders]')?.addEventListener('click', () => {
      downloadXlsx(stamp(`energy-by-rider-${days}d`), {
        sheet: 'Energy by rider',
        columns: [
          { header: 'Rider', width: 22, value: (r) => r.name },
          { header: 'Vehicle', width: 12, value: (r) => (r.vehicle === 'electric' ? 'Electric' : 'Petrol') },
          { header: 'Shift hours', width: 11, value: (r) => r.shiftHours },
          { header: 'GPS km', width: 10, value: (r) => r.gpsKm },
          { header: 'Energy', width: 10, value: (r) => r.energy },
          { header: 'Unit', width: 6, value: (r) => r.unit },
          { header: 'Energy cost (KES)', width: 16, value: (r) => r.fuelCost },
          { header: 'Deliveries', width: 10, value: (r) => r.deliveries },
          { header: 'Quoted (KES)', width: 13, value: (r) => r.quoted },
        ],
        rows: report.riders,
      });
      toast('Exported energy by rider to Excel');
    });
    el.querySelector('[data-export-trips]')?.addEventListener('click', () => {
      downloadXlsx(stamp(`delivered-trips-${days}d`), {
        sheet: 'Delivered trips',
        columns: [
          { header: 'Ref', width: 10, value: (x) => x.ref },
          { header: 'Description', width: 34, value: (x) => x.title },
          { header: 'Rider', width: 20, value: (x) => x.rider.name },
          { header: 'Vehicle', width: 10, value: (x) => (x.vehicle === 'electric' ? 'Electric' : 'Petrol') },
          { header: 'Distance (km)', width: 13, value: (x) => x.km },
          { header: 'Distance source', width: 15, value: (x) => SOURCE[x.source] || x.source },
          { header: 'Minutes', width: 9, value: (x) => x.minutes },
          { header: 'Energy', width: 9, value: (x) => x.energy ?? x.litres },
          { header: 'Unit', width: 6, value: (x) => x.unit || 'L' },
          { header: 'Energy cost (KES)', width: 16, value: (x) => x.fuelCost },
          { header: 'Quote (KES)', width: 12, value: (x) => x.total },
          { header: 'Delivered', width: 18, value: (x) => new Date(x.deliveredAt) },
        ],
        rows: report.trips,
      });
      toast(`Exported ${report.trips.length} trip${report.trips.length === 1 ? '' : 's'} to Excel`);
    });

    const form = el.querySelector('#settings');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = form.querySelector('#serr');
      err.hidden = true;
      busy(form.querySelector('[type=submit]'), async () => {
        try {
          const body = Object.fromEntries(['fuelPrice', 'kmPerLitre', 'electricityPrice', 'kmPerKwh', 'timeRatePerHour', 'baseFee', 'roadFactor'].map((k) => [k, Number(form[k].value)]));
          body.fuelType = form.fuelType.value;
          body.defaultVehicle = form.defaultVehicle.value;
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
