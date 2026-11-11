// Shared request actions: assignment with priority-rule overrides, stale-version handling.
import { api } from '../api.js';
import { html, ic, openModal, toast, avatar, tagBadges, vehicleBadge, fmtTime } from '../ui.js';

/** Ask the dispatcher to acknowledge a priority conflict and give a reason. Resolves to reason or null. */
export function overrideDialog({ conflicts, rider, request }) {
  return openModal({
    title: 'Priority rule conflict',
    subtitle: `Assigning ${rider} to ${request.ref} breaks a reserved-work rule. Overrides are recorded in the request history.`,
    iconName: 'alert', tone: 'warn',
    body: html`
      <div class="stack-sm">${conflicts.map((c) => html`<div class="alert warn">${ic('triangle', 'sm')}<span>${c.message}</span></div>`)}</div>
      <div class="field">
        <label for="ov-reason">Reason for the substitution</label>
        <textarea class="input" id="ov-reason" name="reason" required minlength="5" maxlength="500" placeholder="e.g. Felix is off sick and the proofs must reach the agency by 3pm." autofocus></textarea>
      </div>
      <label class="switch"><input type="checkbox" name="ack" required> I acknowledge this overrides the priority rules</label>
      <p class="error-text" id="ov-err" hidden></p>`,
    actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn danger solid" type="submit">${ic('shield', 'sm')} Record override &amp; assign</button>`,
    onMount: ({ form, close }) => form.addEventListener('submit', (e) => {
      e.preventDefault();
      const reason = form.reason.value.trim();
      const err = form.querySelector('#ov-err');
      if (reason.length < 5) { err.textContent = 'Give a short reason (at least 5 characters).'; err.hidden = false; return; }
      if (!form.ack.checked) { err.textContent = 'Tick the acknowledgement to continue.'; err.hidden = false; return; }
      close(reason);
    }),
  });
}

/** Assign (or unassign with riderId=null). Returns the updated request, or null if cancelled/failed. */
export async function assign(request, riderId, { riderName } = {}) {
  const send = (override) => api.post(`/api/requests/${request.id}/assign`, { version: request.version, riderId, ...(override ? { override } : {}) });
  try {
    const res = await send();
    toast(riderId ? `${request.ref} assigned to ${res.request.rider?.name} · notifying the rider` : `${request.ref} moved back to the queue`);
    return res.request;
  } catch (err) {
    if (err.code === 'override_required') {
      const reason = await overrideDialog({ conflicts: err.data.conflicts, rider: err.data.rider || riderName, request });
      if (!reason) return null;
      try {
        const res = await send({ acknowledged: true, reason });
        toast(`Override recorded · ${request.ref} assigned to ${res.request.rider?.name} · notifying the rider`, 'warn');
        return res.request;
      } catch (e2) { return handleError(e2); }
    }
    return handleError(err);
  }
}

/** Switch a rider on or off shift. Starts/stops this device's GPS sharing when riders switch themselves. */
export async function setShift(ctx, rider, onShift) {
  try {
    const res = await api.post(`/api/riders/${rider.id}/shift`, { onShift });
    if (rider.id === ctx.user.id) {
      ctx.setUser({ onShift: res.rider.onShift, onShiftSince: res.rider.onShiftSince });
      const { syncTracking } = await import('../tracker.js');
      syncTracking(res.rider.onShift);
    }
    toast(res.rider.onShift ? `${rider.id === ctx.user.id ? 'You are' : `${rider.name} is`} on shift` : `${rider.id === ctx.user.id ? 'You are' : `${rider.name} is`} off shift`);
    return res.rider;
  } catch (err) { toast(err.message, 'err'); return null; }
}

/** A rider takes a waiting job. Returns the updated request, or null. */
export async function acceptJob(request) {
  try {
    const res = await api.post(`/api/requests/${request.id}/accept`, { version: request.version });
    toast(`${request.ref} is yours. Head to the pickup.`);
    return res.request;
  } catch (err) {
    toast(err.message, err.code === 'taken' || err.code === 'off_shift' ? 'warn' : 'err');
    return null;
  }
}

export function handleError(err) {
  if (err.code === 'stale') {
    toast('Someone else just updated this request. Showing the latest version.', 'warn');
    return { stale: true, ...err.data.current };
  }
  toast(err.message, 'err');
  return null;
}

/** Rider picker modal used outside the board (detail page, mobile). */
export function pickRiderDialog({ request, riders }) {
  return openModal({
    title: request.rider ? 'Reassign rider' : 'Assign a rider',
    subtitle: `${request.ref} · ${request.title}`,
    iconName: 'bike',
    body: html`<div class="pick-list">
      ${[['Available · on shift', riders.filter((r) => r.onShift).sort((a, b) => (a.openJobs ?? 0) - (b.openJobs ?? 0)), true],
        ['Unavailable · off shift', riders.filter((r) => !r.onShift), false]].map(([label, list, on]) => (list.length ? html`
        <div class="pick-group ${on ? 'on' : 'off'}">${on ? html`<span class="onshift"></span>` : html`<span class="offshift"></span>`}${label}<span class="n">${list.length}</span></div>
        ${list.map((r) => html`
        <label class="pick ${on ? 'avail' : 'unavail'}">
          <input type="radio" name="rider" value="${r.id}" ${request.rider?.id === r.id ? 'checked' : ''}>
          ${avatar(r.name, 'sm')}
          <div class="grow"><b>${r.name}</b> ${vehicleBadge(r.vehicle)}<div class="req-sub">${on ? `On shift since ${fmtTime(r.onShiftSince)}` : 'Off shift'} · ${r.openJobs ?? 0} open</div></div>
          ${tagBadges(r.tags)}
        </label>`)}` : ''))}
      </div>`,
    actions: html`${request.rider ? html`<button type="button" class="btn danger" data-unassign>Unassign</button><span class="grow"></span>` : ''}
      <button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Assign</button>`,
    onMount: ({ form, close }) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = form.rider.value;
        if (!v) { toast('Choose a rider.', 'warn'); return; }
        close({ riderId: Number(v) });
      });
      form.querySelector('[data-unassign]')?.addEventListener('click', () => close({ riderId: null }));
    },
  });
}
