import { api } from '../api.js';
import {
  html, ic, raw, statusBadge, categoryBadge, urgentBadge, avatar, timeAgo, fmtDateTime, fmtTime, HANDLING, CATEGORY,
  openModal, toast, busy, telHref, mapsHref,
} from '../ui.js';
import { renderMap, requestPoints } from '../map.js';
import { activityIcon } from './activity.js';
import { assign, pickRiderDialog, handleError } from './actions.js';

const STAFF = ['admin', 'manager', 'dispatcher'];

export function collectDialog(r) {
  return openModal({
    title: 'Record collection', subtitle: `${r.ref} · ${r.pickup.address}`, iconName: 'package',
    body: html`
      <div class="field"><label for="cf">Collected from</label><input class="input" id="cf" name="collectedFrom" required value="${r.pickup.contactName || ''}" placeholder="Name of the person who handed over" autofocus></div>
      <div class="field"><label for="ci">Number of items <span class="muted">(optional)</span></label><input class="input" id="ci" name="itemCount" type="number" min="1" max="999" inputmode="numeric"></div>
      <div class="field"><label for="cn">Note</label><textarea class="input" id="cn" name="note" maxlength="500" placeholder="Condition of items, seals, anything unusual"></textarea></div>
      ${r.handling.length ? html`<div class="chips">${r.handling.map((h) => html`<span class="badge">${ic(HANDLING[h].icon)}${HANDLING[h].label}</span>`)}</div>` : ''}
      <div class="gps-off">${ic('gpsOff', 'sm')} Location check not connected — the collection is recorded without GPS verification</div>`,
    actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('check', 'sm')} Confirm collection</button>`,
    onMount: ({ form, close }) => form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.collectedFrom.value.trim()) { form.collectedFrom.setAttribute('aria-invalid', 'true'); form.collectedFrom.focus(); return; }
      close({ collectedFrom: form.collectedFrom.value.trim(), itemCount: form.itemCount.value ? Number(form.itemCount.value) : null, note: form.note.value.trim() || null });
    }),
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
      <div class="field"><label for="hn" data-label>Note <span class="muted">(optional)</span></label><textarea class="input" id="hn" name="note" maxlength="500" placeholder="e.g. Signed at reception"></textarea></div>
      ${r.handling.includes('signature') ? html`<div class="alert info">${ic('pen', 'sm')}<span>Signature required — confirm the recipient signed the delivery note.</span></div>` : ''}
      ${r.handling.includes('cash') ? html`<div class="alert warn">${ic('coins', 'sm')}<span>Count the cash with the recipient before handing over.</span></div>` : ''}
      <div class="gps-off">${ic('gpsOff', 'sm')} Handover GPS verification is not connected</div>
      <p class="error-text" id="h-err" hidden></p>`,
    actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('check', 'sm')} Record handover</button>`,
    onMount: ({ form, close }) => {
      const sync = () => {
        const failed = form.outcome.value === 'failed';
        form.querySelector('[data-when=delivered]').hidden = failed;
        form.querySelector('[data-label]').innerHTML = failed ? 'What happened? <span class="error-text">*</span>' : 'Note <span class="muted">(optional)</span>';
        form.note.placeholder = failed ? 'e.g. Office closed, recipient unreachable' : 'e.g. Signed at reception';
      };
      form.addEventListener('change', sync);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const outcome = form.outcome.value;
        const err = form.querySelector('#h-err');
        if (outcome === 'delivered' && !form.receivedBy.value.trim()) { err.textContent = 'Enter who received the items.'; err.hidden = false; return; }
        if (outcome === 'failed' && !form.note.value.trim()) { err.textContent = 'Describe what happened.'; err.hidden = false; return; }
        close({ outcome, receivedBy: form.receivedBy.value.trim() || null, note: form.note.value.trim() || null });
      });
    },
  });
}

export async function recordCollection(r) {
  const data = await collectDialog(r);
  if (!data) return null;
  try {
    const res = await api.post(`/api/requests/${r.id}/collect`, { version: r.version, ...data });
    toast(`Collection recorded for ${r.ref}`);
    return res.request;
  } catch (err) { return handleError(err); }
}
export async function recordHandover(r, d) {
  const data = await handoverDialog(r, d);
  if (!data) return null;
  try {
    const res = await api.post(`/api/requests/${r.id}/dropoffs/${d.id}/handover`, { version: r.version, ...data });
    toast(res.request.status === 'delivered' ? `${r.ref} fully delivered 🎉` : data.outcome === 'failed' ? `Drop-off ${d.seq} marked as not delivered` : `Drop-off ${d.seq} handed over`, data.outcome === 'failed' ? 'warn' : 'ok');
    return res.request;
  } catch (err) { return handleError(err); }
}

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
  let data = await api.get(`/api/requests/${id}`);
  let riders = [];
  if (staff) {
    try { riders = (await api.get('/api/stats')).riders; } catch {}
  }

  const paint = () => {
    const { request: r, records, activity, overrides } = data;
    const isRider = r.rider?.id === ctx.user.id;
    const owner = r.requester.id === ctx.user.id;
    const canEdit = (staff && ['pending', 'assigned'].includes(r.status)) || (owner && r.status === 'pending');
    const canCancel = canEdit;
    const canAssign = staff && ['pending', 'assigned'].includes(r.status);
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
        ${canCancel ? html`<button class="btn danger" data-act="cancel">${ic('x', 'sm')} Cancel</button>` : ''}
        ${canEdit ? html`<a class="btn" href="#/requests/${r.id}/edit">${ic('edit', 'sm')} Edit</a>` : ''}
        ${isRider && r.status === 'assigned' ? html`<button class="btn primary" data-act="collect">${ic('package', 'sm')} Record collection</button>` : ''}
        ${canAssign ? html`<button class="btn primary" data-act="assign">${ic('bike', 'sm')} ${r.rider ? 'Reassign' : 'Assign rider'}</button>` : ''}
      </div>
    </div>

    ${r.status === 'cancelled' ? html`<div class="alert err" style="margin-bottom:16px">${ic('x', 'sm')}<span><b>Cancelled.</b> ${r.cancelReason || 'No reason given.'}</span></div>` : ''}
    ${failed ? html`<div class="alert warn" style="margin-bottom:16px">${ic('alert', 'sm')}<span><b>${failed} drop-off${failed > 1 ? 's' : ''} could not be delivered.</b> The rider can retry from this page.</span></div>` : ''}

    <div class="grid g-main-wide">
      <div class="stack">
        <section class="card">${stepper(r)}</section>

        <section class="card">
          <div class="card-head"><h2>Route</h2><span class="muted">${done} of ${r.dropoffs.length} delivered</span></div>
          <div class="stop pickup">
            <span class="n">P</span>
            <div class="stack-sm" style="gap:4px">
              <span class="muted" style="font-size:12px;font-weight:600">PICKUP${r.scheduledAt ? ` · ${fmtDateTime(r.scheduledAt).toUpperCase()}` : ' · ASAP'}</span>
              <span class="addr">${r.pickup.address}</span>
              <div class="row wrap" style="gap:14px">
                ${r.pickup.contactName ? html`<span class="contact">${ic('user', 'sm')}${r.pickup.contactName}</span>` : ''}
                ${r.pickup.contactPhone ? html`<a class="contact" href="${telHref(r.pickup.contactPhone)}">${ic('phone', 'sm')}${r.pickup.contactPhone}</a>` : ''}
                <a class="contact" href="${mapsHref(r.pickup)}" target="_blank" rel="noopener noreferrer">${ic('external', 'sm')}Open in maps</a>
              </div>
            </div>
            <span>${r.collectedAt ? html`<span class="badge s-delivered">${ic('check')}Collected ${fmtTime(r.collectedAt)}</span>` : ''}</span>
          </div>
          ${r.dropoffs.map((d) => html`
          <div class="stop ${d.status}">
            <span class="n">${d.status === 'delivered' ? ic('check') : d.seq}</span>
            <div class="stack-sm" style="gap:4px">
              <span class="muted" style="font-size:12px;font-weight:600">DROP-OFF ${d.seq}</span>
              <span class="addr">${d.address}</span>
              ${d.instructions ? html`<span class="muted" style="font-size:13px">“${d.instructions}”</span>` : ''}
              <div class="row wrap" style="gap:14px">
                ${d.contactName ? html`<span class="contact">${ic('user', 'sm')}${d.contactName}</span>` : ''}
                ${d.contactPhone ? html`<a class="contact" href="${telHref(d.contactPhone)}">${ic('phone', 'sm')}${d.contactPhone}</a>` : ''}
                <a class="contact" href="${mapsHref(d)}" target="_blank" rel="noopener noreferrer">${ic('external', 'sm')}Open in maps</a>
              </div>
              ${d.status === 'delivered' ? html`<span class="muted" style="font-size:13px">Received by <b>${d.receivedBy}</b> · ${fmtDateTime(d.handledAt)}</span>` : ''}
              ${d.status === 'failed' ? html`<span class="error-text">Not delivered: ${d.note}</span>` : ''}
            </div>
            <div>${isRider && r.status === 'collected' && d.status !== 'delivered'
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
          <div class="card-head"><div><h2>Collection &amp; handover records</h2><p>Recorded by the assigned rider</p></div>
            <span class="gps-off">${ic('gpsOff', 'sm')} GPS verification not connected</span></div>
          ${records.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Record</th><th>By</th><th>Counterpart</th><th class="hide-sm">Note</th><th>When</th></tr></thead><tbody>
            ${records.map((x) => html`<tr>
              <td><span class="badge ${x.kind === 'collection' ? 's-collected' : x.outcome === 'failed' ? 's-failed' : 's-delivered'}">${ic(x.kind === 'collection' ? 'package' : 'hand')}${x.kind === 'collection' ? 'Collection' : `Drop-off ${x.dropoffSeq}${x.outcome === 'failed' ? ' · failed' : ''}`}</span></td>
              <td>${x.by}</td><td>${x.counterpart || '—'}${x.itemCount ? html` <span class="muted">· ${x.itemCount} items</span>` : ''}</td>
              <td class="hide-sm muted">${x.note || '—'}</td><td class="nowrap muted">${fmtDateTime(x.createdAt)}</td></tr>`)}
          </tbody></table></div>` : html`<div class="card-body muted">No records yet. The rider records the collection at pickup and a handover at each drop-off.</div>`}
        </section>
      </div>

      <aside class="stack sticky">
        <section class="card">
          <div class="card-head"><h3>Rider</h3>${canAssign ? html`<button class="btn sm ghost" data-act="assign">${r.rider ? 'Change' : 'Assign'}</button>` : ''}</div>
          <div class="card-body">
            ${r.rider ? html`<div class="row">${avatar(r.rider.name, 'lg')}<div class="grow"><b>${r.rider.name}</b>
                <div class="muted" style="font-size:13px">${r.status === 'assigned' ? 'Heading to pickup' : r.status === 'collected' ? 'Carrying the items' : r.status === 'delivered' ? 'Delivery complete' : ''}</div></div>
                ${r.rider.phone ? html`<a class="icon-btn" href="${telHref(r.rider.phone)}" aria-label="Call ${r.rider.name}">${ic('phone')}</a>` : ''}</div>
              ${['collected', 'delivered'].includes(r.status) ? html`<p class="muted" style="font-size:12.5px;margin-top:12px">${ic('lock', 'sm')} The rider is fixed once the items are collected.</p>` : ''}`
            : html`<div class="row"><span class="avatar lg" style="background:var(--surface-3);color:var(--muted)">${ic('bike')}</span><div><b>No rider yet</b><div class="muted" style="font-size:13px">${CATEGORY[r.category].label === 'General' ? 'Any available rider' : `${CATEGORY[r.category].label}-designated rider required`}</div></div></div>`}
          </div>
        </section>
        <section>${raw(renderMap(requestPoints(r), { width: 400, height: 280 }))}</section>
        ${overrides.length ? html`
        <section class="card">
          <div class="card-head"><h3>${ic('shield', 'sm')} Recorded overrides</h3></div>
          <div class="card-body stack-sm">${overrides.map((o) => html`
            <div class="alert warn" style="display:block"><b>${o.by}</b> assigned <b>${o.rider}</b> · ${timeAgo(o.createdAt)}
              <div style="margin-top:4px;color:var(--ink-2)">“${o.reason}”</div>
              <div style="margin-top:6px;font-size:12px">${o.conflicts.map((c) => c.message).join(' ')}</div></div>`)}</div>
        </section>` : ''}
        <section class="card">
          <div class="card-head"><h3>History</h3><span class="muted">${activity.length}</span></div>
          <div class="timeline">${activity.map((a) => html`
            <div class="tl a-${a.action}"><span class="ic">${ic(activityIcon(a.action))}</span>
              <div><div class="msg">${a.message}</div><div class="when">${fmtDateTime(a.createdAt)}</div></div></div>`)}</div>
        </section>
      </aside>
    </div>`);
    wire(r);
  };

  const reload = async () => { data = await api.get(`/api/requests/${id}`); if (ctx.isCurrent()) paint(); };
  const after = async (res) => { if (res) { await reload(); ctx.refreshBadges(); } };

  function wire(r) {
    el.querySelectorAll('[data-act=assign]').forEach((b) => b.addEventListener('click', async () => {
      const choice = await pickRiderDialog({ request: r, riders });
      if (!choice) return;
      await after(await assign(r, choice.riderId));
    }));
    el.querySelector('[data-act=collect]')?.addEventListener('click', async () => after(await recordCollection(r)));
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
  ctx.poll(() => { if (!document.querySelector('.modal-back')) reload().catch(() => {}); }, 20000);

}
