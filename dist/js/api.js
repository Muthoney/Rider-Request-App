// Authenticated browser adapter for the Rider Requests API.
let csrf = null;
export const setCsrf = (t) => { csrf = t; };

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

async function call(method, url, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: 'network', message: 'Could not reach the server. Check your connection.' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if ((res.status === 401 && err.code === 'unauthenticated') || err.code === 'password_change_required') listeners.forEach((fn) => fn(err));
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => call('GET', u),
  post: (u, b = {}) => call('POST', u, b),
  patch: (u, b = {}) => call('PATCH', u, b),
  del: (u) => call('DELETE', u),
};
