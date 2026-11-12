// Live updates from the server (Server-Sent Events over HTTPS) and the in-app notification inbox.
// Views subscribe with onLive(); notifications show as toasts and count on the bell. A critical notification
// that is not seen in time is sent by SMS by the server, so seen-marking only happens when the app is visible.
import { api } from './api.js';
import { toast } from './ui.js';
import { localNotify, vibrate } from './native.js';

const subs = new Set();
const unreadSubs = new Set();
let es = null;
let unread = 0;
let connected = false;
let retryTimer = null;

export const onLive = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const onUnread = (fn) => { unreadSubs.add(fn); fn(unread, connected); return () => unreadSubs.delete(fn); };
const setUnread = (n) => { unread = Math.max(0, n); unreadSubs.forEach((fn) => fn(unread, connected)); };
const dispatch = (type, data) => subs.forEach((fn) => { try { fn(type, data); } catch {} });

const TYPES = ['change', 'request', 'riders', 'location', 'incident', 'shifts', 'hello'];

function connect() {
  clearTimeout(retryTimer);
  if (es) es.close();
  if (typeof EventSource === 'undefined') return;
  es = new EventSource('/api/events');
  for (const t of TYPES) es.addEventListener(t, (e) => { let d = {}; try { d = JSON.parse(e.data); } catch {} dispatch(t, d); });
  es.addEventListener('open', () => { connected = true; setUnread(unread); refreshInbox(); });
  es.addEventListener('notification', (e) => {
    let n; try { n = JSON.parse(e.data); } catch { return; }
    setUnread(unread + 1);
    const visible = document.visibilityState === 'visible';
    toast(`${n.title}${n.body ? ` — ${n.body}` : ''}`, n.critical ? 'warn' : 'ok');
    if (n.critical) vibrate([200, 100, 200]);
    if (visible) markSeen([n.id]);
    else localNotify({ id: n.id, title: n.title, body: n.body });
    dispatch('notification', n);
  });
  es.addEventListener('error', () => {
    connected = false;
    setUnread(unread);
    // The browser retries by itself; if the stream is closed (e.g. signed out), retry slowly.
    if (es.readyState === EventSource.CLOSED) retryTimer = setTimeout(connect, 15000);
  });
}

export async function refreshInbox() {
  try { const r = await api.get('/api/inbox?limit=1'); setUnread(r.unread); } catch {}
}
export async function markSeen(ids) {
  try { const r = await api.post('/api/inbox/seen', ids === 'all' ? { all: true } : { ids }); setUnread(r.unread); } catch {}
}
export function startRealtime() { connect(); }
export function stopRealtime() { clearTimeout(retryTimer); es?.close(); es = null; connected = false; setUnread(0); }
export const isLive = () => connected;

/**
 * Re-runs `fn` (debounced) when a live event of one of `types` arrives, while the view is current.
 * Returns an unsubscribe function; pass it to ctx.onCleanup.
 */
export function liveRefresh(fn, types = ['change', 'request', 'riders', 'incident', 'shifts'], wait = 700) {
  let t = null;
  return onLive((type, data) => {
    if (!types.includes(type)) return;
    clearTimeout(t);
    t = setTimeout(() => fn(type, data), wait);
  });
}
