// Authenticated browser adapter for the Rider Requests API, with offline support:
//  - GET responses for jobs, requests, shift and settings are cached; when the network is down the
//    cached copy is returned (marked `__offline`).
//  - `api.act()` performs an action now, or queues it (with an idempotency key) to sync later.
import { isCacheable, cachePut, cacheGet, enqueue, setSender, markOnline, uid } from './offline.js';

let csrf = null;
export const setCsrf = (t) => { csrf = t; };
export const getCsrf = () => csrf;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error;
    this.data = body?.data;
  }
}

const listeners = new Set();
export const onAuthLost = (fn) => listeners.add(fn);

async function call(method, url, body, { key, raw, contentType } = {}) {
  const headers = { Accept: 'application/json' };
  if (raw) headers['Content-Type'] = contentType || raw.type || 'application/octet-stream';
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  if (key) headers['Idempotency-Key'] = key;
  let res;
  try {
    // Reads give up after 15 s (then the offline copy is used); a dead connection can otherwise hang much longer.
    const signal = method === 'GET' && !url.startsWith('/api/events') ? AbortSignal.timeout?.(15000) : undefined;
    res = await fetch(url, { method, headers, body: raw || (body === undefined ? undefined : JSON.stringify(body)), credentials: 'same-origin', signal });
  } catch {
    markOnline(false);
    throw new ApiError(0, { error: 'network', message: 'Could not reach the server. Check your connection.' });
  }
  markOnline(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if ((res.status === 401 && err.code === 'unauthenticated') || err.code === 'password_change_required') listeners.forEach((fn) => fn(err));
    throw err;
  }
  return data;
}

async function get(url) {
  try {
    const data = await call('GET', url);
    if (isCacheable(url)) cachePut(url, data);
    return data;
  } catch (err) {
    if (err.status === 0 && isCacheable(url)) {
      const hit = await cacheGet(url);
      if (hit) return { ...hit.data, __offline: true, __cachedAt: hit.at };
    }
    throw err;
  }
}

setSender(({ method, url, body, key, raw, contentType }) => call(method, url, body, { key, raw, contentType }));

export const api = {
  get,
  post: (u, b = {}, o) => call('POST', u, b, o),
  patch: (u, b = {}, o) => call('PATCH', u, b, o),
  del: (u) => call('DELETE', u),
  upload: (u, blob, o = {}) => call('POST', u, undefined, { raw: blob, contentType: o.contentType, key: o.key }),
  /**
   * An action that must not be lost. Tries it now with an idempotency key; if the network is down it is
   * queued and replayed later. Resolves to { queued: false, data } or { queued: true, entry }.
   * `meta`: { label, requestId, versioned } (versioned: retry with the current version if stale).
   */
  async act(method, url, body, meta = {}) {
    const key = uid();
    try {
      return { queued: false, data: await call(method, url, body, { key }) };
    } catch (err) {
      if (err.status !== 0) throw err;
      const entry = await enqueue({ id: key, method, url, body, ...meta });
      return { queued: true, entry };
    }
  },
};
