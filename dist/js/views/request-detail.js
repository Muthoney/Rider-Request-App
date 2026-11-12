import { api } from '../api.js';
import {
  html, ic, raw, statusBadge, categoryBadge, urgentBadge, avatar, timeAgo, fmtDateTime, fmtTime, HANDLING, CATEGORY,
  openModal, toast, busy, telHref, mapsHref, canWrite, readOnlyChip, isUpcoming, exportBtn, vehicleBadge,
} from '../ui.js';
import { photoField, wirePhoto, signatureField, wireSignature } from '../capture.js';
import { mountRouteMap, requestPoints } from '../map.js';
import { breakdown } from './fuel.js';
import { kes } from '../fuel.js';
import { activityIcon, exportActivity } from './activity.js';
import { assign, pickRiderDialog, handleError, acceptJob } from './actions.js';
import { currentPosition } from '../native.js';
import { lastPosition } from '../tracker.js';
import { pendingFor } from '../offline.js';
import { detailsBlock, detailsText, detailsFields, readDetails, detailLists } from '../stops.js';

const STAFF = ['admin', 'manager', 'dispatcher'];
const GPS_LABEL = { verified: 'At the stop', distant: 'Away from the pin', captured: 'GPS recorded', outside_kenya: 'Outside Kenya' };

/** A quick GPS fix for a proof record: fresh if possible, else the tracker's last position (≤ 2 min old). */
async function gpsFix() {
  const fresh = await Promise.race([currentPosition({ timeout: 6000 }), new Promise((r) => setTimeout(() => r(null), 6500))]);
  if (fresh) return fresh;
  const l = lastPosition();
  return l && Date.now() - new Date(l.recordedAt) < 120e3 ? l : null;
}

/**
 * Applies actions still waiting to sync to a request, so the rider sees their own offline progress.
 * Stops changed this way carry `pendingSync: true`.
 */
export function applyPending(r, pending = []) {
  if (!pending.length) return r;
  const out = { ...r, pickups: pickupsOf(r).map((p) => ({ ...p })), dropoffs: r.dropoffs.map((d) => ({ ...d })), pendingSync: pending.length };
  for (const e of pending) {
    const op = e.op || {};
    if (op.kind === 'collect') {
      const p = out.pickups.find((x) => x.seq === op.seq);
      if (p) { p.collected = true; p.pendingSync = true; p.collectedAt = new Date(e.createdAt).toISOString(); }
    }
    if (op.kind === 'handover') {
      const d = out.dropoffs.find((x) => x.id === op.dropoffId);
      if (d) { d.status = op.outcome; d.pendingSync = true; d.handledAt = new Date(e.createdAt).toISOString(); }
    }
  }
  if (out.status === 'assigned' && out.pickups.every((p) => p.collected)) out.status = 'collected';
  if (out.status === 'collected' && out.dropoffs.every((d) => d.status === 'delivered')) out.status = 'delivered';
  return out;
}

/** Confirms an address change (rider). Works offline. */
export async function ackChange(r, change) {
  const res = await api.act('POST', `/api/requests/${r.id}/location-changes/${change.id}/ack`, {}, { label: `${r.ref}: confirm new address`, requestId: r.id });
  toast(res.queued ? 'Confirmed on this phone; will sync when online.' : 'New address confirmed.');
  return true;
}

/** Sends a collection/handover, queuing it offline. Handles an unconfirmed address change. */
async function sendProof(r, url, body, meta, done) {
  try {
    const res = await api.act('POST', url, body, { ...meta, requestId: r.id, versioned: true });
    if (res.queued) { toast('No connection: saved on this phone with its photo, GPS and time. It will sync automatically.', 'warn'); return { queued: true }; }
    done(res.data);
    return res.data.request;
  } catch (err) {
    if (err.code === 'ack_required') {
      toast('The address for this stop changed. Check and confirm the new address first.', 'warn');
      return { needsAck: err.data?.changeId };
    }
    return handleError(err);
  }
}

/** All pickups (older payloads only have `pickup`). */
export const pickupsOf = (r) => r.pickups || [{ ...r.pickup, seq: 1, collected: !!r.collectedAt }];
/** The next pickup still to collect. */
export const nextPickup = (r) => pickupsOf(r).find((p) => !p.collected);

