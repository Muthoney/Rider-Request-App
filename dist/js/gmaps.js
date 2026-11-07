// Google Maps JavaScript API wrapper. Loaded only when the server has a browser key configured.
// Maps are restricted to Kenya. Without a key (or if Google fails to load) callers fall back to the
// illustrative SVG map in map.js.
import { getConfig } from './config.js';
import { KENYA_BOUNDS, NAIROBI } from './kenya.js';

let loading = null;
let authFailed = false;

export async function googleMapsEnabled() {
  const c = await getConfig();
  return !!c.maps.browserKey && !authFailed;
}

export function loadGoogleMaps() {
  if (loading) return loading;
  loading = (async () => {
    const c = await getConfig();
    if (!c.maps.browserKey || authFailed) return null;
    if (!window.google?.maps?.importLibrary) {
      await new Promise((resolve, reject) => {
        window.__rrMapsReady = resolve;
        window.gm_authFailure = () => { authFailed = true; window.dispatchEvent(new CustomEvent('rr-maps-auth-failed')); };
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(c.maps.browserKey)}&v=weekly&loading=async&region=KE&language=en&callback=__rrMapsReady`;
        s.async = true;
        s.onerror = () => reject(new Error('Google Maps could not be loaded.'));
        document.head.append(s);
      });
    }
    const [maps, marker] = await Promise.all([google.maps.importLibrary('maps'), google.maps.importLibrary('marker')]);
    return { maps, marker, mapId: c.maps.mapId };
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

const COLORS = { pickup: '#12a150', drop: '#1f2a4d', delivered: '#16a34a', failed: '#dc2626', rider: '#2a78d6', riderOff: '#8e95aa' };

function pinElement(m) {
  const el = document.createElement('div');
  el.className = `gpin ${m.kind === 'rider' ? 'rider' : ''} ${m.approx ? 'approx' : ''}`;
  el.style.setProperty('--c', m.color);
  el.textContent = m.label;
  el.title = m.title || '';
  return el;
}

/**
 * Creates a Google map inside `el`. Returns a controller:
 *   setMarkers([{ id, lat, lng, label, kind, color?, title?, approx? }]) — diffed by id, so live positions move smoothly
 *   setPath([{lat,lng}]), setRoute([{lat,lng}]), fit(), destroy()
 * Resolves to null when Google Maps is not available.
 */
export async function createGoogleMap(el, { zoom = 12, onMarkerClick } = {}) {
  const g = await loadGoogleMaps().catch(() => null);
  if (!g) return null;
  const { Map: GoogleMap, Polyline, InfoWindow } = g.maps;
  const advanced = !!g.mapId;
  const map = new GoogleMap(el, {
    center: NAIROBI, zoom, mapId: g.mapId || undefined,
    restriction: { latLngBounds: KENYA_BOUNDS, strictBounds: false },
    streetViewControl: false, mapTypeControl: false, fullscreenControl: true, clickableIcons: false, gestureHandling: 'cooperative',
  });
  const info = new InfoWindow();
  const markers = new Map();
  let path = null, route = null;
  let fitted = false;

  function makeMarker(m) {
    const color = m.color || COLORS[m.kind] || COLORS.drop;
    let mk;
    if (advanced) {
      mk = new g.marker.AdvancedMarkerElement({ map, position: m, content: pinElement({ ...m, color }), title: m.title || '' });
    } else {
      const rider = m.kind === 'rider';
      mk = new g.marker.Marker({
        map, position: m, title: m.title || '', zIndex: rider ? 10 : 1,
        label: { text: m.label, color: '#fff', fontWeight: '700', fontSize: '11px' },
        icon: rider
          ? { path: google.maps.SymbolPath.CIRCLE, scale: 13, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 }
          : { path: 'M0 0C-3-6-11-10-11-18A11 11 0 0 1 11-18C11-10 3-6 0 0Z', fillColor: color, fillOpacity: m.approx ? 0.75 : 1,
            strokeColor: '#fff', strokeWeight: 2, scale: 1.1, labelOrigin: new google.maps.Point(0, -18) },
      });
    }
    const click = () => {
      if (onMarkerClick) return onMarkerClick(m.id);
      if (m.title) { info.setContent(m.title); info.open({ map, anchor: mk }); }
    };
    mk.addListener('click', click);
    return { mk, data: m };
  }
  const setPos = (entry, m) => { if (advanced) entry.mk.position = m; else entry.mk.setPosition(m); };
  const remove = (entry) => { if (advanced) entry.mk.map = null; else entry.mk.setMap(null); };

  const ctl = {
    map,
    setMarkers(list) {
      const seen = new Set();
      for (const m of list.filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng))) {
        seen.add(m.id);
        const cur = markers.get(m.id);
        if (cur && cur.data.label === m.label && cur.data.color === m.color && cur.data.kind === m.kind) { setPos(cur, m); cur.data = m; }
        else { if (cur) remove(cur); markers.set(m.id, makeMarker(m)); }
      }
      for (const [id, entry] of markers) if (!seen.has(id)) { remove(entry); markers.delete(id); }
      if (!fitted) { ctl.fit(); fitted = markers.size > 0; }
    },
    setPath(coords) {
      if (path) path.setMap(null);
      path = coords.length > 1 ? new Polyline({ map, path: coords, strokeColor: COLORS.rider, strokeOpacity: 0.85, strokeWeight: 4 }) : null;
    },
    setRoute(coords) {
      if (route) route.setMap(null);
      route = coords.length > 1 ? new Polyline({
        map, path: coords, strokeOpacity: 0,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: COLORS.pickup, scale: 3 }, offset: '0', repeat: '14px' }],
      }) : null;
    },
    fit() {
      const pts = [...markers.values()].map((e) => e.data);
      if (!pts.length) return;
      if (pts.length === 1) { map.setCenter(pts[0]); map.setZoom(15); return; }
      const b = new google.maps.LatLngBounds();
      pts.forEach((p) => b.extend(p));
      map.fitBounds(b, 48);
    },
    focus(id) {
      const e = markers.get(id);
      if (e) { map.panTo(e.data); if (map.getZoom() < 14) map.setZoom(15); }
    },
    destroy() { for (const e of markers.values()) remove(e); markers.clear(); path?.setMap(null); route?.setMap(null); },
  };
  return ctl;
}
