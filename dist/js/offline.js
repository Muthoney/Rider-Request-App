// Offline-first support. Riders keep working without a connection; nothing is lost or duplicated.
//
//   cache   – the last copy of what the rider viewed (jobs, request details, shift), shown when offline.
//   outbox  – actions taken offline (collections, handovers, incidents, location confirmations…). Each has a
//             unique id sent as the Idempotency-Key, so a replay after a dropped response never runs twice.
//             They are replayed in order when the connection returns. A stale version (someone else changed
//             the request meanwhile) is resolved by re-reading the request and retrying once; anything the
//             server still refuses is kept as a "needs attention" item for the rider to review.
//   blobs   – photos and videos waiting to upload with an incident report.
//   gps     – positions recorded while offline, uploaded in batches later.
// Storage is IndexedDB, with an in-memory fallback (private mode) so the app still works, just without
// surviving a reload.

const DB_NAME = 'rr-offline';
const STORES = ['cache', 'outbox', 'blobs', 'gps'];
let dbp = null;
const mem = Object.fromEntries(STORES.map((s) => [s, new Map()]));

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, s === 'gps' ? { autoIncrement: true } : undefined);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
async function run(store, mode, fn) {
  const db = await openDb();
  if (!db) return fn(null, mem[store]);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let out;
    Promise.resolve(fn(os, null)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
export const idb = {
  get: (store, key) => run(store, 'readonly', (os, m) => (m ? m.get(key) : req(os.get(key)))),
  put: (store, key, val) => run(store, 'readwrite', (os, m) => (m ? m.set(key, val) : req(key === undefined ? os.put(val) : os.put(val, key)))),
  del: (store, key) => run(store, 'readwrite', (os, m) => (m ? m.delete(key) : req(os.delete(key)))),
  all: (store) => run(store, 'readonly', async (os, m) => (m ? [...m.entries()].map(([k, v]) => ({ key: k, value: v }))
    : Promise.all([req(os.getAllKeys()), req(os.getAll())]).then(([ks, vs]) => ks.map((k, i) => ({ key: k, value: vs[i] }))))),
  clear: (store) => run(store, 'readwrite', (os, m) => (m ? m.clear() : req(os.clear()))),
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// ---------- connectivity + status ----------
const listeners = new Set();
let status = { online: navigator.onLine !== false, syncing: false, pending: 0, attention: 0, lastSyncAt: null, lastError: null };
const emit = (patch) => { status = { ...status, ...patch }; listeners.forEach((fn) => { try { fn(status); } catch {} }); };
export const syncStatus = () => status;
export function onSync(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); }
export function markOnline(on) { if (status.online !== on) { emit({ online: on }); if (on) flush(); } }
window.addEventListener('online', () => markOnline(true));
window.addEventListener('offline', () => markOnline(false));

// ---------- read cache ----------
/** GET responses worth keeping for offline viewing. */
const CACHEABLE = /^\/api\/(auth\/me|requests(\?|\/\d+$|$)|jobs\/available|runs$|shift\/me|config$|ops\/settings$|incidents(\?|$)|inbox|places\/recent|fuel\/settings)/;
export const isCacheable = (url) => CACHEABLE.test(url);
let cacheOwner = null;
export function setCacheOwner(userId) { cacheOwner = userId; }
export async function cachePut(url, data) { if (cacheOwner) await idb.put('cache', `${cacheOwner}|${url}`, { data, at: Date.now() }).catch(() => {}); }
export async function cacheGet(url) { return cacheOwner ? idb.get('cache', `${cacheOwner}|${url}`).catch(() => null) : null; }
export async function clearCache() { await idb.clear('cache').catch(() => {}); }

// ---------- outbox ----------
let sender = null; // set by api.js: (entry) => Promise<response data>
export function setSender(fn) { sender = fn; }

async function refreshCounts() {
  const all = (await idb.all('outbox').catch(() => [])).map((x) => x.value).filter((e) => !cacheOwner || e.userId === cacheOwner);
  emit({ pending: all.filter((e) => e.state !== 'attention').length, attention: all.filter((e) => e.state === 'attention').length });
  return all;
}
export async function pendingActions() { return (await refreshCounts()).sort((a, b) => a.createdAt - b.createdAt); }
/** Pending actions that touch a request (for "waiting to sync" markers and optimistic state). */
export async function pendingFor(requestId) { return (await pendingActions()).filter((e) => e.requestId === requestId); }

/**
 * Queues an action. `entry`: { method, url, body, label, kind?, requestId?, versioned?, media?: [{ blobId, mime }] }.
 * Returns the stored entry; the caller shows it as "saved, will sync".
 */
export async function enqueue(entry) {
  const e = { id: uid(), createdAt: Date.now(), attempts: 0, state: 'queued', userId: cacheOwner, ...entry };
  await idb.put('outbox', e.id, e);
  await refreshCounts();
  setTimeout(flush, 50);
  return e;
}
export async function storeBlob(blob) { const id = uid(); await idb.put('blobs', id, blob); return id; }
export async function discard(id) {
  const e = await idb.get('outbox', id);
  for (const m of e?.media || []) await idb.del('blobs', m.blobId).catch(() => {});
  await idb.del('outbox', id);
  await refreshCounts();
}
export async function retry(id) {
  const e = await idb.get('outbox', id);
  if (!e) return;
  await idb.put('outbox', id, { ...e, state: 'queued', error: null });
  await refreshCounts();
  flush();
}

const isNetwork = (err) => err && (err.status === 0 || err.code === 'network');
let flushing = null;
/** Replays queued actions in order. Stops at the first network failure (still offline). */
export function flush() {
  if (flushing || !sender) return flushing;
  flushing = (async () => {
    const entries = (await pendingActions()).filter((e) => e.state === 'queued');
    if (!entries.length) { emit({ syncing: false }); return; }
    emit({ syncing: true });
    let synced = 0;
    for (const e of entries) {
      try {
        await sendEntry(e);
        await idb.del('outbox', e.id);
        synced++;
        window.dispatchEvent(new CustomEvent('rr-synced', { detail: e }));
      } catch (err) {
        if (isNetwork(err)) { markOnline(false); break; }
        if (err.status === 401 || err.code === 'password_change_required') { emit({ lastError: 'Sign in again to finish syncing.' }); break; }
        if (err.status >= 500 || err.status === 429) { await idb.put('outbox', e.id, { ...e, attempts: e.attempts + 1, error: err.message }); break; }
        await idb.put('outbox', e.id, { ...e, state: 'attention', attempts: e.attempts + 1, error: err.message, code: err.code });
        window.dispatchEvent(new CustomEvent('rr-sync-attention', { detail: { ...e, error: err.message } }));
      }
    }
    await refreshCounts();
    emit({ syncing: false, lastSyncAt: synced ? Date.now() : status.lastSyncAt, online: status.online });
  })().finally(() => { flushing = null; });
  return flushing;
}

async function sendEntry(e) {
  let body = e.body;
  if (e.kind === 'incident') return sendIncident(e);
  try {
    return await sender({ method: e.method, url: e.url, body, key: e.id });
  } catch (err) {
    // Someone changed the request while we were offline: re-read it and retry once with its current version.
    if (err.code === 'stale' && e.versioned && err.data?.current?.version != null) {
      body = { ...body, version: err.data.current.version };
      await idb.put('outbox', e.id, { ...e, body });
      return sender({ method: e.method, url: e.url, body, key: e.id });
    }
    throw err;
  }
}

/** Incident report, then each photo/video. Every step is idempotent, so a retry resumes where it stopped. */
async function sendIncident(e) {
  let incidentId = e.incidentId;
  if (!incidentId) {
    const res = await sender({ method: 'POST', url: '/api/incidents', body: e.body, key: e.id });
    incidentId = res.incident.id;
    await idb.put('outbox', e.id, { ...e, incidentId });
  }
  const left = [...(e.media || [])];
  while (left.length) {
    const m = left[0];
    const blob = await idb.get('blobs', m.blobId);
    if (blob) await sender({ method: 'POST', url: `/api/incidents/${incidentId}/media?clientId=${encodeURIComponent(m.blobId)}`, raw: blob, contentType: m.mime, key: `${e.id}-${m.blobId}` });
    await idb.del('blobs', m.blobId).catch(() => {});
    left.shift();
    await idb.put('outbox', e.id, { ...e, incidentId, media: left });
  }
  return { incidentId };
}

// ---------- GPS buffer ----------
export async function bufferGps(point) {
  await idb.put('gps', undefined, point).catch(() => {});
}
export async function takeGps(max = 400) {
  const all = await idb.all('gps').catch(() => []);
  return all.slice(0, max);
}
export async function dropGps(keys) { for (const k of keys) await idb.del('gps', k).catch(() => {}); }

setInterval(() => { if (status.pending && status.online) flush(); }, 20000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