export function collectDialog(r, p = nextPickup(r) || r.pickup) {
  const total = pickupsOf(r).length;
  return openModal({
    title: total > 1 ? `Record collection · pickup ${p.seq} of ${total}` : 'Record collection', subtitle: `${r.ref} · ${p.address}`, iconName: 'package',
    body: html`
      <div class="field"><label for="cf">Collected from</label><input class="input" id="cf" name="collectedFrom" required value="${p.contactName || ''}" placeholder="Name of the person who handed over" autofocus></div>
      <div class="field"><label for="ci">Number of items <span class="muted">(optional)</span></label><input class="input" id="ci" name="itemCount" type="number" min="1" max="999" inputmode="numeric"></div>
      ${photoField({ label: 'Photo of the items at pickup', required: false, hint: 'Optional — useful for valuables or damaged packaging' })}
      <div class="field"><label for="cdn">D-note number <span class="muted">(optional)</span></label><input class="input" id="cdn" name="dnoteRef" maxlength="60" placeholder="e.g. DN-20431"></div>
      ${signatureField({ label: 'Sender signs the D-note', hint: 'The person handing over signs to confirm what was collected.' })}
      <div class="field"><label for="cn">Note</label><textarea class="input" id="cn" name="note" maxlength="500" placeholder="Condition of items, seals, anything unusual"></textarea></div>
      ${r.handling.length ? html`<div class="chips">${r.handling.map((h) => html`<span class="badge">${ic(HANDLING[h].icon)}${HANDLING[h].label}</span>`)}</div>` : ''}
      <p class="error-text" id="c-err" hidden></p>
      <div class="gps-line">${ic('gps', 'sm')} Your GPS position and the time are attached automatically.</div>`,
    actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('check', 'sm')} Confirm collection</button>`,
    onMount: ({ form, close }) => {
      const photo = wirePhoto(form);
      const sign = wireSignature(form);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const err = form.querySelector('#c-err');
        err.hidden = true;
        if (!form.collectedFrom.value.trim()) { form.collectedFrom.setAttribute('aria-invalid', 'true'); form.collectedFrom.focus(); return; }
        close({
          collectedFrom: form.collectedFrom.value.trim(), itemCount: form.itemCount.value ? Number(form.itemCount.value) : null, note: form.note.value.trim() || null,
          photo: photo.value, signature: sign.empty ? null : sign.dataUrl(), dnoteRef: form.dnoteRef.value.trim() || null,
        });
      });
    },
  });
}

export function handoverDialog(r, d) {
  return openModal({
    title: `Hand over drop-off ${d.seq}`, subtitle: d.address, iconName: 'hand',
    body: html`
      <div class="seg" role="radiogroup" aria-label="Outcome">
        <label><input type="radio" name="outcome" value="delivered" checked>${ic('checkCircle', 'sm')} Delivered</label>
        <label><input type="radio" name="outcome" value="failed">${ic('alert', 'sm')} Couldn't deliver</label>
      </div>
      <div class="field" data-when="delivered"><label for="rb">Received by</label><input class="input" id="rb" name="receivedBy" value="${d.contactName || ''}" placeholder="Full name of the recipient" autofocus></div>
      <div data-photo-slot>${photoField({ label: 'Photo of the delivery', required: true, hint: 'Show the items with the recipient or at the door' })}</div>
      <div class="field" data-when="delivered"><label for="hdn">D-note number <span class="muted">(optional)</span></label><input class="input" id="hdn" name="dnoteRef" maxlength="60" placeholder="e.g. DN-20431"></div>
      <div data-when="delivered">${signatureField({ label: 'Recipient signs the D-note', required: true, hint: 'Hand the phone to the recipient to sign for the delivery.' })}</div>
      <div class="field"><label for="hn" data-label>Note <span class="muted">(optional)</span></label><textarea class="input" id="hn" name="note" maxlength="500" placeholder="e.g. Signed at reception"></textarea></div>
      ${r.handling.includes('cash') ? html`<div class="alert warn">${ic('coins', 'sm')}<span>Count the cash with the recipient before handing over.</span></div>` : ''}
      <div class="gps-line">${ic('gps', 'sm')} Your GPS position is attached and checked against the drop-off pin.</div>
      <p class="error-text" id="h-err" hidden></p>`,
    actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('check', 'sm')} Record handover</button>`,
    onMount: ({ form, close }) => {
      const photo = wirePhoto(form);
      const sign = wireSignature(form);
      const photoReq = form.querySelector('[data-photo-slot] .req');
      const sync = () => {
        const failed = form.outcome.value === 'failed';
        form.querySelectorAll('[data-when=delivered]').forEach((x) => { x.hidden = failed; });
        if (photoReq) { photoReq.textContent = failed ? 'Optional' : 'Required'; photoReq.classList.toggle('opt', failed); }
        form.querySelector('[data-label]').innerHTML = failed ? 'What happened? <span class="error-text">*</span>' : 'Note <span class="muted">(optional)</span>';
        form.note.placeholder = failed ? 'e.g. Office closed, recipient unreachable' : 'e.g. Signed at reception';
        if (!failed) window.dispatchEvent(new Event('resize'));
      };
      form.addEventListener('change', (e) => { if (e.target.name === 'outcome') sync(); });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const outcome = form.outcome.value;
        const err = form.querySelector('#h-err');
        err.hidden = true;
        if (outcome === 'delivered' && !form.receivedBy.value.trim()) { err.textContent = 'Enter who received the items.'; err.hidden = false; return; }
        if (outcome === 'delivered' && !photo.value) { err.textContent = 'Take a photo of the delivery.'; err.hidden = false; photo.flag(); return; }
        if (outcome === 'delivered' && sign.empty) { err.textContent = 'Ask the recipient to sign the D-note.'; err.hidden = false; sign.flag(); return; }
        if (outcome === 'failed' && !form.note.value.trim()) { err.textContent = 'Describe what happened.'; err.hidden = false; return; }
        const delivered = outcome === 'delivered';
        close({
          outcome, receivedBy: form.receivedBy.value.trim() || null, note: form.note.value.trim() || null, photo: photo.value || null,
          signature: delivered ? sign.dataUrl() : null, dnoteRef: delivered ? form.dnoteRef.value.trim() || null : null,
        });
      });
    },
  });
}

export async function recordCollection(r, p = nextPickup(r)) {
  const data = await collectDialog(r, p);
  if (!data) return null;
  const gps = await gpsFix();
  const total = pickupsOf(r).length;
  return sendProof(r, `/api/requests/${r.id}/collect`, { version: r.version, ...data, pickupSeq: p?.seq, gps },
    { label: `${r.ref}: collection${total > 1 ? ` (pickup ${p.seq})` : ''}`, op: { kind: 'collect', seq: p?.seq ?? 1 } },
    (res) => toast(res.remainingPickups ? `Pickup ${p.seq} collected · ${res.remainingPickups} more to go` : `Collection recorded for ${r.ref}`));
}
export async function recordHandover(r, d) {
  const data = await handoverDialog(r, d);
  if (!data) return null;
  const gps = await gpsFix();
  return sendProof(r, `/api/requests/${r.id}/dropoffs/${d.id}/handover`, { version: r.version, ...data, gps },
    { label: `${r.ref}: ${data.outcome === 'failed' ? 'failed' : ''} drop-off ${d.seq}`.replace(':  ', ': '), op: { kind: 'handover', dropoffId: d.id, outcome: data.outcome } },
    (res) => toast(res.request.status === 'delivered' ? `${r.ref} fully delivered 🎉` : data.outcome === 'failed' ? `Drop-off ${d.seq} marked as not delivered` : `Drop-off ${d.seq} handed over`, data.outcome === 'failed' ? 'warn' : 'ok'));
}

