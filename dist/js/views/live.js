// Live rider map for dispatch: Google Maps (Kenya) with each on-shift rider's latest GPS position.
import { api } from '../api.js';
import { html, ic, raw, avatar, tagBadges, timeAgo, telHref, statusBadge, urgentBadge, empty } from '../ui.js';
import { createGoogleMap, googleMapsEnabled } from '../gmaps.js';
import { renderMap } from '../map.js';

const STALE_MS = 5 * 60e3;
const initials = (n) => n.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

export async function render(el, ctx) {
  let data = await api.get('/api/live');
  let gmap = null;
  let selected = null;
  const useGoogle = await googleMapsEnabled();

  el.innerHTML = String(html`
    <div class="page-head">
      <div><h1>Live map</h1><p>Riders on shift share their GPS position from the app. Positions refresh every 10 seconds.</p></div>
      <div class="row wrap"><span class="muted" id="updated" style="font-size:12.5px"></span><button class="icon-btn" id="refresh" aria-label="Refresh">${ic('refresh')}</button></div>
    </div>
    ${useGoogle ? '' : html`<div class="alert info" style="margin-bottom:16px">${ic('pin', 'sm')}<span>Google Maps isn't configured, so positions are drawn on an illustrative map. Set <code>GOOGLE_MAPS_BROWSER_KEY</code> on the server to show the real map.</span></div>`}
    <div class="live-grid">
      <section class="card live-map"><div id="map" class="${useGoogle ? 'gmap' : ''}"></div></section>
      <aside class="card live-list"><div class="card-head"><h3>Riders</h3><span class="muted" id="count"></span></div><div id="list"></div></aside>
    </div>`);

  const mapHost = el.querySelector('#map');
  if (useGoogle) gmap = await createGoogleMap(mapHost, { zoom: 12, onMarkerClick: (id) => select(id) });

  const isStale = (r) => !r.location || Date.now() - new Date(r.location.recordedAt) > STALE_MS;

  function paintMap() {
    const live = data.riders.filter((r) => r.onShift && r.location);
    if (gmap) {
      const markers = live.map((r) => ({
        id: `r${r.id}`, kind: 'rider', label: initials(r.name), lat: r.location.lat, lng: r.location.lng,
        color: isStale(r) ? '#8e95aa' : '#2a78d6',
        title: String(html`<b>${r.name}</b><br>${r.jobs.length} open job${r.jobs.length === 1 ? '' : 's'} · GPS ${timeAgo(r.location.recordedAt)}`),
      }));
      // Show the next stop of each rider's jobs.
      for (const r of live) for (const j of r.jobs) {
        if (j.next?.lat != null) markers.push({ id: `j${j.id}`, kind: j.next.kind === 'pickup' ? 'pickup' : 'drop', label: j.next.kind === 'pickup' ? 'P' : String(j.next.seq || ''), lat: j.next.lat, lng: j.next.lng, title: String(html`<b>${j.ref}</b> ${j.title}<br>${j.next.address}`) });
      }
      gmap.setMarkers(markers);
    } else {
      const pts = live.map((r) => ({ kind: 'rider', label: initials(r.name), address: r.name, lat: r.location.lat, lng: r.location.lng }));
      mapHost.innerHTML = pts.length ? renderMap(pts, { width: 760, height: 460, live: true })
        : String(html`<div class="map" style="height:300px;display:grid;place-items:center;color:var(--muted)">${ic('gpsOff')} No live positions yet</div>`);
    }
  }

  function paintList() {
    const on = data.riders.filter((r) => r.onShift);
    el.querySelector('#count').textContent = `${on.length} on shift`;
    el.querySelector('#updated').textContent = `Updated ${new Date(data.serverTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    el.querySelector('#list').innerHTML = String(data.riders.length ? html`<div class="list">${data.riders.map((r) => html`
      <div class="list-item live-rider ${selected === r.id ? 'sel' : ''} ${r.onShift ? '' : 'off'}" data-r="${r.id}" tabindex="0" role="button" aria-label="Show ${r.name} on the map">
        ${avatar(r.name, 'sm')}
        <div class="grow">
          <b>${r.name}</b> ${tagBadges(r.tags)}
          <div class="req-sub">${!r.onShift ? html`<span class="offshift"></span>Off shift`
            : r.location ? html`<span class="${isStale(r) ? 'offshift' : 'onshift'}"></span>GPS ${timeAgo(r.location.recordedAt)}${r.location.speed != null ? ` · ${Math.round(r.location.speed)} km/h` : ''}${r.location.accuracy ? ` · ±${Math.round(r.location.accuracy)} m` : ''}`
              : html`<span class="offshift"></span>On shift · waiting for GPS`}</div>
          ${r.jobs.map((j) => html`<a class="live-job" href="#/requests/${j.id}">${statusBadge(j.status)}${urgentBadge(j.priority)}<span class="mono">${j.ref}</span> <span class="t">${j.next?.address ? `→ ${j.next.address}` : j.title}</span></a>`)}
        </div>
        ${r.phone ? html`<a class="icon-btn" href="${telHref(r.phone)}" aria-label="Call ${r.name}">${ic('phone', 'sm')}</a>` : ''}
      </div>`)}</div>` : empty('bike', 'No riders', 'Add rider accounts to see them here.'));
    el.querySelectorAll('[data-r]').forEach((row) => {
      const go = () => select(+row.dataset.r);
      row.addEventListener('click', (e) => { if (!e.target.closest('a')) go(); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  function select(id) {
    selected = typeof id === 'string' ? Number(id.replace(/^r/, '')) || selected : id;
    if (gmap) gmap.focus(`r${selected}`);
    paintList();
  }

  const refresh = async () => { data = await api.get('/api/live'); if (ctx.isCurrent()) { paintMap(); paintList(); } };
  el.querySelector('#refresh').addEventListener('click', () => refresh().catch(() => {}));
  paintMap(); paintList();
  ctx.poll(() => refresh().catch(() => {}), 10000);
  ctx.onCleanup(() => gmap?.destroy());
}
