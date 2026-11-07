// Rider live location. While a rider is ON SHIFT, the browser's GPS position is sent to the server
// (at most every 15 s, or sooner after moving 30 m). Switching off shift stops sharing at once.
// Browsers pause GPS when the app is in the background or the screen is locked, so riders should
// keep the app open on their phone during deliveries.
import { api } from './api.js';
import { haversineKm } from './fuel.js';

const MIN_INTERVAL_MS = 15000;
const MIN_MOVE_KM = 0.03;
const listeners = new Set();
let watchId = null;
let last = null; // last position sent
let lastSentAt = 0;
let state = { active: false, status: 'off', message: 'Location sharing is off.', at: null };

const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => { try { fn(state); } catch {} }); };
export const trackerState = () => state;
export function onTracker(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }
export const geolocationSupported = () => 'geolocation' in navigator;

async function send(pos) {
  const c = pos.coords;
  const point = { lat: c.latitude, lng: c.longitude };
  const t = Date.now();
  const moved = last ? haversineKm(last, point) : Infinity;
  if (t - lastSentAt < MIN_INTERVAL_MS && moved < MIN_MOVE_KM) return;
  lastSentAt = t;
  try {
    await api.post('/api/location', {
      lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? null,
      heading: Number.isFinite(c.heading) ? c.heading : null, speed: Number.isFinite(c.speed) ? Math.max(0, c.speed * 3.6) : null,
      recordedAt: new Date(pos.timestamp || t).toISOString(),
    });
    last = point;
    emit({ status: 'live', message: `Sharing live location${c.accuracy ? ` (±${Math.round(c.accuracy)} m)` : ''}`, at: new Date().toISOString() });
  } catch (err) {
    if (err.code === 'off_shift') { stopTracking(); return; }
    emit({ status: 'error', message: err.message });
  }
}

export function startTracking() {
  if (watchId != null) return;
  if (!geolocationSupported()) { emit({ active: false, status: 'unsupported', message: 'This device cannot share its location.' }); return; }
  emit({ active: true, status: 'waiting', message: 'Waiting for GPS…' });
  watchId = navigator.geolocation.watchPosition(send, (err) => {
    const message = err.code === err.PERMISSION_DENIED
      ? 'Location permission was denied. Allow location for this site in your browser settings.'
      : err.code === err.TIMEOUT ? 'GPS is taking long to respond. Move to open sky.' : 'Your position is unavailable right now.';
    emit({ status: err.code === err.PERMISSION_DENIED ? 'denied' : 'error', message });
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}

export function stopTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; last = null; lastSentAt = 0;
  emit({ active: false, status: 'off', message: 'Location sharing is off.' });
}

/** Starts or stops sharing to match the rider's shift. */
export function syncTracking(onShift) { if (onShift) startTracking(); else stopTracking(); }

// Send a fresh fix as soon as the rider returns to the app.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId != null) lastSentAt = 0;
});
