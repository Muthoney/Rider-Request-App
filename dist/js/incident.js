// Emergency / incident report (riders). One tap from anywhere in the rider app.
// Reports always go through the offline queue: with signal they reach dispatch in seconds (and dispatch
// is texted at once for accidents, medical and security emergencies); without signal they are kept on
// the phone, with their photos, video and GPS, and sent automatically when the connection returns.
import { html, ic, openModal, toast, telHref } from './ui.js';
import { downscale } from './capture.js';
import { enqueue, storeBlob, uid, flush, syncStatus } from './offline.js';
import { currentPosition } from './native.js';
import { lastPosition } from './tracker.js';

export const INCIDENT_TYPES = {
  accident: { label: 'Road accident', icon: 'alert' },
  breakdown: { label: 'Vehicle breakdown', icon: 'bike' },
  medical: { label: 'Medical emergency', icon: 'plus' },
  security: { label: 'Security incident', icon: 'shield' },
  other: { label: 'Other emergency', icon: 'sos' },
};
const VIDEO_MAX = 30 * 1024 * 1024;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** Opens the report dialog. `jobs`: the rider's active requests (to link one); `dispatchPhone` for the call button. */
export async function reportIncident({ jobs = [], requestId = null, dispatchPhone = null } = {}) {
  let gps = null;
  const photos = [];
  let video = null;
  const gpsPromise = currentPosition({ timeout: 10000 }).then((p) => p || lastPosition());
  const data = await openModal({
    title: 'Report an emergency', subtitle: 'Dispatch is alerted straight away. If anyone is hurt, call 999 or 112 first.', iconName: 'sos', tone: 'danger',
    body: html`
      <div class="row wrap" style="gap:8px">
        <a class="btn danger solid" href="tel:999">${ic('phone', 'sm')} Call 999</a>
        <a class="btn danger" href="tel:112">${ic('phone', 'sm')} 112</a>
        ${dispatchPhone ? html`<a class="btn" href="${telHref(dispatchPhone)}">${ic('phone', 'sm')} Call dispatch</a>` : ''}
      </div>
      <div class="field"><span class="label">What happened?</span>
        <div class="inc-types" role="radiogroup" aria-label="Type of emergency">${Object.entries(INCIDENT_TYPES).map(([k, t], i) => html`
          <label class="inc-type"><input type="radio" name="type" value="${k}" ${i === 0 ? 'checked' : ''}>${ic(t.icon, 'sm')}<span>${t.label}</span></label>`)}</div></div>
      ${jobs.length ? html`<div class="field"><label for="inc-job">Delivery affected</label>
        <select class="input" id="inc-job" name="requestId"><option value="">None / not on a delivery</option>
          ${jobs.map((j) => html`<option value="${j.id}" ${j.id === requestId || (jobs.length === 1 && !requestId) ? 'selected' : ''}>${j.ref} · ${j.title}</option>`)}</select></div>` : ''}
      <div class="field"><label for="inc-desc">Short description <span class="muted">(optional)</span></label>
        <textarea class="input" id="inc-desc" name="description" maxlength="1000" rows="3" placeholder="e.g. Hit by a matatu at the Museum Hill roundabout. Bike damaged, I am OK."></textarea></div>
      <div class="field"><span class="label">${ic('camera', 'sm')} Photos <span class="muted">(up to 4)</span></span>
        <div class="row wrap" style="gap:8px">
          <label class="btn">${ic('camera', 'sm')} Add photo<input type="file" accept="image/*" capture="environment" data-inc-photo hidden></label>
          <label class="btn">${ic('video', 'sm')} Record video<input type="file" accept="video/*" capture="environment" data-inc-video hidden></label>
        </div>
        <div class="inc-media" data-inc-media></div></div>
      <div class="gps-line" data-inc-gps>${ic('gps', 'sm')} Getting your location…</div>
      <p class="error-text" id="inc-err" hidden></p>`,
    actions: html`<button type="button" class="btn" data-close>Cancel</button><button class="btn danger solid" type="submit">${ic('send', 'sm')} Send report</button>`,
    onMount: ({ form, close }) => {
      const media = form.querySelector('[data-inc-media]');
      const showMedia = () => {
        media.innerHTML = String(html`${photos.map((p, i) => html`<span class="inc-thumb"><img src="${p}" alt="Photo ${i + 1}"><button type="button" data-rm="${i}" aria-label="Remove photo">${ic('x', 'sm')}</button></span>`)}
          ${video ? html`<span class="inc-thumb vid">${ic('video')}<small>${mb(video.size)}</small><button type="button" data-rmv aria-label="Remove video">${ic('x', 'sm')}</button></span>` : ''}`);
        media.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { photos.splice(+b.dataset.rm, 1); showMedia(); }));
        media.querySelector('[data-rmv]')?.addEventListener('click', () => { video = null; showMedia(); });
      };
      form.querySelector('[data-inc-photo]').addEventListener('change', async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        if (photos.length >= 4) { toast('Up to 4 photos.', 'warn'); return; }
        try { photos.push(await downscale(f)); showMedia(); } catch { toast('That photo could not be read.', 'err'); }
      });
      form.querySelector('[data-inc-video]').addEventListener('change', (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        if (f.size > VIDEO_MAX) { toast(`That video is ${mb(f.size)}. Keep it under 30 MB (about 30 seconds).`, 'warn'); return; }
        if (!/^video\/(mp4|webm|3gpp|quicktime)$/.test(f.type)) { toast('Use the camera to record an MP4/3GP video.', 'warn'); return; }
        video = f; showMedia();
      });
      gpsPromise.then((p) => {
        gps = p;
        const line = form.querySelector('[data-inc-gps]');
        if (line) line.innerHTML = String(p ? html`${ic('gps', 'sm')} Location attached (±${Math.round(p.accuracy || 0)} m)` : html`${ic('gpsOff', 'sm')} No GPS fix — describe where you are.`);
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        close({ type: form.type.value, description: form.description.value.trim() || null, requestId: form.requestId?.value ? Number(form.requestId.value) : null });
      });
    },
  });
  if (!data) return null;
  if (!gps) gps = await Promise.race([gpsPromise, new Promise((r) => setTimeout(() => r(null), 1500))]);
  const clientId = uid();
  const mediaEntries = video ? [{ blobId: await storeBlob(video), mime: video.type }] : [];
  await enqueue({
    id: clientId, kind: 'incident', method: 'POST', url: '/api/incidents', label: `${INCIDENT_TYPES[data.type].label} report`, requestId: data.requestId,
    body: { clientId, ...data, photos, occurredAt: new Date().toISOString(), ...(gps ? { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy } : {}) },
    media: mediaEntries,
  });
  await flush();
  const s = syncStatus();
  toast(s.online && !s.pending ? 'Emergency reported. Dispatch has been alerted.' : 'No connection: your report is saved and will send automatically. Call 999/112 or dispatch if urgent.', s.online && !s.pending ? 'ok' : 'warn');
  return true;
}
