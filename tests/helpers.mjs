import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { hashPassword } from '../server/security.mjs';

export const ORIGIN = 'https://riders.test';
export const PASSWORD = 'correct-horse-battery-1';
const dist = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist');

export async function startServer({ now, integrations } = {}) {
  const db = openDb(':memory:');
  const clock = { offset: 0 };
  const handler = createApp({ db, origin: ORIGIN, cookieSecure: true, distDir: dist, now: now || (() => Date.now() + clock.offset), integrations });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ids = {};
  const company = (name) => {
    db.prepare('INSERT OR IGNORE INTO companies (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString());
    return db.prepare('SELECT id FROM companies WHERE name = ?').get(name).id;
  };
  const user = (email, role, { companyName = 'Alpha', tags = [], mustChange = false, password = PASSWORD, tempExpiresAt = null, phone = null } = {}) => {
    const r = db.prepare(`INSERT INTO users (company_id, email, name, phone, role, tags, password_hash, must_change, temp_expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(company(companyName), email, email.split('@')[0].replace(/\./g, ' '), phone, role, JSON.stringify(tags),
      hashPassword(password), mustChange ? 1 : 0, tempExpiresAt, new Date().toISOString());
    ids[email] = Number(r.lastInsertRowid);
    return ids[email];
  };
  return { db, base, ids, user, clock, idle: () => handler.idle(), close: () => new Promise((r) => server.close(r)) };
}

/** A tiny cookie-keeping client that behaves like the browser adapter. */
export function client(base) {
  let cookie = '';
  let csrf = null;
  const req = async (method, url, body, { origin = ORIGIN, withCsrf = true } = {}) => {
    const headers = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (origin) headers.Origin = origin;
    if (withCsrf && csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u, o) => req('GET', u, undefined, o),
    post: (u, b = {}, o) => req('POST', u, b, o),
    patch: (u, b = {}, o) => req('PATCH', u, b, o),
    del: (u, o) => req('DELETE', u, undefined, o),
    async login(email, password = PASSWORD) {
      const r = await req('POST', '/api/auth/login', { email, password });
      if (r.status === 200) csrf = r.data.csrf;
      return r;
    },
    get cookie() { return cookie; },
  };
}

export const sampleRequest = (over = {}) => ({
  title: 'Signed contracts',
  category: 'general',
  priority: 'normal',
  pickup: { address: 'HQ, Westlands', contactName: 'Reception', contactPhone: '+254700000100' },
  dropoffs: [
    { address: 'Upper Hill Chambers', contactName: 'Mercy', contactPhone: '+254711000201', lat: -1.2992, lng: 36.8137 },
    { address: 'Print House', contactName: 'Desk' },
  ],
  handling: ['documents', 'signature'],
  ...over,
});
