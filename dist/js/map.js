// Route maps. With a Google Maps key the route is drawn on a real Google map (restricted to Kenya)
// with the rider's live GPS position. Without one, an illustrative SVG map is drawn instead.
// Stops are positioned from their pin when present; otherwise from the Kenyan landmark, street,
// area or town named in the address (marked ≈ approximate). Stops that name nothing known in
// Kenya are left off the map rather than placed at random.
import { esc } from './ui.js';
import { icon } from './icons.js';
import { lookupPlace, NAIROBI } from './kenya.js';
import { createGoogleMap, googleMapsEnabled } from './gmaps.js';

function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Gives each point lat/lng: exact pin, else Kenyan place lookup (approx), else null (unplaced). */
export function placePoints(points) {
  return points.filter((p) => p.address || p.lat != null).map((p) => {
    if (p.lat != null && p.lng != null) return { ...p, approx: false };
    const place = lookupPlace(p.address);
    return place ? { ...p, lat: place.lat, lng: place.lng, approx: true, placeName: place.name } : { ...p, unplaced: true };
  });
}

const PIN_COLOR = (p) => p.kind === 'pickup' ? 'var(--brand)' : p.kind === 'rider' ? 'var(--series-1)'
  : p.status === 'delivered' ? 'var(--st-delivered)' : p.status === 'failed' ? 'var(--danger)' : '#1f2a4d';

/** points: [{ label, address, lat, lng, kind: 'pickup'|'drop'|'rider', status }] → SVG map HTML */
export function renderMap(points, { width = 640, height = 300, compact = false, live = false } = {}) {
  const all = placePoints(points);
  const pts = all.filter((p) => !p.unplaced);
  const unplaced = all.length - pts.length;
  const W = width, H = height, pad = compact ? 34 : 46;
  let minLat = Math.min(...pts.map((p) => p.lat)), maxLat = Math.max(...pts.map((p) => p.lat));
  let minLng = Math.min(...pts.map((p) => p.lng)), maxLng = Math.max(...pts.map((p) => p.lng));
  if (!pts.length) { minLat = maxLat = NAIROBI.lat; minLng = maxLng = NAIROBI.lng; }
  const spanLat = Math.max(maxLat - minLat, 0.01), spanLng = Math.max(maxLng - minLng, 0.01);
  const scale = Math.min((W - pad * 2) / spanLng, (H - pad * 2) / spanLat);
  const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
  const X = (lng) => W / 2 + (lng - cx) * scale;
  const Y = (lat) => H / 2 - (lat - cy) * scale;

  // Decorative city texture, seeded by the route so it stays stable.
  const seed = hash(pts.filter((p) => p.kind !== 'rider').map((p) => p.address).join('|'));
  const rnd = (i) => ((Math.imul(seed ^ (i * 2654435761), 1597334677) >>> 0) % 1000) / 1000;
  let deco = '';
  for (let i = 0; i < 26; i++) {
    const bx = rnd(i) * W, by = rnd(i + 99) * H, bw = 30 + rnd(i + 7) * 70, bh = 20 + rnd(i + 13) * 50;
    deco += `<rect class="map-block" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="6"/>`;
  }
  deco += `<ellipse class="map-park" cx="${(rnd(3) * W).toFixed(0)}" cy="${(rnd(4) * H).toFixed(0)}" rx="${60 + rnd(5) * 40}" ry="${30 + rnd(6) * 30}"/>`;
  for (let i = 0; i < 7; i++) {
    const y = rnd(i + 40) * H, x = rnd(i + 60) * W;
    deco += `<path class="map-road" stroke-width="${i % 3 ? 5 : 8}" d="M -10 ${y.toFixed(0)} Q ${W / 2} ${(y + (rnd(i + 3) - .5) * 80).toFixed(0)} ${W + 10} ${(y + (rnd(i + 5) - .5) * 60).toFixed(0)}"/>`;
    deco += `<path class="map-road" stroke-width="${i % 2 ? 4 : 7}" d="M ${x.toFixed(0)} -10 Q ${(x + (rnd(i + 9) - .5) * 90).toFixed(0)} ${H / 2} ${(x + (rnd(i + 11) - .5) * 70).toFixed(0)} ${H + 10}"/>`;
  }

  const stops = pts.filter((p) => p.kind !== 'rider');
  const coords = stops.map((p) => [X(p.lng), Y(p.lat)]);
  const route = coords.length > 1 ? `<path class="map-route" d="M ${coords.map((c) => c.map((v) => v.toFixed(1)).join(' ')).join(' L ')}"/>` : '';
  const pins = pts.map((p) => {
    const x = X(p.lng), y = Y(p.lat);
    if (p.kind === 'rider') {
      const c = /^#[0-9a-f]{3,8}$/i.test(p.color || '') ? p.color : 'var(--series-1)';
      return `<g><title>${esc(p.address || 'Rider')} (GPS)</title><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16" fill="${c}" opacity=".18"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${c}" stroke="#fff" stroke-width="3"/></g>`;
    }
    const name = compact ? '' : `<text class="map-pin-name" x="${(x + 16).toFixed(1)}" y="${(y - 14).toFixed(1)}">${esc((p.address || '').split(',')[0].slice(0, 26))}${p.approx ? ' ≈' : ''}</text>`;
    return `<g><title>${esc(p.address || '')}${p.approx ? ` (approximate: ${esc(p.placeName)})` : ''}</title>
      <ellipse cx="${x.toFixed(1)}" cy="${(y + 2).toFixed(1)}" rx="7" ry="2.5" fill="rgba(0,0,0,.18)"/>
      <path d="M ${x} ${y} c -3 -6 -11 -10 -11 -18 a 11 11 0 0 1 22 0 c 0 8 -8 12 -11 18 z" fill="${PIN_COLOR(p)}" stroke="#fff" stroke-width="2" ${p.approx ? 'stroke-dasharray="3 2"' : ''}/>
      <text class="map-pin-label" x="${x.toFixed(1)}" y="${(y - 14.5).toFixed(1)}" text-anchor="middle">${esc(p.label)}</text>${name}</g>`;
  }).join('');
  const anyApprox = pts.some((p) => p.approx);
  const notes = [live ? 'Rider position: live GPS' : 'Illustrative map', anyApprox ? '≈ from landmark/street' : '', unplaced ? `${unplaced} stop${unplaced > 1 ? 's' : ''} not placed` : ''].filter(Boolean);
  return `<div class="map"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Route map with ${stops.length} stops">
    <rect class="map-land" width="${W}" height="${H}"/>${deco}${route}${pins}</svg>
    <span class="tag">${icon(live ? 'gps' : 'pin', 'sm')} ${esc(notes.join(' · '))}</span></div>`;
}

