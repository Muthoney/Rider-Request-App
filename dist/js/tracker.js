// Rider live location. While a rider is clocked in, their position is sent to the server
// (at most every 15 s, or sooner after moving 30 m). Clocking out stops sharing at once.
//  - In the Android app, a background-location foreground service keeps tracking with the screen off.
//  - In a browser, GPS pauses when the app is in the background, so riders keep the page open.
//  - Without a connection, fixes are kept on the phone and uploaded in a batch when it returns.
import { api, getCsrf } from './api.js';
import { haversineKm } from './fuel.js';
import { bufferGps, takeGps, dropGps, onSync } from './offline.js';
import { startBackgroundGps, isNative } from './native.js';

const MIN_INTERVAL_MS = 15000;
const MIN_MOVE_KM = 0.03;
const listeners = new Set();
let watchId = null;
let stopNative = null;
let last = null; // last position sent or buffered
let lastSentAt = 0;
let buffered = 0;
let state = { active: false, status: 'off', message: 'Location sharing is off.', at: null, background: false, buffered: 0 };

const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => { try { fn(state); } catch {} }); };
export const trackerState = () => state;
export function onTracker(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }
export const geolocationSupported = () => isNative() || 'geolocation' in navigator;
/** Last known position (for proof records and incident reports when a fresh fix is slow). */
export const lastPosition = () => last;

async function send(pos) {
  const c = pos.coords;
  const point = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? null };
  const t = Date.now();
  const moved = last ? haversineKm(last, point) : Infinity;
  if (t - lastSentAt < MIN_INTERVAL_MS && moved < MIN_MOVE_KM) return;
  lastSentAt = t;
  const body = {
    lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? null,
    heading: Number.isFinite(c.heading) ? c.heading : null, speed: Number.isFinite(c.speed) ? Math.max(0, c.speed * 3.6) : null,
    recordedAt: new Date(pos.timestamp || t).toISOString(),
  };
  last = { ...point, recordedAt: body.recordedAt };
  try {
    await api.post('/api/location', body);
    emit({ status: 'live', message: `Sharing live location${c.accuracy ? ` (±${Math.round(c.accuracy)} m)` : ''}${state.background ? ' · works with the screen off' : ''}`, at: new Date().toISOString() });
    if (buffered) flushBuffered();
  } catch (err) {
    if (err.code === 'off_shift') { stopTracking(); return; }
    if (err.status === 0) {
      await bufferGps(body);
      buffered++;
      emit({ status: 'offline', message: `No connection — ${buffered} position${buffered === 1 ? '' : 's'} saved on this phone, sent when back online.`, buffered });
      return;
    }
    emit({ status: 'error', message: err.message });
  }
}

let flushing = false;
async function flushBuffered() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const batch = await takeGps(400);
      if (!batch.length) { buffered = 0; emit({ buffered: 0 }); break; }
      await api.post('/api/location/batch', { points: batch.map((b) => b.value) });
      await dropGps(batch.map((b) => b.key));
      buffered = Math.max(0, buffered - batch.length);
    }
  } catch { /* still offline; try later */ } finally { flushing = false; }
}
onSync((s) => { if (s.online) flushBuffered(); });

const onError = (err) => {
  const message = err.code === 1
    ? (isNative() ? 'Location permission was denied. Allow “all the time” location for Rider Requests in Android settings.' : 'Location permission was denied. Allow location for this site in your browser settings.')
    : err.code === 3 ? 'GPS is taking long to respond. Move to open sky.' : 'Your position is unavailable right now.';
  emit({ status: err.code === 1 ? 'denied' : 'error', message });
};

export async function startTracking() {
  if (watchId != null || stopNative) return;
  if (!geolocationSupported()) { emit({ active: false, status: 'unsupported', message: 'This device cannot share its location.' }); return; }
  emit({ active: true, status: 'waiting', message: 'Waiting for GPS…' });
  // In the app, the native service posts positions itself; here we only reflect its status.
  stopNative = await startBackgroundGps((pos) => {
    const c = pos.coords;
    last = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, recordedAt: new Date(pos.timestamp).toISOString() };
    emit(pos.sent === false
      ? { status: 'offline', message: `No connection — ${pos.queued || 0} position${pos.queued === 1 ? '' : 's'} saved on the phone, sent when back online.`, buffered: pos.queued || 0 }
      : { status: 'live', message: `Sharing live location${c.accuracy ? ` (±${Math.round(c.accuracy)} m)` : ''} · works with the screen off`, at: new Date().toISOString() });
  }, (err) => { if (err.stopped) { stopNative = null; emit({ active: false, status: 'off', message: err.message }); } else onError(err); }, { csrf: getCsrf() });
  if (stopNative) { emit({ background: true }); return; }
  watchId = navigator.geolocation.watchPosition(send, onError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  flushBuffered();
}

export function stopTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  stopNative?.();
  watchId = null; stopNative = null; lastSentAt = 0;
  emit({ active: false, status: 'off', message: 'Location sharing is off.', background: false });
}

/** Starts or stops sharing to match the rider's shift. */
export function syncTracking(onShift) { if (onShift) startTracking(); else stopTracking(); }

// Send a fresh fix as soon as the rider returns to the app.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (watchId != null || stopNative)) lastSentAt = 0;
});
