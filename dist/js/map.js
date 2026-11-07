// Illustrative route map. Positions come from pasted pins where present; otherwise they are
// approximated from the address text. This is NOT live GPS and is labelled as such.
import { esc } from './ui.js';
import { icon } from './icons.js';

const CENTER = { lat: -1.286, lng: 36.817 };
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function approx(address) {
  const h = hash(address);
  return { lat: CENTER.lat + (((h & 0xffff) / 0xffff) - 0.5) * 0.09, lng: CENTER.lng + ((((h >>> 16) & 0xffff) / 0xffff) - 0.5) * 0.13 };
}

/** points: [{ label, address, lat, lng, kind: 'pickup'|'drop', status }] */
export function renderMap(points, { width = 640, height = 300, compact = false } = {}) {
  const pts = points.filter((p) => p.address || p.lat != null).map((p) => {
    const has = p.lat != null && p.lng != null;
    return { ...p, ...(has ? {} : approx(p.address)), approx: !has };
  });
  const W = width, H = height, pad = compact ? 34 : 46;
  let minLat = Math.min(...pts.map((p) => p.lat)), maxLat = Math.max(...pts.map((p) => p.lat));
  let minLng = Math.min(...pts.map((p) => p.lng)), maxLng = Math.max(...pts.map((p) => p.lng));
  if (!pts.length) { minLat = maxLat = CENTER.lat; minLng = maxLng = CENTER.lng; }
  const spanLat = Math.max(maxLat - minLat, 0.01), spanLng = Math.max(maxLng - minLng, 0.01);
  const scale = Math.min((W - pad * 2) / spanLng, (H - pad * 2) / spanLat);
  const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
  const X = (lng) => W / 2 + (lng - cx) * scale;
  const Y = (lat) => H / 2 - (lat - cy) * scale;

  // Decorative city texture, seeded by the route so it stays stable.
  const seed = hash(pts.map((p) => p.address).join('|'));
  const rnd = (i) => ((Math.imul(seed ^ (i * 2654435761), 1597334677) >>> 0) % 1000) / 1000;
  let deco = '';
  for (let i = 0; i < 26; i++) {
    const bx = rnd(i) * W, by = rnd(i + 99) * H, bw = 30 + rnd(i + 7) * 70, bh = 20 + rnd(i + 13) * 50;
    deco += `<rect class="map-block" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="6"/>`;
  }
  deco += `<ellipse class="map-park" cx="${(rnd(3) * W).toFixed(0)}" cy="${(rnd(4) * H).toFixed(0)}" rx="${60 + rnd(5) * 40}" ry="${30 + rnd(6) * 30}"/>`;
  const wy = H * (0.25 + rnd(8) * 0.5);
  deco += `<path class="map-water" d="M-20 ${wy} C ${W * 0.25} ${wy - 40}, ${W * 0.45} ${wy + 50}, ${W * 0.7} ${wy + 5} S ${W + 40} ${wy - 20}, ${W + 40} ${wy + 10} L ${W + 40} ${wy + 26} C ${W * 0.8} ${wy + 10}, ${W * 0.7} ${wy + 30}, ${W * 0.5} ${wy + 62} S ${W * 0.2} ${wy - 16}, -20 ${wy + 18} Z" opacity=".9"/>`;
  for (let i = 0; i < 7; i++) {
    const y = rnd(i + 40) * H, x = rnd(i + 60) * W;
    deco += `<path class="map-road" stroke-width="${i % 3 ? 5 : 8}" d="M -10 ${y.toFixed(0)} Q ${W / 2} ${(y + (rnd(i + 3) - .5) * 80).toFixed(0)} ${W + 10} ${(y + (rnd(i + 5) - .5) * 60).toFixed(0)}"/>`;
    deco += `<path class="map-road" stroke-width="${i % 2 ? 4 : 7}" d="M ${x.toFixed(0)} -10 Q ${(x + (rnd(i + 9) - .5) * 90).toFixed(0)} ${H / 2} ${(x + (rnd(i + 11) - .5) * 70).toFixed(0)} ${H + 10}"/>`;
  }
  deco += `<path class="map-road-major" stroke-width="10" d="M -10 ${(H * rnd(70)).toFixed(0)} C ${W * .3} ${H * .1}, ${W * .6} ${H * .9}, ${W + 10} ${(H * rnd(71)).toFixed(0)}"/>`;

  const coords = pts.map((p) => [X(p.lng), Y(p.lat)]);
  const route = coords.length > 1 ? `<path class="map-route" d="M ${coords.map((c) => c.map((v) => v.toFixed(1)).join(' ')).join(' L ')}"/>` : '';
  const pins = pts.map((p, i) => {
    const [x, y] = coords[i];
    const color = p.kind === 'pickup' ? 'var(--brand)' : p.status === 'delivered' ? 'var(--st-delivered)' : p.status === 'failed' ? 'var(--danger)' : '#1f2a4d';
    const name = compact ? '' : `<text class="map-pin-name" x="${(x + 16).toFixed(1)}" y="${(y - 14).toFixed(1)}">${esc((p.address || '').split(',')[0].slice(0, 26))}${p.approx ? ' ≈' : ''}</text>`;
    return `<g><title>${esc(p.address || '')}${p.approx ? ' (approximate position)' : ''}</title>
      <ellipse cx="${x.toFixed(1)}" cy="${(y + 2).toFixed(1)}" rx="7" ry="2.5" fill="rgba(0,0,0,.18)"/>
      <path d="M ${x} ${y} c -3 -6 -11 -10 -11 -18 a 11 11 0 0 1 22 0 c 0 8 -8 12 -11 18 z" fill="${color}" stroke="#fff" stroke-width="2" ${p.approx ? 'stroke-dasharray="3 2"' : ''}/>
      <text class="map-pin-label" x="${x.toFixed(1)}" y="${(y - 14.5).toFixed(1)}" text-anchor="middle">${esc(p.label)}</text>${name}</g>`;
  }).join('');
  const anyApprox = pts.some((p) => p.approx);
  return `<div class="map"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Illustrative route map with ${pts.length} stops">
    <rect class="map-land" width="${W}" height="${H}"/>${deco}${route}${pins}</svg>
    <span class="tag">${icon('gpsOff', 'sm')} Illustrative map · not live GPS${anyApprox ? ' · ≈ approximate' : ''}</span></div>`;
}

export function requestPoints(r) {
  return [
    { label: 'P', kind: 'pickup', address: r.pickup.address, lat: r.pickup.lat, lng: r.pickup.lng },
    ...r.dropoffs.map((d, i) => ({ label: String(i + 1), kind: 'drop', address: d.address, lat: d.lat, lng: d.lng, status: d.status })),
  ];
}
