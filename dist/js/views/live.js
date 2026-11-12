// Live map for dispatch: Google Maps (Kenya) with every clocked-in rider's latest GPS position, coloured by
// status, the pickups and drop-offs of their active jobs with the route between them, and open emergencies.
// Updates arrive over the live event stream; a slower poll is the safety net.
import { api } from '../api.js';
import { html, ic, avatar, tagBadges, timeAgo, telHref, statusBadge, urgentBadge, empty, fmtDateTime } from '../ui.js';
import { createGoogleMap, googleMapsEnabled, AVAIL_COLORS } from '../gmaps.js';
import { renderMap } from '../map.js';
import { availBadge, ratingBadge } from './actions.js';
import { INCIDENT_TYPES } from '../incident.js';

const STALE_MS = 5 * 60e3;
const initials = (n) => n.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const LEGEND = [['available', 'Available'], ['assigned', 'Assigned'], ['on_delivery', 'On delivery'], ['on_break', 'On break'], ['unresponsive', 'No recent GPS']];

export async function render(el, ctx) {
  let data = await api.get('/api/live');
  let gmap = null;
  let selected = null;
  const useGoogle = await googleMapsEnabled();

  el.innerHTML = String(html`
    <div class="page-head">
      <div><h1>Live map</h1><p>Clocked-in riders, their active jobs and routes, and open emergencies. Updates as riders move.</p></div>
      <div class="row wrap"><span class="muted" id="updated" style="font-size:12.5px"></span><button class="icon-btn" id="refresh" aria-label="Refresh">${ic('refresh')}</button></div>
    </div>
    ${useGoogle ? '' : html`<div class="alert info" style="margin-bottom:16px">${ic('pin', 'sm')}<span>Google Maps isn't configured, so positions are drawn on an illustrative map. Set <code>GOOGLE_MAPS_BROWSER_KEY</code> on the server to show the real map, routes and traffic-aware times.</span></div>`}
    <div class="legend">${LEGEND.map(([k, l]) => html`<span><i style="background:${AVAIL_COLORS[k]}"></i>${l}</span>`)}<span><i class="sq" style="background:#12a150"></i>Pickup</span><span><i class="sq" style="background:#1f2a4d"></i>Drop-off</span><span><i style="background:#dc2626"></i>Emergency</span></div>
    <div id="inc-strip"></div>
    <div class="live-grid">
      <section class="card live-map"><div id="map" class="${useGoogle ? 'gmap' : ''}"></div></section>
      <aside class="card live-list"><div class="card-head"><h3>Riders</h3><span class="muted" id="count"></span></div><div id="list"></div></aside>
    </div>`);

  const mapHost = el.querySelector('#map');
  if (useGoogle) gmap = await createGoogleMap(mapHost, { zoom: 12, onMarkerClick: (id) => select(id) });

  const isStale = (r) => !r.location || Date.now() - new Date(r.location.recordedAt) > STALE_MS;
  const colorOf = (r) => (isStale(r) || r.unresponsive ? AVAIL_COLORS.unresponsive : AVAIL_COLORS[r.availability] || AVAIL_COLORS.available);

  function paintMap() {
    const live = data.riders.filter((r) => r.onShift && r.location);
    const incidents = (data.incidents || []).filter((i) => i.location);
    if (gmap) {
      const markers = live.map((r) => ({
        id: `r${r.id}`, kind: 'rider', label: initials(r.name), lat: r.location.lat, lng: r.location.lng, color: colorOf(r),
        title: String(html`<b>${r.name}</b><br>${r.availability?.replace('_', ' ')} · ${r.jobs.length} active job${r.jobs.length === 1 ? '' : 's'} · GPS ${timeAgo(r.location.recordedAt)}`),
      }));
      const routes = [];
      for (const r of data.riders) for (const j of r.jobs) {
        const todo = (j.stops || []).filter((s) => !s.done && s.lat != null);
        todo.forEach((s) => markers.push({
          id: `j${j.id}-${s.kind}${s.seq}`, kind: s.kind === 'pickup' ? 'pickup' : 'drop', label: s.kind === 'pickup' ? 'P' : String(s.seq),
          lat: s.lat, lng: s.lng, title: String(html`<b>${j.ref}</b> ${j.title}<br>${s.kind === 'pickup' ? 'Pickup' : `Drop-off ${s.seq}`}: ${s.address}<br>Rider: ${r.name}`),
        }));
        const from = r.location && r.onShift ? [{ lat: r.location.lat, lng: r.location.lng }] : [];
        if (todo.length && (selected == null || selected === r.id)) routes.push({ id: `j${j.id}`, coords: [...from, ...todo.map((s) => ({ lat: s.lat, lng: s.lng }))], color: colorOf(r) });
      }
      incidents.forEach((i) => markers.push({
        id: `i${i.id}`, kind: 'incident', color: '#dc2626', label: 'SOS', lat: i.location.lat, lng: i.location.lng,
        title: String(html`<b>${INCIDENT_TYPES[i.type]?.label}</b> · ${i.rider.name}<br>${fmtDateTime(i.createdAt)}<br><a href="#/incidents/${i.id}">Open report</a>`),
      }));
      gmap.setMarkers(markers);
      gmap.setRoutes(routes);
    } else {
      const pts = [
        ...live.map((r) => ({ kind: 'rider', label: initials(r.name), address: r.name, lat: r.location.lat, lng: r.location.lng, color: colorOf(r) })),
        ...incidents.map((i) => ({ kind: 'drop', status: 'failed', label: '!', address: `${INCIDENT_TYPES[i.type]?.label}: ${i.rider.name}`, lat: i.location.lat, lng: i.location.lng })),
      ];
      mapHost.innerHTML = pts.length ? renderMap(pts, { width: 760, height: 460, live: true })
        : String(html`<div class="map" style="height:300px;display:grid;place-items:center;color:var(--muted)">${ic('gpsOff')} No live positions yet</div>`);
    }
  }

  function paintIncidents() {
    const open = data.incidents || [];
    el.querySelector('#inc-strip').innerHTML = String(open.length ? html`<div class="alert err" style="margin-bottom:14px">${ic('sos', 'sm')}<span class="grow"><b>${open.length} open emergenc${open.length > 1 ? 'ies' : 'y'}:</b>
      ${open.slice(0, 3).map((i) => html` <a href="#/incidents/${i.id}">${INCIDENT_TYPES[i.type]?.label} · ${i.rider.name} (${timeAgo(i.createdAt)})</a>`)}</span><a class="btn sm" href="#/incidents">View all</a></div>` : '');
  }

  function paintList() {
    const on = data.riders.filter((r) => r.onShift);
    const s = data.summary || {};
    el.querySelector('#count').textContent = `${on.length} clocked in · ${s.readyNow ?? 0} ready`;
    el.querySelector('#updated').textContent = `Updated ${new Date(data.serverTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    el.querySelector('#list').innerHTML = String(data.riders.length ? html`<div class="list">${data.riders.map((r) => html`
      <div class="list-item live-rider ${selected === r.id ? 'sel' : ''} ${r.onShift ? '' : 'off'}" data-r="${r.id}" tabindex="0" role="button" aria-label="Show ${r.name} on the map">
        <span class="av-dot" style="--c:${r.onShift ? colorOf(r) : '#c4c9d6'}">${avatar(r.name, 'sm')}</span>
        <div class="grow">
          <b>${r.name}</b> ${tagBadges(r.tags)} ${ratingBadge(r)}
          <div class="row wrap" style="gap:4px;margin:3px 0">${availBadge(r)}</div>
          <div class="req-sub">${!r.onShift ? 'Clocked out'
            : r.location ? html`GPS ${timeAgo(r.location.recordedAt)}${r.location.speed != null ? ` · ${Math.round(r.location.speed)} km/h` : ''}${r.location.accuracy ? ` · ±${Math.round(r.location.accuracy)} m` : ''}`
              : 'Clocked in · waiting for GPS'}${r.lastActivityAt ? ` · last action ${timeAgo(r.lastActivityAt)}` : ''}</div>
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
    if (typeof id === 'string' && !id.startsWith('r')) return false;
    const next = typeof id === 'string' ? Number(id.replace(/^r/, '')) || selected : id;
    selected = selected === next ? null : next;
    if (gmap && selected) gmap.focus(`r${selected}`);
    paintMap(); paintList();
  }

  const refresh = async () => { data = await api.get('/api/live'); if (ctx.isCurrent()) { paintMap(); paintList(); paintIncidents(); } };
  el.querySelector('#refresh').addEventListener('click', () => refresh().catch(() => {}));
  paintMap(); paintList(); paintIncidents();
  ctx.onLive(() => refresh().catch(() => {}), ['location', 'riders', 'incident', 'change']);
  ctx.poll(() => refresh().catch(() => {}), 20000);
  ctx.onCleanup(() => gmap?.destroy());
}