export function requestPoints(r) {
  return [
    ...(r.pickups || [{ ...r.pickup, seq: 1 }]).map((p, i, all) => ({
      label: all.length > 1 ? `P${i + 1}` : 'P', kind: 'pickup', address: p.address, lat: p.lat, lng: p.lng, status: p.collected ? 'delivered' : undefined,
    })),
    ...r.dropoffs.map((d, i) => ({ label: String(i + 1), kind: 'drop', address: d.address, lat: d.lat, lng: d.lng, status: d.status })),
  ];
}

/**
 * Mounts a route map into `host`: Google Maps when configured, otherwise the SVG map.
 * Returns { update(points, { rider, path }), google: boolean }.
 */
export async function mountRouteMap(host, points, { height = 300, width = 400, rider = null, path = [] } = {}) {
  const google = await googleMapsEnabled();
  if (google) {
    host.innerHTML = `<div class="map gmap-wrap"><div class="gmap" style="height:${height}px"></div><span class="tag" data-tag></span></div>`;
    const ctl = await createGoogleMap(host.querySelector('.gmap'));
    if (ctl) {
      const update = (pts, live = {}) => {
        const placed = placePoints(pts).filter((p) => !p.unplaced);
        const markers = placed.map((p) => ({
          id: `${p.kind}-${p.label}`, lat: p.lat, lng: p.lng, label: p.label, kind: p.kind === 'drop' && p.status ? (p.status === 'pending' ? 'drop' : p.status) : p.kind,
          approx: p.approx, title: esc(`${p.address}${p.approx ? ` (≈ ${p.placeName})` : ''}`),
        }));
        if (live.rider) markers.push({ id: 'rider', kind: 'rider', label: '🏍', lat: live.rider.lat, lng: live.rider.lng, title: esc(`${live.rider.name} · GPS ${new Date(live.rider.recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`) });
        ctl.setMarkers(markers);
        // While the rider is live, route from the rider through the stops still to do (navigation view).
        const todo = placed.filter((p) => p.kind !== 'rider' && p.status !== 'delivered');
        ctl.setRoute(live.rider && todo.length ? [{ lat: live.rider.lat, lng: live.rider.lng }, ...todo] : placed.filter((p) => p.kind !== 'rider'),
          live.rider ? { color: '#2a78d6' } : undefined);
        ctl.setPath(live.path || []);
        const tag = host.querySelector('[data-tag]');
        tag.innerHTML = `${icon(live.rider ? 'gps' : 'pin', 'sm')} ${live.rider ? 'Rider live on GPS' : 'Google Maps · Kenya'}${placed.some((p) => p.approx) ? ' · ≈ from landmark/street' : ''}`;
      };
      update(points, { rider, path });
      return { update, google: true };
    }
  }
  const draw = (pts, live = {}) => {
    const all = live.rider ? [...pts, { kind: 'rider', label: 'R', address: live.rider.name, lat: live.rider.lat, lng: live.rider.lng }] : pts;
    host.innerHTML = renderMap(all, { width, height: Math.round(height * 0.93), live: !!live.rider });
  };
  draw(points, { rider });
  return { update: draw, google: false };
}