/** Requester / dispatch changes one stop's address while the delivery is under way. */
export function changeStopDialog(r, kind, stop) {
  const label = kind === 'pickup' ? (pickupsOf(r).length > 1 ? `pickup ${stop.seq}` : 'pickup') : `drop-off ${stop.seq}`;
  return openModal({
    title: `Change the ${label} address`, subtitle: r.rider ? `${r.rider.name} is told at once and asked to confirm.` : 'The change is recorded in the history.', iconName: 'pin',
    body: html`${detailLists()}
      <div class="alert info">${ic('pin', 'sm')}<span>Current: <b>${stop.address}</b>${detailsText(stop.details) ? html`<br><span class="muted">${detailsText(stop.details)}</span>` : ''}</span></div>
      <div class="field"><label for="cs-a">New address</label><input class="input" id="cs-a" name="address" required maxlength="300" value="${stop.address}" autofocus></div>
      <div class="field"><label for="cs-pin">Map pin <span class="muted">(optional)</span></label><input class="input" id="cs-pin" name="pin" placeholder="Paste a Google Maps link or “-1.28, 36.82”" value="${stop.lat != null ? `${stop.lat}, ${stop.lng}` : ''}">
        <span class="hint" data-pin-hint>Without a pin, the map uses the landmark or street named in the address.</span></div>
      <div class="form-grid">
        <div class="field"><label for="cs-cn">${kind === 'pickup' ? 'Contact' : 'Recipient'}</label><input class="input" id="cs-cn" name="contactName" maxlength="120" value="${stop.contactName || ''}"></div>
        <div class="field"><label for="cs-cp">Phone</label><input class="input" id="cs-cp" name="contactPhone" type="tel" maxlength="40" value="${stop.contactPhone || ''}"></div>
      </div>
      ${detailsFields('cs', stop.details, { directions: kind === 'pickup' })}
      ${kind === 'dropoff' ? html`<div class="field"><label for="cs-ins">Instructions</label><input class="input" id="cs-ins" name="instructions" maxlength="500" value="${stop.instructions || ''}"></div>` : ''}
      <div class="field"><label for="cs-r">Reason <span class="muted">(optional)</span></label><input class="input" id="cs-r" name="reason" maxlength="300" placeholder="e.g. Recipient moved to the Westlands office"></div>
      <p class="error-text" id="cs-err" hidden></p>`,
    actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('check', 'sm')} Save &amp; notify</button>`,
    onMount: ({ form, close }) => form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('#cs-err');
      const address = form.address.value.trim();
      if (!address) { err.textContent = 'Enter the new address.'; err.hidden = false; return; }
      const { parsePin } = await import('../whatsapp.js');
      const pinText = form.pin.value.trim();
      const pin = pinText ? parsePin(pinText) : null;
      if (pinText && pin?.lat == null) { err.textContent = 'No coordinates found in the pin. Paste a full Google Maps link or “lat, lng”.'; err.hidden = false; return; }
      close({
        kind, seq: stop.seq, address, lat: pin?.lat ?? null, lng: pin?.lng ?? null, details: readDetails(form),
        contactName: form.contactName.value.trim() || null, contactPhone: form.contactPhone.value.trim() || null,
        ...(kind === 'dropoff' ? { instructions: form.instructions.value.trim() || null } : {}), reason: form.reason.value.trim() || null,
      });
    }),
  });
}

const STARS = [1, 2, 3, 4, 5];
const starRow = (name, label, value = 0, required = false) => html`
  <div class="field rate-row"><span class="label">${label}${required ? '' : html` <span class="muted">(optional)</span>`}</span>
    <span class="stars" role="radiogroup" aria-label="${label}">${STARS.map((n) => html`<label title="${n} star${n > 1 ? 's' : ''}"><input type="radio" name="${name}" value="${n}" ${value === n ? 'checked' : ''}>${ic('star')}</label>`)}</span></div>`;
export const starsShow = (n, cls = '') => html`<span class="stars-show ${cls}" aria-label="${n} of 5 stars">${STARS.map((i) => ic(i <= Math.round(n) ? 'starFill' : 'star', 'sm'))}</span>`;

function stepper(r) {
  const order = ['pending', 'assigned', 'collected', 'delivered'];
  const idx = order.indexOf(r.status);
  const steps = [
    ['Requested', 'plus', r.createdAt], ['Rider assigned', 'bike', r.assignedAt], ['Collected', 'package', r.collectedAt], ['Delivered', 'checkCircle', r.deliveredAt],
  ];
  return html`<div class="stepper ${r.status === 'cancelled' ? 'cancelled' : ''}">${steps.map(([label, icon, at], i) => {
    const cls = r.status === 'cancelled' ? '' : i < idx || r.status === 'delivered' ? 'done' : i === idx ? 'current' : '';
    const showIcon = cls === 'done' ? 'check' : icon;
    return html`<div class="step ${cls}"><span class="b">${ic(showIcon)}</span>${label}<small>${at && cls ? fmtTime(at) : ''}</small></div>`;
  })}</div>`;
}

export async function render(el, ctx) {
  const id = ctx.params.id;
  const staff = STAFF.includes(ctx.user.role);
  const load = async () => {
    const d = await api.get(`/api/requests/${id}`);
    if (ctx.user.role === 'rider') d.request = applyPending(d.request, await pendingFor(d.request.id));
    return d;
  };
  let data = await load();
  let track = { rider: null, path: [] };
  let eta = null;
  const loadEta = async () => { eta = inProgress() && !data.__offline ? await api.get(`/api/requests/${id}/eta`).catch(() => null) : null; };
  const inProgress = () => ['assigned', 'collected'].includes(data.request.status);
  const loadTrack = async () => { track = inProgress() || isStaffish ? await api.get(`/api/requests/${id}/track`).catch(() => track) : track; };
  const isStaffish = STAFF.includes(ctx.user.role);
  await Promise.all([loadTrack(), loadEta()]);
  // The map lives outside the repainted HTML so Google Maps is created once per visit.
  const mapHost = document.createElement('div');
  let mapCtl = null;
  let riders = [];
  if (staff) {
    try { riders = (await api.get('/api/stats')).riders; } catch {}
  }

  const writer = canWrite(ctx.user);
  const paint = () => {
    const { request: r, records, activity, overrides } = data;
    const changes = data.locationChanges || [];
    const isRider = r.rider?.id === ctx.user.id;
    const owner = r.requester.id === ctx.user.id;
    const canChangeStops = (writer || (owner && ctx.user.role !== 'manager')) && ['pending', 'assigned', 'collected'].includes(r.status) && !data.__offline;
    const needsAck = isRider ? changes.filter((c) => c.needsAck) : [];
    const changedStop = (kind, seq) => changes.find((c) => c.kind === kind && c.seq === seq && c.significant && ['assigned', 'collected'].includes(r.status));
    const tel = (phone, target, label) => html`<a class="contact" href="${telHref(phone)}" data-contact="${target}">${ic('phone', 'sm')}${label || phone}</a>`;
    const canEdit = (writer && ['pending', 'assigned'].includes(r.status)) || (owner && r.status === 'pending' && ctx.user.role !== 'manager');
    const canCancel = canEdit;
    const canAssign = writer && ['pending', 'assigned'].includes(r.status);
    const canAccept = ctx.user.role === 'rider' && r.status === 'pending' && !r.rider;
    const failed = r.dropoffs.filter((d) => d.status === 'failed').length;
    const done = r.dropoffs.filter((d) => d.status === 'delivered').length;

    el.innerHTML = String(html`
    <div class="crumbs"><a href="#/${ctx.user.role === 'rider' ? 'jobs' : 'requests'}">${ctx.user.role === 'rider' ? 'My jobs' : 'Requests'}</a>${ic('chevronRight', 'sm')}<span class="mono">${r.ref}</span></div>
    <div class="page-head">
      <div>
        <div class="row wrap" style="gap:8px;margin-bottom:8px">${statusBadge(r.status)}${urgentBadge(r.priority)}${categoryBadge(r.category)}
          ${r.source === 'whatsapp' ? html`<span class="badge b-outline">${ic('message')}From WhatsApp</span>` : ''}
          ${r.runName ? html`<a class="badge s-assigned" href="#/runs" style="text-decoration:none">${ic('route')}${r.runName}</a>` : ''}</div>
        <h1>${r.title}</h1>
        <p>Requested by ${r.requester.name} · ${fmtDateTime(r.createdAt)} · version ${r.version}</p>
      </div>
      <div class="row wrap">
        ${ctx.user.role === 'manager' ? readOnlyChip() : ''}
        ${canAccept ? html`<button class="btn primary lg" data-act="accept" data-busy=" Accepting…">${ic('hand2', 'sm')} Accept this job</button>` : ''}
        ${canCancel ? html`<button class="btn danger" data-act="cancel">${ic('x', 'sm')} Cancel</button>` : ''}
        ${canEdit ? html`<a class="btn" href="#/requests/${r.id}/edit">${ic('edit', 'sm')} Edit</a>` : ''}
        ${isRider && r.status === 'assigned' ? html`<button class="btn primary" data-act="collect">${ic('package', 'sm')} ${pickupsOf(r).length > 1 ? `Collect pickup ${nextPickup(r)?.seq}` : 'Record collection'}</button>` : ''}
        ${canAssign ? html`<button class="btn primary" data-act="assign">${ic('bike', 'sm')} ${r.rider ? 'Reassign' : 'Assign rider'}</button>` : ''}
      </div>
    </div>

    ${data.__offline ? html`<div class="alert warn" style="margin-bottom:16px">${ic('wifiOff', 'sm')}<span><b>Offline.</b> Showing the copy saved ${timeAgo(new Date(data.__cachedAt).toISOString())}. What you record now is kept on this phone and synced later.</span></div>` : ''}
    ${r.pendingSync ? html`<div class="alert info" style="margin-bottom:16px">${ic('cloud', 'sm')}<span>${r.pendingSync} action${r.pendingSync > 1 ? 's' : ''} on this delivery ${r.pendingSync > 1 ? 'are' : 'is'} saved on this phone and waiting to sync.</span></div>` : ''}
    ${needsAck.map((c) => html`<div class="alert err change-alert" style="margin-bottom:16px">${ic('pin', 'sm')}<span class="grow"><b>${c.kind === 'pickup' ? 'Pickup' : `Drop-off ${c.seq}`} address changed</b> by ${c.by} ${timeAgo(c.at)}.<br>
      <s class="muted">${c.from.address}</s> → <b>${c.to.address}</b>${c.distanceKm != null ? ` (${c.distanceKm} km away)` : ''}${c.reason ? html`<br><span class="muted">“${c.reason}”</span>` : ''}</span>
      <button class="btn danger solid" data-ack="${c.id}">${ic('check', 'sm')} Confirm new address</button></div>`)}
    ${r.status === 'cancelled' ? html`<div class="alert err" style="margin-bottom:16px">${ic('x', 'sm')}<span><b>Cancelled.</b> ${r.cancelReason || 'No reason given.'}</span></div>` : ''}
    ${isUpcoming(r) ? html`<div class="alert sched" style="margin-bottom:16px">${ic('calendar', 'sm')}<span><b>Scheduled pickup: ${new Date(r.scheduledAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</b> (${timeAgo(r.scheduledAt)}).
      ${r.rider ? `${r.rider.name} is booked for it.` : 'A rider will be assigned before then.'}</span></div>` : ''}
    ${canAccept ? html`<div class="alert info" style="margin-bottom:16px">${ic('hand2', 'sm')}<span><b>This job is open.</b> ${ctx.user.onShift ? 'Accept it to make it yours. Dispatch is told automatically.' : 'Switch on shift to accept it.'}</span></div>` : ''}
    ${failed ? html`<div class="alert warn" style="margin-bottom:16px">${ic('alert', 'sm')}<span><b>${failed} drop-off${failed > 1 ? 's' : ''} could not be delivered.</b> The rider can retry from this page.</span></div>` : ''}

    <div class="grid g-main-wide">
      <div class="stack">
        <section class="card">${stepper(r)}</section>

        <section class="card">
          <div class="card-head"><h2>Route</h2><span class="muted">${pickupsOf(r).length > 1 ? `${pickupsOf(r).filter((p) => p.collected).length} of ${pickupsOf(r).length} collected · ` : ''}${done} of ${r.dropoffs.length} delivered</span></div>
          ${pickupsOf(r).map((p, i, all) => html`
          <div class="stop pickup ${p.collected ? 'collected' : ''} ${changedStop('pickup', p.seq) && !p.collected ? 'changed' : ''}">
            <span class="n">${p.collected ? ic('check') : all.length > 1 ? `P${p.seq}` : 'P'}</span>
            <div class="stack-sm" style="gap:4px">
              <span class="muted" style="font-size:12px;font-weight:600">PICKUP${all.length > 1 ? ` ${p.seq} OF ${all.length}` : ''}${i === 0 ? (r.scheduledAt ? ` · ${fmtDateTime(r.scheduledAt).toUpperCase()}` : ' · ASAP') : ''}
                ${changedStop('pickup', p.seq) && !p.collected ? html`<span class="badge s-failed">${ic('pin')}Updated ${timeAgo(changedStop('pickup', p.seq).at)}</span>` : ''}</span>
              <span class="addr">${p.address}</span>
              ${changedStop('pickup', p.seq) && !p.collected ? html`<span class="muted was">Was: <s>${changedStop('pickup', p.seq).from.address}</s></span>` : ''}
              ${detailsBlock(p.details)}
              <div class="row wrap" style="gap:14px">
                ${p.contactName ? html`<span class="contact">${ic('user', 'sm')}${p.contactName}</span>` : ''}
                ${p.contactPhone ? tel(p.contactPhone, `pickup:${p.seq}`) : ''}
                <a class="contact" href="${mapsHref(p)}" target="_blank" rel="noopener noreferrer">${ic('external', 'sm')}Navigate</a>
                ${canChangeStops && !p.collected ? html`<button type="button" class="link-btn" data-change="pickup:${p.seq}">${ic('edit', 'sm')}Change address</button>` : ''}
              </div>
              ${p.collected && p.collectedFrom ? html`<span class="muted" style="font-size:13px">Collected from <b>${p.collectedFrom}</b></span>` : ''}
            </div>
            <span>${p.pendingSync ? html`<span class="badge s-pending">${ic('cloud')}Waiting to sync</span>` : p.collected ? html`<span class="badge s-delivered">${ic('check')}Collected ${fmtTime(p.collectedAt)}</span>`
              : isRider && r.status === 'assigned' ? html`<button class="btn sm ${p === nextPickup(r) ? 'primary' : ''}" data-collect="${p.seq}">${ic('package', 'sm')} Collect</button>` : ''}</span>
          </div>`)}
          ${r.dropoffs.map((d) => html`
          <div class="stop ${d.status} ${changedStop('dropoff', d.seq) && d.status !== 'delivered' ? 'changed' : ''}">
            <span class="n">${d.status === 'delivered' ? ic('check') : d.seq}</span>
            <div class="stack-sm" style="gap:4px">
              <span class="muted" style="font-size:12px;font-weight:600">DROP-OFF ${d.seq}
                ${changedStop('dropoff', d.seq) && d.status !== 'delivered' ? html`<span class="badge s-failed">${ic('pin')}Updated ${timeAgo(changedStop('dropoff', d.seq).at)}</span>` : ''}</span>
              <span class="addr">${d.address}</span>
              ${changedStop('dropoff', d.seq) && d.status !== 'delivered' ? html`<span class="muted was">Was: <s>${changedStop('dropoff', d.seq).from.address}</s></span>` : ''}
              ${detailsBlock(d.details)}
              ${d.instructions ? html`<span class="muted" style="font-size:13px">“${d.instructions}”</span>` : ''}
              <div class="row wrap" style="gap:14px">
                ${d.contactName ? html`<span class="contact">${ic('user', 'sm')}${d.contactName}</span>` : ''}
                ${d.contactPhone ? tel(d.contactPhone, `dropoff:${d.seq}`) : ''}
                <a class="contact" href="${mapsHref(d)}" target="_blank" rel="noopener noreferrer">${ic('external', 'sm')}Navigate</a>
                ${canChangeStops && d.status !== 'delivered' ? html`<button type="button" class="link-btn" data-change="dropoff:${d.seq}">${ic('edit', 'sm')}Change address</button>` : ''}
              </div>
              ${d.status === 'delivered' ? html`<span class="muted" style="font-size:13px">Received by <b>${d.receivedBy}</b> · ${fmtDateTime(d.handledAt)}</span>` : ''}
              ${d.status === 'failed' ? html`<span class="error-text">Not delivered: ${d.note}</span>` : ''}
            </div>
            <div>${d.pendingSync ? html`<span class="badge s-pending">${ic('cloud')}Waiting to sync</span>` : isRider && r.status === 'collected' && d.status !== 'delivered'
              ? html`<button class="btn sm ${d.status === 'failed' ? '' : 'primary'}" data-handover="${d.id}">${ic('hand', 'sm')} ${d.status === 'failed' ? 'Retry' : 'Hand over'}</button>`
              : html`<span class="badge dot ${d.status === 'delivered' ? 's-delivered' : d.status === 'failed' ? 's-failed' : 's-pending'}">${d.status === 'delivered' ? 'Delivered' : d.status === 'failed' ? 'Failed' : 'Pending'}</span>`}</div>
          </div>`)}
        </section>

        ${(r.handling.length || r.handlingNotes || r.notes) ? html`
        <section class="card">
          <div class="card-head"><h2>Handling &amp; notes</h2></div>
          <div class="card-body stack">
            ${r.handling.length ? html`<div class="chips">${r.handling.map((h) => html`<span class="badge" style="height:30px;padding:0 12px">${ic(HANDLING[h].icon)}${HANDLING[h].label}</span>`)}</div>` : ''}
            ${r.handlingNotes ? html`<div><div class="label">Handling notes</div><p style="white-space:pre-line">${r.handlingNotes}</p></div>` : ''}
            ${r.notes ? html`<div><div class="label">Notes</div><p style="white-space:pre-line">${r.notes}</p></div>` : ''}
          </div>
        </section>` : ''}

        <section class="card">
          <div class="card-head"><div><h2>Collection &amp; handover records</h2><p>Photos, signed D-notes, GPS position and time recorded by the assigned rider</p></div></div>
          ${records.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Record</th><th>By</th><th>Counterpart</th><th>Proof</th><th class="hide-sm">Note</th><th>When</th></tr></thead><tbody>
            ${records.map((x) => html`<tr>
              <td><span class="badge ${x.kind === 'collection' ? 's-collected' : x.outcome === 'failed' ? 's-failed' : 's-delivered'}">${ic(x.kind === 'collection' ? 'package' : 'hand')}${x.kind === 'collection' ? (pickupsOf(r).length > 1 ? `Pickup ${x.pickupSeq}` : 'Collection') : `Drop-off ${x.dropoffSeq}${x.outcome === 'failed' ? ' · failed' : ''}`}</span></td>
              <td>${x.by}</td><td>${x.counterpart || '—'}${x.itemCount ? html` <span class="muted">· ${x.itemCount} items</span>` : ''}</td>
              <td><div class="proofs">
                ${x.photo ? html`<button type="button" class="proof-thumb" data-proof="${x.photo}" data-title="${x.kind === 'collection' ? 'Collection photo' : `Drop-off ${x.dropoffSeq} photo`}" aria-label="View photo"><img src="${x.photo}" alt="" loading="lazy"></button>` : ''}
                ${x.signature ? html`<button type="button" class="proof-thumb sig" data-proof="${x.signature}" data-title="D-note signed by ${x.signedBy || x.counterpart}${x.dnoteRef ? ` · ${x.dnoteRef}` : ''}" aria-label="View D-note signature"><img src="${x.signature}" alt="" loading="lazy"></button>` : ''}
                ${x.dnoteRef ? html`<span class="badge b-outline mono">${x.dnoteRef}</span>` : ''}
                ${!x.photo && !x.signature && !x.dnoteRef ? html`<span class="muted">—</span>` : ''}</div></td>
              <td class="hide-sm muted">${x.note || '—'}${x.gps ? html`<div class="gps-tag ${x.gpsStatus}">${ic('gps', 'sm')}${GPS_LABEL[x.gpsStatus] || 'GPS'} <a href="https://www.google.com/maps/search/?api=1&query=${x.gps.lat},${x.gps.lng}" target="_blank" rel="noopener">map</a></div>` : ''}</td><td class="nowrap muted">${fmtDateTime(x.createdAt)}</td></tr>`)}
          </tbody></table></div>` : html`<div class="card-body muted">No records yet. At pickup the rider records who handed over (a photo is optional). At each drop-off they photograph the handover and the recipient signs the D-note.</div>`}
        </section>
        ${ratingCard(r)}
        ${changes.length ? html`<section class="card">
          <div class="card-head"><div><h2>Address changes</h2><p>Every change to a pickup or drop-off after the request was made</p></div><span class="muted">${changes.length}</span></div>
          <div class="list">${changes.map((c) => html`<div class="list-item">
            <span class="avatar sm" style="background:var(--st-pending-bg);color:var(--st-pending)">${ic('pin', 'sm')}</span>
            <div class="grow"><b>${c.kind === 'pickup' ? (pickupsOf(r).length > 1 ? `Pickup ${c.seq}` : 'Pickup') : `Drop-off ${c.seq}`}</b> · ${c.by} · ${fmtDateTime(c.at)}
              <div class="req-sub"><s>${c.from.address}</s> → <b>${c.to.address}</b>${c.distanceKm != null ? ` · ${c.distanceKm} km` : ''}</div>
              ${c.reason ? html`<div class="req-sub">“${c.reason}”</div>` : ''}</div>
            <span class="badge ${c.needsAck ? 's-failed' : c.acknowledgedAt && c.significant ? 's-delivered' : 'b-outline'}">${c.needsAck ? 'Rider to confirm' : c.significant && c.acknowledgedAt ? `Confirmed ${fmtTime(c.acknowledgedAt)}` : 'Recorded'}</span>
          </div>`)}</div></section>` : ''}
        ${(data.incidents || []).length ? html`<section class="card">
          <div class="card-head"><h2>${ic('sos', 'sm')} Incidents on this delivery</h2></div>
          <div class="list">${data.incidents.map((x) => html`<a class="list-item" href="#/incidents/${x.id}">
            <span class="avatar sm" style="background:var(--danger-bg);color:var(--danger)">${ic('sos', 'sm')}</span>
            <div class="grow"><b>${x.type}</b> · ${x.rider.name} · ${fmtDateTime(x.createdAt)}<div class="req-sub">${x.description || ''}</div></div>
            <span class="badge ${x.status === 'resolved' ? 's-delivered' : x.status === 'acknowledged' ? 's-assigned' : 's-failed'}">${x.status}</span></a>`)}</div></section>` : ''}
      </div>

      <aside class="stack sticky">
        <section class="card">
          <div class="card-head"><h3>Rider</h3>${canAssign ? html`<button class="btn sm ghost" data-act="assign">${r.rider ? 'Change' : 'Assign'}</button>` : ''}</div>
          <div class="card-body">
            ${r.rider ? html`<div class="row">${avatar(r.rider.name, 'lg')}<div class="grow"><b>${r.rider.name}</b> ${vehicleBadge(data.fuel?.estimate?.vehicle)}
                <div class="muted" style="font-size:13px">${r.status === 'assigned' ? 'Heading to pickup' : r.status === 'collected' ? 'Carrying the items' : r.status === 'delivered' ? 'Delivery complete' : ''}</div></div>
                ${r.rider.phone && !isRider ? html`<a class="btn sm primary" href="${telHref(r.rider.phone)}" data-contact="rider" aria-label="Call ${r.rider.name}">${ic('phone', 'sm')} Call</a>` : ''}</div>
              ${data.rating && staff ? html`<p class="muted" style="font-size:12.5px;margin-top:10px">Client rating for this delivery: ${starsShow(data.rating.stars)}</p>` : ''}
              ${['collected', 'delivered'].includes(r.status) ? html`<p class="muted" style="font-size:12.5px;margin-top:12px">${ic('lock', 'sm')} The rider is fixed once the items are collected.</p>` : ''}`
            : html`<div class="row"><span class="avatar lg" style="background:var(--surface-3);color:var(--muted)">${ic('bike')}</span><div><b>No rider yet</b><div class="muted" style="font-size:13px">${CATEGORY[r.category].label === 'General' ? 'Any available rider' : `${CATEGORY[r.category].label}-designated rider required`}</div></div></div>`}
          </div>
        </section>
        ${contactsCard(r, isRider, owner)}
        <section id="route-map"></section>
        ${eta?.available ? html`<p class="eta-line">${ic('clock', 'sm')} <b>≈ ${eta.minutes} min</b> to ${eta.to.kind === 'pickup' ? 'the pickup' : `drop-off ${eta.to.seq}`} · ${eta.km} km · arrives ≈ ${fmtTime(eta.arriveBy)} <span class="muted">(${eta.source === 'google' ? 'Google traffic' : 'estimate'})</span></p>` : ''}
        ${track.rider ? html`<p class="muted" style="font-size:12.5px;margin-top:-8px">${ic('gps', 'sm')} ${r.rider?.name} · GPS ${timeAgo(track.rider.recordedAt)}${track.rider.speed != null ? ` · ${Math.round(track.rider.speed)} km/h` : ''}</p>`
          : inProgress() ? html`<p class="faint" style="font-size:12.5px;margin-top:-8px">${ic('gpsOff', 'sm')} No live position — the rider shares GPS only while on shift with the app open.</p>` : ''}
        ${fuelCard(data.fuel, r)}
        ${staff ? notificationsCard(data.notifications, r, writer) : ''}
        ${overrides.length ? html`
        <section class="card">
          <div class="card-head"><h3>${ic('shield', 'sm')} Recorded overrides</h3></div>
          <div class="card-body stack-sm">${overrides.map((o) => html`
            <div class="alert warn" style="display:block"><b>${o.by}</b> assigned <b>${o.rider}</b> · ${timeAgo(o.createdAt)}
              <div style="margin-top:4px;color:var(--ink-2)">“${o.reason}”</div>
              <div style="margin-top:6px;font-size:12px">${o.conflicts.map((c) => c.message).join(' ')}</div></div>`)}</div>
        </section>` : ''}
        <section class="card">
          <div class="card-head"><h3>History</h3><div class="row" style="gap:6px"><span class="muted">${activity.length}</span>${exportBtn('data-export-history', 'Export')}</div></div>
          <div class="timeline">${activity.map((a) => html`
            <div class="tl a-${a.action}"><span class="ic">${ic(activityIcon(a.action))}</span>
              <div><div class="msg">${a.message}</div><div class="when">${fmtDateTime(a.createdAt)}</div></div></div>`)}</div>
        </section>
      </aside>
    </div>`);
    el.querySelector('#route-map').append(mapHost);
    wire(r);
  };

  function contactsCard(r, isRider, owner) {
    if (!['assigned', 'collected'].includes(r.status)) return '';
    const rows = [];
    if (isRider) {
      if (r.requester.phone) rows.push(['user', `Requester · ${r.requester.name}`, r.requester.phone, 'requester']);
      if (data.dispatchPhone) rows.push(['headset', 'Dispatch', data.dispatchPhone, 'dispatch']);
    } else if (owner && data.dispatchPhone) rows.push(['headset', 'Dispatch', data.dispatchPhone, 'dispatch']);
    else if (staff && r.requester.phone) rows.push(['user', `Requester · ${r.requester.name}`, r.requester.phone, 'requester']);
    if (!rows.length) return '';
    return html`<section class="card"><div class="card-head"><h3>${ic('phone', 'sm')} Contacts</h3></div>
      <div class="list">${rows.map(([, label, phone, target]) => html`<div class="list-item"><div class="grow"><b>${label}</b><div class="req-sub mono">${phone}</div></div>
        <a class="btn sm" href="${telHref(phone)}" data-contact="${target}">${ic('phone', 'sm')} Call</a></div>`)}</div></section>`;
  }

  function ratingCard(r) {
    if (data.rating) {
      const g = data.rating;
      const crit = [['professionalism', 'Professionalism'], ['timeliness', 'Timeliness'], ['communication', 'Communication'], ['handling', 'Handling of items']].filter(([k]) => g[k]);
      return html`<section class="card"><div class="card-head"><h2>${ic('star', 'sm')} Client rating</h2>${starsShow(g.stars, 'lg')}</div>
        <div class="card-body stack-sm">
          ${crit.length ? html`<dl class="kv" style="grid-template-columns:150px 1fr">${crit.map(([k, l]) => html`<dt>${l}</dt><dd>${starsShow(g[k])}</dd>`)}</dl>` : ''}
          ${g.comment ? html`<p style="white-space:pre-line">“${g.comment}”</p>` : ''}
          <p class="faint" style="font-size:12px">${g.by ? `${g.by} · ` : ''}${fmtDateTime(g.createdAt)}</p></div></section>`;
    }
    if (!data.canRate) return '';
    return html`<section class="card rate-card"><div class="card-head"><div><h2>${ic('star', 'sm')} Rate ${r.rider.name}</h2><p>How did the delivery go? Your rating helps dispatch.</p></div></div>
      <form class="card-body stack" id="rate-form">
        ${starRow('stars', 'Overall', 0, true)}
        <details class="more"><summary>Rate specific areas <span class="muted">(optional)</span></summary>
          ${starRow('professionalism', 'Professionalism')}${starRow('timeliness', 'Timeliness')}${starRow('communication', 'Communication')}${starRow('handling', 'Handling of items')}
        </details>
        <div class="field"><label for="rate-c">Feedback <span class="muted">(optional)</span></label><textarea class="input" id="rate-c" name="comment" maxlength="1000" rows="2" placeholder="Anything dispatch should know"></textarea></div>
        <div><button class="btn primary" type="submit" data-busy=" Sending…">${ic('send', 'sm')} Send rating</button></div>
      </form></section>`;
  }

  function fuelCard(fuel, r) {
    if (!fuel) return '';
    const q = fuel.actual || fuel.estimate;
    return html`<section class="card">
      <div class="card-head"><h3>${ic('fuel', 'sm')} ${fuel.actual ? 'Trip cost' : 'Quote estimate'}</h3>
        <span class="badge ${q.source === 'gps' ? 's-delivered' : 'b-outline'}">${q.source === 'gps' ? 'GPS distance' : 'Estimated'}</span></div>
      <div class="card-body stack-sm">
        ${breakdown(q, fuel.settings)}
        ${fuel.actual ? html`<p class="faint" style="font-size:12px">Quoted before the trip: ${kes(fuel.estimate.total)} for ≈${fuel.estimate.km} km.</p>` : ''}
        ${fuel.estimate.placedStops < fuel.estimate.totalStops ? html`<p class="faint" style="font-size:12px">${fuel.estimate.totalStops - fuel.estimate.placedStops} stop(s) couldn't be placed in Kenya, so the distance is incomplete. Add pins to improve it.</p>` : ''}
        ${staff ? html`<a class="btn sm ghost" href="#/fuel">${ic('calc', 'sm')} Fuel &amp; quotes</a>` : ''}
      </div></section>`;
  }

  function notificationsCard(list, r, writer) {
    const LABEL = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', skipped: 'Not sent' };
    const TONE = { sent: 's-assigned', delivered: 's-delivered', read: 's-delivered', failed: 's-failed', skipped: 's-pending' };
    const canResend = writer && r.rider && ['assigned', 'collected'].includes(r.status);
    return html`<section class="card">
      <div class="card-head"><h3>${ic('message', 'sm')} Rider notifications</h3>
        ${canResend ? html`<button class="btn sm ghost" data-act="notify" data-busy=" Sending…">${ic('send', 'sm')} Resend</button>` : ''}</div>
      ${list.length ? html`<div class="list">${list.map((n) => html`
        <div class="list-item"><span class="avatar sm" style="background:${n.channel === 'whatsapp' ? '#25d366' : 'var(--surface-3)'};color:${n.channel === 'whatsapp' ? '#fff' : 'var(--muted)'}">${ic(n.channel === 'sms' ? 'phone' : n.channel === 'whatsapp' ? 'whatsapp' : 'message', 'sm')}</span>
          <div class="grow"><b>${n.channel === 'whatsapp' ? 'WhatsApp' : n.channel === 'sms' ? 'SMS' : 'No message'}</b> <span class="muted">to ${n.rider}${n.recipient ? ` · ${n.recipient}` : ''}</span>
            ${n.error ? html`<div class="req-sub error-text">${n.error}</div>` : ''}<div class="req-sub">${fmtDateTime(n.createdAt)}</div></div>
          <span class="badge ${TONE[n.status]}">${LABEL[n.status]}</span></div>`)}</div>`
        : html`<div class="card-body muted" style="font-size:13px">The rider gets a WhatsApp message (or an SMS if WhatsApp fails) as soon as they're assigned.</div>`}
    </section>`;
  }

  async function drawMap() {
    const r = data.request;
    const live = { rider: track.rider, path: track.path };
    if (!mapCtl) mapCtl = await mountRouteMap(mapHost, requestPoints(r), { width: 400, height: 280, ...live });
    else mapCtl.update(requestPoints(r), live);
  }

  const reload = async () => {
    data = await load();
    await Promise.all([loadTrack(), loadEta()]);
    if (ctx.isCurrent()) { paint(); drawMap(); }
  };
  const after = async (res) => {
    if (res?.needsAck) { const c = (data.locationChanges || []).find((x) => x.id === res.needsAck); if (c) await ackChange(data.request, c); }
    if (res) { await reload().catch(() => {}); ctx.refreshBadges(); }
  };

  function wire(r) {
    el.querySelectorAll('[data-contact]').forEach((a) => a.addEventListener('click', () => {
      api.post(`/api/requests/${r.id}/contact`, { target: a.dataset.contact, channel: 'call' }).catch(() => {});
    }));
    el.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      const c = data.locationChanges.find((x) => x.id === +b.dataset.ack);
      try { if (await ackChange(r, c)) await after(true); } catch (err) { toast(err.message, 'err'); }
    })));
    el.querySelectorAll('[data-change]').forEach((b) => b.addEventListener('click', async () => {
      const [kind, seq] = b.dataset.change.split(':');
      const stop = kind === 'pickup' ? pickupsOf(r).find((p) => p.seq === +seq) : r.dropoffs.find((d) => d.seq === +seq);
      const body = await changeStopDialog(r, kind, stop);
      if (!body) return;
      try {
        const res = await api.post(`/api/requests/${r.id}/stops/change`, { version: r.version, ...body });
        toast(res.changes.length ? (r.rider ? `Saved. ${r.rider.name} has been notified${res.changes.some((c) => c.significant) ? ' and must confirm' : ''}.` : 'Address updated.') : 'Saved.');
        await after(true);
      } catch (err) { const x = handleError(err); if (x?.stale) await reload(); }
    }));
    el.querySelector('#rate-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const v = (n) => (f[n] && f[n].value ? Number(f[n].value) : null);
      if (!v('stars')) { toast('Choose an overall rating (1–5 stars).', 'warn'); return; }
      busy(f.querySelector('[type=submit]'), async () => {
        try {
          await api.post(`/api/requests/${r.id}/rating`, { stars: v('stars'), professionalism: v('professionalism'), timeliness: v('timeliness'), communication: v('communication'), handling: v('handling'), comment: f.comment.value.trim() || null });
          toast('Thank you for rating the rider.');
          await reload();
        } catch (err) { toast(err.message, 'err'); }
      });
    });
    el.querySelector('[data-act=accept]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      if (await acceptJob(r)) await after(true);
    }));
    el.querySelectorAll('[data-proof]').forEach((b) => b.addEventListener('click', () => openModal({
      title: b.dataset.title, subtitle: `${r.ref} · ${r.title}`, iconName: b.classList.contains('sig') ? 'pen' : 'camera', wide: true,
      body: html`<img class="proof-full ${b.classList.contains('sig') ? 'sig' : ''}" src="${b.dataset.proof}" alt="${b.dataset.title}">`,
      actions: html`<a class="btn" href="${b.dataset.proof}" target="_blank" rel="noopener" download>${ic('download', 'sm')} Download</a><button class="btn primary" type="button" data-close>Close</button>`,
    })));
    el.querySelector('[data-export-history]')?.addEventListener('click', () => exportActivity(data.activity, `${r.ref}-history`, r.ref));
    el.querySelectorAll('[data-act=assign]').forEach((b) => b.addEventListener('click', async () => {
      const choice = await pickRiderDialog({ request: r, riders });
      if (!choice) return;
      await after(await assign(r, choice.riderId));
    }));
    el.querySelector('[data-act=collect]')?.addEventListener('click', async () => after(await recordCollection(r)));
    el.querySelectorAll('[data-collect]').forEach((b) => b.addEventListener('click', async () => {
      after(await recordCollection(r, pickupsOf(r).find((p) => p.seq === +b.dataset.collect)));
    }));
    el.querySelector('[data-act=notify]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try {
        const res = await api.post(`/api/requests/${r.id}/notify`);
        const n = res.notifications[0];
        toast(n?.status === 'sent' ? `Sent to ${n.rider} by ${n.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}` : `Not sent: ${n?.error || 'unknown error'}`, n?.status === 'sent' ? 'ok' : 'warn');
        await reload();
      } catch (err) { toast(err.message, 'err'); }
    }));
    el.querySelectorAll('[data-handover]').forEach((b) => b.addEventListener('click', async () => {
      after(await recordHandover(r, r.dropoffs.find((d) => d.id === +b.dataset.handover)));
    }));
    el.querySelector('[data-act=cancel]')?.addEventListener('click', async (e) => {
      const reason = await openModal({
        title: `Cancel ${r.ref}?`, subtitle: 'The requester and rider will see that it was cancelled.', iconName: 'x', tone: 'warn',
        body: html`<div class="field"><label for="cr">Reason <span class="muted">(optional)</span></label><input class="input" id="cr" name="reason" maxlength="300" placeholder="e.g. No longer needed" autofocus></div>`,
        actions: html`<button type="button" class="btn" data-close>Keep request</button><button class="btn danger solid" type="submit">Cancel request</button>`,
        onMount: ({ form, close }) => form.addEventListener('submit', (ev) => { ev.preventDefault(); close({ reason: form.reason.value.trim() }); }),
      });
      if (!reason) return;
      await busy(e.currentTarget, async () => {
        try { await api.post(`/api/requests/${r.id}/cancel`, { version: r.version, reason: reason.reason || null }); toast(`${r.ref} cancelled`); await after(true); }
        catch (err) { const x = handleError(err); if (x?.stale) await reload(); }
      });
    });
  }
  paint();
  await drawMap();
  ctx.onLive(() => reload().catch(() => {}), ['change', 'request', 'incident']);
  ctx.onLive((type, d) => { if (inProgress() && d?.riderId === data.request.rider?.id) Promise.all([loadTrack(), loadEta()]).then(() => { if (ctx.isCurrent()) { paint(); drawMap(); } }).catch(() => {}); }, ['location']);
  ctx.poll(() => { if (!document.querySelector('.modal-back')) reload().catch(() => {}); }, 30000);

}
