// Structured location details for pickups and drop-offs (beyond the address and map pin):
// building, building/plot number, floor, apartment/office/suite, gate or entrance, landmark, directions.
import { html, ic } from './ui.js';

export const DETAIL_FIELDS = [
  { k: 'building', label: 'Building', ph: 'e.g. Example Towers' },
  { k: 'buildingNo', label: 'Building / plot no.', ph: 'e.g. 14 or LR 209/123', short: true },
  { k: 'floor', label: 'Floor', ph: 'e.g. 4th', list: 'rr-floors', short: true },
  { k: 'unit', label: 'Apartment / office / suite', ph: 'e.g. Suite 402', short: true },
  { k: 'gate', label: 'Gate or entrance', ph: 'e.g. Main reception', list: 'rr-gates' },
  { k: 'landmark', label: 'Nearby landmark', ph: 'e.g. Opposite the main shopping centre' },
];
const FLOORS = ['Ground floor', 'Mezzanine', '1st floor', '2nd floor', '3rd floor', '4th floor', '5th floor', '6th floor', '7th floor', '8th floor', '9th floor', '10th floor', 'Basement', 'Rooftop'];
const GATES = ['Main gate', 'Main reception', 'Security desk', 'Back gate', 'Side entrance', 'Loading bay', 'Parking entrance'];

/** Datalists used by the detail inputs (render once per page). */
export const detailLists = () => html`
  <datalist id="rr-floors">${FLOORS.map((f) => html`<option value="${f}"></option>`)}</datalist>
  <datalist id="rr-gates">${GATES.map((g) => html`<option value="${g}"></option>`)}</datalist>`;

const clean = (d) => (d && Object.values(d).some(Boolean) ? d : null);

/** "Example Towers (14) · 4th floor · Suite 402 · Main reception · near Opposite…" */
export function detailsText(d) {
  d = clean(d);
  if (!d) return '';
  return [
    d.building ? `${d.building}${d.buildingNo ? ` (${d.buildingNo})` : ''}` : d.buildingNo ? `No. ${d.buildingNo}` : '',
    d.floor, d.unit, d.gate ? `Entrance: ${d.gate}` : '', d.landmark ? `Landmark: ${d.landmark}` : '', d.directions,
  ].filter(Boolean).join(' · ');
}

/** Detail chips for the rider and dispatcher. */
export function detailsBlock(d) {
  d = clean(d);
  if (!d) return '';
  const item = (icon, label, v) => (v ? html`<span class="det"><span class="det-k">${ic(icon, 'sm')}${label}</span><b>${v}</b></span>` : '');
  return html`<div class="details">
    ${item('home', 'Building', [d.building, d.buildingNo && `No. ${d.buildingNo}`].filter(Boolean).join(', '))}
    ${item('arrowUp', 'Floor', d.floor)}${item('doc', 'Unit', d.unit)}${item('shield', 'Entrance', d.gate)}
    ${item('pin', 'Landmark', d.landmark)}${item('route', 'Directions', d.directions)}
  </div>`;
}

/** Collapsible detail inputs. `prefix` makes ids unique; inputs carry data-det="<key>". */
export function detailsFields(prefix, d = {}, { directions = true } = {}) {
  const v = d || {};
  const filled = !!clean(v);
  const fields = directions ? [...DETAIL_FIELDS, { k: 'directions', label: 'Directions for the rider', ph: 'e.g. Take the lift to 4, turn left' }] : DETAIL_FIELDS;
  return html`<details class="more" data-details ${filled ? 'open' : ''}>
    <summary>${ic('home', 'sm')} Building, floor, unit, gate &amp; landmark <span class="muted" data-det-sum>${filled ? detailsText(v) : '(optional, helps the rider find the exact spot)'}</span></summary>
    <div class="form-grid det-grid">${fields.map((f) => html`
      <div class="field ${f.short ? '' : 'full-sm'}"><label for="${prefix}-${f.k}">${f.label}</label>
        <input class="input" id="${prefix}-${f.k}" data-det="${f.k}" maxlength="${f.k === 'directions' ? 300 : 80}" value="${v[f.k] || ''}" placeholder="${f.ph}" ${f.list ? html`list="${f.list}"` : ''} autocomplete="off"></div>`)}
    </div>
  </details>`;
}

/** Reads the detail inputs inside `box` into an object (or null). */
export function readDetails(box) {
  const out = {};
  box?.querySelectorAll('[data-det]').forEach((i) => { const s = i.value.trim(); if (s) out[i.dataset.det] = s; });
  return Object.keys(out).length ? out : null;
}
