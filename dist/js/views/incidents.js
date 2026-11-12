// Incidents: emergencies reported by riders (accidents, breakdowns, medical, security, other).
// Dispatch acknowledges and resolves them; riders see their own reports and can file a new one.
import { api } from '../api.js';
import { html, ic, avatar, fmtDateTime, timeAgo, telHref, empty, busy, toast, openModal, canWrite, readOnlyChip } from '../ui.js';
import { INCIDENT_TYPES, reportIncident } from '../incident.js';
import { pendingActions } from '../offline.js';

const STATUS = { open: ['s-failed', 'Open'], acknowledged: ['s-assigned', 'Acknowledged'], resolved: ['s-delivered', 'Resolved'] };
const SEV = { critical: ['s-failed', 'Critical'], high: ['s-pending', 'High'], normal: ['b-outline', 'Normal'] };
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

export async function render(el, ctx) {
  const rider = ctx.user.role === 'rider';
  const writer = canWrite(ctx.user);
  let filter = ctx.params.id ? 'all' : rider ? 'all' : 'open';
  let list = [];
  let queued = [];
  const load = async () => {
    const r = await api.get(`/api/incidents${filter === 'all' ? '' : `?status=${filter}`}`);
    list = r.incidents;
    queued = rider ? (await pendingActions()).filter((e) => e.kind === 'incident') : [];
  };
  await load();

  const media = (x) => (x.media.length ? html`<div class="inc-media">${x.media.map((m) => (m.kind === 'video'
    ? html`<video class="inc-video" src="${m.url}" controls preload="metadata" aria-label="Video evidence"></video>`
    : html`<button type="button" class="proof-thumb" data-photo="${m.url}" aria-label="View photo"><img src="${m.url}" alt="" loading="lazy"></button>`))}</div>` : '');

  const card = (x) => {
    const t = INCIDENT_TYPES[x.type] || INCIDENT_TYPES.other;
    return html`<section class="card incident ${x.status} sev-${x.severity} ${+ctx.params.id === x.id ? 'focus' : ''}" id="inc-${x.id}">
      <div class="card-head">
        <span class="section-title"><span class="si inc-ic">${ic(t.icon, 'sm')}</span><div><h3>${t.label}</h3>
          <p>${fmtDateTime(x.occurredAt)} · ${timeAgo(x.createdAt)}${x.request ? html` · <a href="#/requests/${x.request.id}">${x.request.ref}</a>` : ''}</p></div></span>
        <div class="row wrap" style="gap:6px"><span class="badge ${SEV[x.severity][0]}">${SEV[x.severity][1]}</span><span class="badge dot ${STATUS[x.status][0]}">${STATUS[x.status][1]}</span></div>
      </div>
      <div class="card-body stack-sm">
        ${!rider ? html`<div class="row" style="gap:10px">${avatar(x.rider.name, 'sm')}<b class="grow">${x.rider.name}</b>
          ${x.rider.phone ? html`<a class="btn sm primary" href="${telHref(x.rider.phone)}">${ic('phone', 'sm')} Call rider</a>` : ''}</div>` : ''}
        ${x.description ? html`<p style="white-space:pre-line">${x.description}</p>` : html`<p class="muted">No description.</p>`}
        ${x.location ? html`<a class="contact" href="https://www.google.com/maps/search/?api=1&query=${x.location.lat},${x.location.lng}" target="_blank" rel="noopener noreferrer">${ic('gps', 'sm')} ${x.location.lat.toFixed(5)}, ${x.location.lng.toFixed(5)} (±${Math.round(x.location.accuracy || 0)} m) · open map</a>`
          : html`<span class="muted">${ic('gpsOff', 'sm')} No GPS position was available.</span>`}
        ${media(x)}
        ${x.acknowledgedBy ? html`<p class="muted" style="font-size:13px">${ic('check', 'sm')} Acknowledged by ${x.acknowledgedBy} · ${fmtDateTime(x.acknowledgedAt)}</p>` : ''}
        ${x.resolvedBy ? html`<div class="alert info">${ic('checkCircle', 'sm')}<span><b>Resolved by ${x.resolvedBy}</b> · ${fmtDateTime(x.resolvedAt)}<br>${x.resolution}</span></div>` : ''}
      </div>
      ${writer && x.status !== 'resolved' ? html`<div class="card-foot row" style="justify-content:flex-end;gap:8px">
        ${x.status === 'open' ? html`<button class="btn" data-ack="${x.id}" data-busy=" Saving…">${ic('check', 'sm')} Acknowledge</button>` : ''}
        <button class="btn primary" data-resolve="${x.id}">${ic('checkCircle', 'sm')} Resolve</button></div>` : ''}
    </section>`;
  };

  const paint = () => {
    const shown = ctx.params.id ? list.filter((x) => x.id === +ctx.params.id).concat(list.filter((x) => x.id !== +ctx.params.id)) : list;
    el.innerHTML = String(html`
      <div class="page-head">
        <div><h1>${rider ? 'My incident reports' : 'Incidents'}</h1>
          <p>${rider ? 'Emergencies you reported. Use the red SOS button any time — it works without signal and sends when you reconnect.' : 'Emergencies reported by riders, newest first. Accidents, medical and security reports are also texted to dispatch.'}</p></div>
        <div class="row wrap">${!rider && !writer ? readOnlyChip() : ''}
          ${rider ? html`<button class="btn danger solid" id="new-inc">${ic('sos', 'sm')} Report an emergency</button>` : ''}</div>
      </div>
      ${!rider ? html`<div class="seg" role="group" aria-label="Filter" style="margin-bottom:14px">${[['open', 'Open'], ['acknowledged', 'Acknowledged'], ['resolved', 'Resolved'], ['all', 'All']].map(([k, l]) => html`<button data-f="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`)}</div>` : ''}
      ${queued.length ? html`<div class="alert warn" style="margin-bottom:14px">${ic('cloud', 'sm')}<span>${queued.length} report${queued.length > 1 ? 's are' : ' is'} saved on this phone and will send when you're back online.</span></div>` : ''}
      ${shown.length ? html`<div class="grid g-2">${shown.map(card)}</div>` : html`<div class="card">${empty('checkCircle', filter === 'open' ? 'No open incidents' : 'No incidents', rider ? 'Stay safe out there.' : 'Reports from riders appear here immediately.')}</div>`}`);
    wire();
    if (ctx.params.id) el.querySelector(`#inc-${ctx.params.id}`)?.scrollIntoView({ block: 'start' });
  };

  function wire() {
    el.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', async () => { filter = b.dataset.f; await load(); paint(); }));
    el.querySelector('#new-inc')?.addEventListener('click', async () => {
      const jobs = (await api.get('/api/requests?status=open').catch(() => ({ requests: [] }))).requests.filter((r) => r.rider?.id === ctx.user.id);
      const ops = await api.get('/api/ops/settings').catch(() => null);
      if (await reportIncident({ jobs, dispatchPhone: ops?.settings?.dispatchPhone })) { await load(); paint(); }
    });
    el.querySelectorAll('[data-photo]').forEach((b) => b.addEventListener('click', () => openModal({
      title: 'Photo evidence', iconName: 'camera', wide: true, body: html`<img class="proof-full" src="${b.dataset.photo}" alt="Incident photo">`,
      actions: html`<a class="btn" href="${b.dataset.photo}" target="_blank" rel="noopener" download>${ic('download', 'sm')} Download</a><button class="btn primary" type="button" data-close>Close</button>`,
    })));
    el.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      try { await api.post(`/api/incidents/${b.dataset.ack}/ack`); toast('Acknowledged. The rider has been told.'); await load(); paint(); ctx.refreshBadges(); }
      catch (err) { toast(err.message, 'err'); }
    })));
    el.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
      const res = await openModal({
        title: 'Resolve incident', subtitle: 'Record what was done. This stays in the incident history.', iconName: 'checkCircle',
        body: html`<div class="field"><label for="res-t">Resolution</label><textarea class="input" id="res-t" name="resolution" rows="3" maxlength="1000" required autofocus placeholder="e.g. Rider treated at clinic; bike towed to garage; parcel handed to Brian to finish the delivery."></textarea></div>`,
        actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${ic('check', 'sm')} Resolve</button>`,
        onMount: ({ form, close }) => form.addEventListener('submit', (e) => { e.preventDefault(); if (form.resolution.value.trim().length >= 3) close(form.resolution.value.trim()); }),
      });
      if (!res) return;
      try { await api.post(`/api/incidents/${b.dataset.resolve}/resolve`, { resolution: res }); toast('Incident resolved.'); await load(); paint(); ctx.refreshBadges(); }
      catch (err) { toast(err.message, 'err'); }
    }));
  }

  paint();
  ctx.onLive(async () => { try { await load(); paint(); } catch {} }, ['incident']);
  const onSynced = async (e) => { if (e.detail?.kind === 'incident') { await load(); paint(); } };
  window.addEventListener('rr-synced', onSynced);
  ctx.onCleanup(() => window.removeEventListener('rr-synced', onSynced));
  ctx.poll(async () => { try { await load(); paint(); } catch {} }, 30000);
}
export { mb };
