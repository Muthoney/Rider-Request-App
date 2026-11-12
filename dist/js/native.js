// Bridge to the Android app (Capacitor). The same web code runs in browsers; every function here falls
// back to the web platform (or does nothing) when the native plugin is not present.
const Cap = () => window.Capacitor;
export const isNative = () => !!Cap()?.isNativePlatform?.();
const plugin = (name) => (isNative() ? Cap()?.Plugins?.[name] : null);

/**
 * Background GPS in the Android app (RiderTracker plugin). A foreground service with a visible notification
 * reads GPS and posts it to the server itself (with this session's cookie and CSRF token), so tracking keeps
 * going with the screen off or the app in the background. Without signal it keeps positions on the phone and
 * uploads them in a batch later. Position events are also passed back here for the on-screen status.
 * Returns a stop function, or null when not running in the app (the caller then uses navigator.geolocation).
 */
export async function startBackgroundGps(onPosition, onError, { csrf } = {}) {
  const T = plugin('RiderTracker');
  if (!T) return null;
  try {
    const perm = await T.requestPermissions();
    if (perm.location !== 'granted') { onError?.({ code: 1, message: 'Location permission was denied.' }); return null; }
    await T.removeAllListeners?.();
    T.addListener('position', (p) => onPosition({ coords: { latitude: p.lat, longitude: p.lng, accuracy: p.accuracy, heading: p.heading, speed: p.speed }, timestamp: p.time, native: true, sent: p.sent, queued: p.queued }));
    T.addListener('stopped', (e) => onError?.({ code: 9, message: e?.reason || 'Tracking stopped.', stopped: true }));
    await T.start({ serverUrl: location.origin, csrf, intervalMs: 15000, minDistanceM: 25 });
    return () => T.stop().catch(() => {});
  } catch (err) {
    onError?.({ code: 2, message: err.message });
    return null;
  }
}
/** Gives the native tracker the current CSRF token (after sign-in or a session refresh). */
export async function updateTrackerSession(csrf) { try { await plugin('RiderTracker')?.updateSession?.({ csrf }); } catch {} }

/** One GPS fix for proof records and incident reports (native when available). */
export async function currentPosition({ timeout = 8000 } = {}) {
  const G = plugin('Geolocation');
  try {
    if (G) {
      const p = await G.getCurrentPosition({ enableHighAccuracy: true, timeout, maximumAge: 30000 });
      return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, recordedAt: new Date(p.timestamp).toISOString() };
    }
    if (!('geolocation' in navigator)) return null;
    const p = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout, maximumAge: 30000 }));
    return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, recordedAt: new Date(p.timestamp).toISOString() };
  } catch { return null; }
}

let channelReady = false;
/** Shows a system notification (used when the app is in the background). */
export async function localNotify({ id, title, body }) {
  const LN = plugin('LocalNotifications');
  try {
    if (LN) {
      if (!channelReady) {
        await LN.createChannel?.({ id: 'dispatch', name: 'Dispatch alerts', importance: 5, vibration: true }).catch(() => {});
        channelReady = true;
      }
      await LN.schedule({ notifications: [{ id: Number(id) % 2147483647 || Date.now() % 2147483647, title, body, channelId: 'dispatch' }] });
      return;
    }
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: `rr-${id}` });
  } catch {}
}
export async function askNotificationPermission() {
  const LN = plugin('LocalNotifications');
  try {
    if (LN) return (await LN.requestPermissions()).display === 'granted';
    if ('Notification' in window && Notification.permission === 'default') return (await Notification.requestPermission()) === 'granted';
  } catch {}
  return false;
}
export const vibrate = (pattern) => { try { plugin('Haptics')?.vibrate?.({ duration: 300 }) ?? navigator.vibrate?.(pattern); } catch {} };

/** Firebase push (only in builds that include google-services.json). Sends the token to the server. */
export async function registerPush(api) {
  const P = plugin('PushNotifications');
  if (!P) return false;
  try {
    const perm = await P.requestPermissions();
    if (perm.receive !== 'granted') return false;
    await P.removeAllListeners?.();
    P.addListener('registration', (t) => api.post('/api/push/register', { token: t.value }).catch(() => {}));
    P.addListener('pushNotificationActionPerformed', (a) => { const link = a.notification?.data?.link; if (link) location.hash = `#${link}`; });
    await P.createChannel?.({ id: 'dispatch', name: 'Dispatch alerts', importance: 5 }).catch(() => {});
    await P.register();
    return true;
  } catch { return false; }
}

/** App resumed from background (native) — used to resync quickly. */
export function onResume(fn) {
  const App = plugin('App');
  if (App) App.addListener('resume', fn);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fn(); });
}
