import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tx } from './db.mjs';
import { hashPassword, verifyPassword, randomToken, sha256, tempPassword, passwordProblems } from './security.mjs';
import {
  ROLES, STAFF, CATEGORIES, HANDLING, RIDER_TAGS, RESERVED, isStaff, assignmentConflicts, priorityRank,
} from './rules.mjs';
import { parseWhatsApp } from '../dist/js/whatsapp.js';

const SESSION_TTL_MS = 12 * 3600e3;
export const TEMP_TTL_MS = 72 * 3600e3;
const BODY_LIMIT = 256 * 1024;
const COOKIE = 'rr_session';

export class HttpError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}
const bad = (message, data) => new HttpError(400, 'invalid', message, data);
const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message);
const notFound = (what = 'Not found.') => new HttpError(404, 'not_found', what);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'self'",
};

// ---------- small validation helpers ----------
const str = (v, { max = 500, required = false, label = 'Field' } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`${label} must be text.`);
  const s = v.trim();
  if (!s && required) throw bad(`${label} is required.`);
  if (s.length > max) throw bad(`${label} must be at most ${max} characters.`);
  return s || null;
};
const num = (v, min, max, label) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} is out of range.`);
  return n;
};
const isoDate = (v, label) => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw bad(`${label} must be a valid date/time.`);
  return d.toISOString();
};
const intId = (v, label = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${label}.`);
  return n;
};
const requireVersion = (body) => {
  if (!Number.isInteger(body?.version)) throw bad('The current version is required for updates.');
  return body.version;
};
const parseJson = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

export function createApp({
  db, origin, cookieSecure = true, trustProxy = false, distDir, now = () => Date.now(), log = () => {},
}) {
  if (!origin) throw new Error('APP_ORIGIN is required');
  const allowedOrigin = new URL(origin).origin;
  const cache = new Map();
  const st = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const iso = () => new Date(now()).toISOString();
  const loginAttempts = new Map();
  const DUMMY_HASH = hashPassword('timing-equaliser-not-a-real-password');

  // ---------- serialization ----------
  const userOut = (u) => u && ({
    id: u.id, companyId: u.company_id, companyName: u.company_name, email: u.email, name: u.name, phone: u.phone,
    role: u.role, tags: parseJson(u.tags, []), active: !!u.active, mustChange: !!u.must_change,
    tempExpiresAt: u.temp_expires_at, lastLoginAt: u.last_login_at, createdAt: u.created_at,
  });

  const dropoffOut = (d) => ({
    id: d.id, seq: d.seq, address: d.address, contactName: d.contact_name, contactPhone: d.contact_phone,
    lat: d.lat, lng: d.lng, instructions: d.instructions, status: d.status, handledAt: d.handled_at,
    receivedBy: d.received_by, note: d.note,
  });

  const requestOut = (r, dropoffs = []) => ({
    id: r.id, ref: `RR-${String(r.id).padStart(4, '0')}`, title: r.title, category: r.category, priority: r.priority,
    status: r.status, version: r.version, source: r.source,
    requester: { id: r.requester_id, name: r.requester_name },
    rider: r.rider_id ? { id: r.rider_id, name: r.rider_name, phone: r.rider_phone } : null,
    runId: r.run_id, runName: r.run_name || null,
    pickup: {
      address: r.pickup_address, contactName: r.pickup_contact_name, contactPhone: r.pickup_contact_phone,
      lat: r.pickup_lat, lng: r.pickup_lng,
    },
    scheduledAt: r.scheduled_at, handling: parseJson(r.handling, []), handlingNotes: r.handling_notes, notes: r.notes,
    cancelReason: r.cancel_reason, createdAt: r.created_at, updatedAt: r.updated_at, assignedAt: r.assigned_at,
    collectedAt: r.collected_at, deliveredAt: r.delivered_at,
    dropoffs: dropoffs.map(dropoffOut),
  });

  const REQUEST_SELECT = `
    SELECT r.*, q.name AS requester_name, k.name AS rider_name, k.phone AS rider_phone, run.name AS run_name
    FROM requests r
    JOIN users q ON q.id = r.requester_id
    LEFT JOIN users k ON k.id = r.rider_id
    LEFT JOIN runs run ON run.id = r.run_id`;

  function scopeSql(user) {
    if (isStaff(user)) return { where: 'r.company_id = ?', params: [user.company_id] };
    if (user.role === 'rider') return { where: 'r.company_id = ? AND r.rider_id = ?', params: [user.company_id, user.id] };
    return { where: 'r.company_id = ? AND r.requester_id = ?', params: [user.company_id, user.id] };
  }

  function withDropoffs(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const ds = st(`SELECT * FROM dropoffs WHERE request_id IN (SELECT value FROM json_each(?)) ORDER BY request_id, seq`)
      .all(JSON.stringify(ids));
    const by = new Map();
    for (const d of ds) { if (!by.has(d.request_id)) by.set(d.request_id, []); by.get(d.request_id).push(d); }
    return rows.map((r) => requestOut(r, by.get(r.id) || []));
  }

  function getVisibleRequestRow(user, id) {
    const { where, params } = scopeSql(user);
    const row = st(`${REQUEST_SELECT} WHERE r.id = ? AND ${where}`).get(id, ...params);
    if (!row) throw notFound('Request not found.');
    return row;
  }
  const getVisibleRequest = (user, id) => withDropoffs([getVisibleRequestRow(user, id)])[0];

  function logActivity(user, requestId, action, message, meta) {
    st(`INSERT INTO activity (company_id, request_id, user_id, action, message, meta, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(user.company_id, requestId ?? null, user.id, action, message, meta ? JSON.stringify(meta) : null, iso());
  }

  /** Optimistic version check + update. Throws 409 with the latest copy if stale. */
  function bump(user, id, version, sets, params) {
    const sql = `UPDATE requests SET ${sets ? sets + ', ' : ''}version = version + 1, updated_at = ? WHERE id = ? AND version = ?`;
    const res = st(sql).run(...params, iso(), id, version);
    if (res.changes === 0) {
      throw new HttpError(409, 'stale', 'This request was changed by someone else. The latest version has been loaded.', {
        current: getVisibleRequest(user, id),
      });
    }
  }

  function waitingReserved(companyId, excludeId) {
    const rows = st(`SELECT category, COUNT(*) AS n FROM requests
      WHERE company_id = ? AND status = 'pending' AND rider_id IS NULL AND category IN ('triangle','finance') AND id != ?
      GROUP BY category`).all(companyId, excludeId ?? 0);
    return Object.fromEntries(rows.map((r) => [r.category, r.n]));
  }

  function getRider(user, riderId) {
    const rider = st(`SELECT * FROM users WHERE id = ? AND company_id = ? AND role = 'rider'`).get(riderId, user.company_id);
    if (!rider) throw bad('Choose a rider from your company.');
    if (!rider.active) throw bad(`${rider.name} is deactivated.`);
    return { ...rider, tags: parseJson(rider.tags, []) };
  }

  // ---------- request payload validation ----------
  function readRequestPayload(body) {
    const title = str(body.title, { max: 120, required: true, label: 'What is being delivered' });
    const category = body.category ?? 'general';
    if (!CATEGORIES.includes(category)) throw bad('Unknown category.');
    const priority = body.priority ?? 'normal';
    if (!['normal', 'urgent'].includes(priority)) throw bad('Unknown priority.');
    const p = body.pickup || {};
    const pickup = {
      address: str(p.address, { max: 300, required: true, label: 'Pickup address' }),
      contactName: str(p.contactName, { max: 120, label: 'Pickup contact' }),
      contactPhone: str(p.contactPhone, { max: 40, label: 'Pickup phone' }),
      lat: num(p.lat, -90, 90, 'Pickup latitude'),
      lng: num(p.lng, -180, 180, 'Pickup longitude'),
    };
    if (!Array.isArray(body.dropoffs) || body.dropoffs.length < 1) throw bad('Add at least one drop-off.');
    if (body.dropoffs.length > 12) throw bad('A request can have at most 12 drop-offs.');
    const dropoffs = body.dropoffs.map((d, i) => ({
      address: str(d?.address, { max: 300, required: true, label: `Drop-off ${i + 1} address` }),
      contactName: str(d?.contactName, { max: 120, label: `Drop-off ${i + 1} contact` }),
      contactPhone: str(d?.contactPhone, { max: 40, label: `Drop-off ${i + 1} phone` }),
      lat: num(d?.lat, -90, 90, `Drop-off ${i + 1} latitude`),
      lng: num(d?.lng, -180, 180, `Drop-off ${i + 1} longitude`),
      instructions: str(d?.instructions, { max: 500, label: `Drop-off ${i + 1} instructions` }),
    }));
    const handling = Array.isArray(body.handling) ? [...new Set(body.handling)] : [];
    if (handling.some((h) => !HANDLING.includes(h))) throw bad('Unknown handling instruction.');
    const source = body.source === 'whatsapp' ? 'whatsapp' : 'form';
    return {
      title, category, priority, pickup, dropoffs, handling, source,
      scheduledAt: isoDate(body.scheduledAt, 'Scheduled pickup'),
      handlingNotes: str(body.handlingNotes, { max: 1000, label: 'Handling notes' }),
      notes: str(body.notes, { max: 2000, label: 'Notes' }),
    };
  }

  function insertDropoffs(requestId, dropoffs) {
    const ins = st(`INSERT INTO dropoffs (request_id, seq, address, contact_name, contact_phone, lat, lng, instructions)
      VALUES (?,?,?,?,?,?,?,?)`);
    dropoffs.forEach((d, i) => ins.run(requestId, i + 1, d.address, d.contactName, d.contactPhone, d.lat, d.lng, d.instructions));
  }

  // ---------- sessions ----------
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Strict${cookieSecure ? '; Secure' : ''}`;

  function loadSession(req) {
    const tok = parseCookies(req)[COOKIE];
    if (!tok) return null;
    const row = st(`SELECT s.csrf, s.expires_at, s.token_hash, u.*, c.name AS company_name
      FROM sessions s JOIN users u ON u.id = s.user_id JOIN companies c ON c.id = u.company_id WHERE s.token_hash = ?`)
      .get(sha256(tok));
    if (!row) return null;
    if (row.expires_at < iso() || !row.active) {
      st('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    return row;
  }

  function clientIp(req) {
    if (trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function checkLoginRate(key) {
    const t = now();
    const entry = loginAttempts.get(key) || { n: 0, reset: t + 15 * 60e3 };
    if (entry.reset < t) { entry.n = 0; entry.reset = t + 15 * 60e3; }
    if (entry.n >= 10) throw new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Try again in a few minutes.');
    entry.n++;
    loginAttempts.set(key, entry);
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, opts });
  };
  const needRole = (user, roles) => { if (!roles.includes(user.role)) throw forbidden(); };

  // Auth
  route('POST', '/api/auth/login', ({ body, req, res }) => {
    const email = str(body.email, { max: 200, required: true, label: 'Email' }).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    checkLoginRate(`${clientIp(req)}|${email}`);
    const user = st(`SELECT u.*, c.name AS company_name FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = ?`).get(email);
    const ok = verifyPassword(password, user?.password_hash || DUMMY_HASH) && user && user.active;
    if (!ok) throw new HttpError(401, 'bad_credentials', 'Email or password is incorrect.');
    if (user.must_change && user.temp_expires_at && user.temp_expires_at < iso()) {
      throw new HttpError(401, 'temp_expired', 'Your temporary password has expired. Ask an administrator for a new one.');
    }
    const tok = randomToken();
    const csrf = randomToken(24);
    st(`INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?,?,?,?,?)`)
      .run(sha256(tok), user.id, csrf, iso(), new Date(now() + SESSION_TTL_MS).toISOString());
    st('UPDATE users SET last_login_at = ? WHERE id = ?').run(iso(), user.id);
    loginAttempts.delete(`${clientIp(req)}|${email}`);
    res.setHeader('Set-Cookie', `${COOKIE}=${tok}; ${cookieAttrs()}; Max-Age=${SESSION_TTL_MS / 1000}`);
    return { user: userOut(user), csrf };
  }, { public: true });

  route('POST', '/api/auth/logout', ({ session, res }) => {
    st('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs()}; Max-Age=0`);
    return { ok: true };
  }, { allowPending: true });

  route('GET', '/api/auth/me', ({ user, session }) => ({ user: userOut(user), csrf: session.csrf }), { allowPending: true });

  route('POST', '/api/auth/password', ({ user, body, session, res }) => {
    const current = typeof body.current === 'string' ? body.current : '';
    const next = body.next;
    const row = st('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(current, row.password_hash)) throw new HttpError(400, 'bad_current', 'Your current password is incorrect.');
    const problems = passwordProblems(next, { email: user.email, current });
    if (problems.length) throw bad(problems[0], { problems });
    tx(db, () => {
      st('UPDATE users SET password_hash = ?, must_change = 0, temp_expires_at = NULL WHERE id = ?').run(hashPassword(next), user.id);
      // Revoke every other session; keep this one but rotate its token.
      st('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      const tok = randomToken();
      st(`INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?,?,?,?,?)`)
        .run(sha256(tok), user.id, session.csrf, iso(), new Date(now() + SESSION_TTL_MS).toISOString());
      res.setHeader('Set-Cookie', `${COOKIE}=${tok}; ${cookieAttrs()}; Max-Age=${SESSION_TTL_MS / 1000}`);
      logActivity(user, null, 'password_changed', `${user.name} changed their password`);
    });
    const fresh = st(`SELECT u.*, c.name AS company_name FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?`).get(user.id);
    return { user: userOut(fresh) };
  }, { allowPending: true });

  // Users
  route('GET', '/api/users', ({ user }) => {
    if (user.role === 'admin') {
      return { users: st(`SELECT * FROM users WHERE company_id = ? ORDER BY role, name`).all(user.company_id).map(userOut) };
    }
    if (isStaff(user)) {
      return {
        users: st(`SELECT * FROM users WHERE company_id = ? AND active = 1 AND role IN ('rider','requester','dispatcher','manager') ORDER BY role, name`)
          .all(user.company_id).map((u) => {
            const o = userOut(u);
            delete o.tempExpiresAt; delete o.mustChange; delete o.lastLoginAt;
            return o;
          }),
      };
    }
    throw forbidden();
  });

  function readUserPayload(body, { partial = false } = {}) {
    const out = {};
    if (!partial || body.name !== undefined) out.name = str(body.name, { max: 120, required: true, label: 'Name' });
    if (!partial || body.phone !== undefined) out.phone = str(body.phone, { max: 40, label: 'Phone' });
    if (!partial || body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw bad('Choose a valid role.');
      out.role = body.role;
    }
    if (!partial || body.tags !== undefined) {
      const tags = Array.isArray(body.tags) ? [...new Set(body.tags)] : [];
      if (tags.some((t) => !RIDER_TAGS.includes(t))) throw bad('Unknown rider designation.');
      out.tags = tags;
    }
    return out;
  }

  route('POST', '/api/users', ({ user, body }) => {
    needRole(user, ['admin']);
    const email = str(body.email, { max: 200, required: true, label: 'Email' }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.');
    const p = readUserPayload(body);
    if (p.role !== 'rider') p.tags = [];
    if (st('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'exists', 'An account with that email already exists.');
    const temp = tempPassword();
    const created = tx(db, () => {
      const r = st(`INSERT INTO users (company_id, email, name, phone, role, tags, password_hash, must_change, temp_expires_at, created_at)
        VALUES (?,?,?,?,?,?,?,1,?,?)`).run(user.company_id, email, p.name, p.phone, p.role, JSON.stringify(p.tags), hashPassword(temp),
        new Date(now() + TEMP_TTL_MS).toISOString(), iso());
      logActivity(user, null, 'account_created', `${user.name} created ${p.role} account for ${p.name}`);
      return st('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    });
    return { user: userOut(created), tempPassword: temp };
  });

  route('PATCH', '/api/users/:id', ({ user, params, body }) => {
    needRole(user, ['admin']);
    const id = intId(params.id);
    const target = st('SELECT * FROM users WHERE id = ? AND company_id = ?').get(id, user.company_id);
    if (!target) throw notFound('Account not found.');
    const p = readUserPayload(body, { partial: true });
    let active = target.active;
    if (body.active !== undefined) active = body.active ? 1 : 0;
    if (target.id === user.id && (active === 0 || (p.role && p.role !== 'admin')))
      throw bad('You cannot deactivate or demote your own account.');
    const role = p.role ?? target.role;
    const tags = role === 'rider' ? (p.tags ?? parseJson(target.tags, [])) : [];
    tx(db, () => {
      st('UPDATE users SET name = ?, phone = ?, role = ?, tags = ?, active = ? WHERE id = ?')
        .run(p.name ?? target.name, p.phone !== undefined ? p.phone : target.phone, role, JSON.stringify(tags), active, id);
      if (!active) st('DELETE FROM sessions WHERE user_id = ?').run(id);
      logActivity(user, null, 'account_updated', `${user.name} updated ${target.name}'s account${!active && target.active ? ' (deactivated)' : ''}`);
    });
    return { user: userOut(st('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  route('POST', '/api/users/:id/reset-password', ({ user, params }) => {
    needRole(user, ['admin']);
    const id = intId(params.id);
    const target = st('SELECT * FROM users WHERE id = ? AND company_id = ?').get(id, user.company_id);
    if (!target) throw notFound('Account not found.');
    const temp = tempPassword();
    tx(db, () => {
      st('UPDATE users SET password_hash = ?, must_change = 1, temp_expires_at = ? WHERE id = ?')
        .run(hashPassword(temp), new Date(now() + TEMP_TTL_MS).toISOString(), id);
      st('DELETE FROM sessions WHERE user_id = ?').run(id);
      logActivity(user, null, 'password_reset', `${user.name} issued a temporary password to ${target.name}`);
    });
    return { user: userOut(st('SELECT * FROM users WHERE id = ?').get(id)), tempPassword: temp };
  });

  // Requests
  route('GET', '/api/requests', ({ user, query }) => {
    const { where, params } = scopeSql(user);
    const conds = [where];
    const status = query.get('status');
    if (status && status !== 'all') {
      if (status === 'open') conds.push(`r.status IN ('pending','assigned','collected')`);
      else { conds.push('r.status = ?'); params.push(status); }
    }
    const category = query.get('category');
    if (category && CATEGORIES.includes(category)) { conds.push('r.category = ?'); params.push(category); }
    const q = (query.get('q') || '').trim();
    if (q) {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      conds.push(`(r.title LIKE ? OR r.pickup_address LIKE ? OR q.name LIKE ? OR k.name LIKE ? OR printf('RR-%04d', r.id) LIKE ?
        OR EXISTS (SELECT 1 FROM dropoffs d WHERE d.request_id = r.id AND (d.address LIKE ? OR d.contact_name LIKE ?)))`);
      params.push(like, like, like, like, like, like, like);
    }
    const rows = st(`${REQUEST_SELECT} WHERE ${conds.join(' AND ')} ORDER BY r.id DESC LIMIT 500`).all(...params);
    const STATUS_ORDER = { pending: 0, assigned: 1, collected: 2, delivered: 3, cancelled: 4 };
    const list = withDropoffs(rows).sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || priorityRank(a) - priorityRank(b) ||
      String(a.scheduledAt || a.createdAt).localeCompare(String(b.scheduledAt || b.createdAt)));
    return { requests: list };
  });

  route('POST', '/api/requests', ({ user, body }) => {
    needRole(user, ['requester', ...STAFF]);
    const p = readRequestPayload(body);
    const id = tx(db, () => {
      const t = iso();
      const r = st(`INSERT INTO requests (company_id, requester_id, title, category, priority, pickup_address, pickup_contact_name,
        pickup_contact_phone, pickup_lat, pickup_lng, scheduled_at, handling, handling_notes, notes, source, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.company_id, user.id, p.title, p.category, p.priority, p.pickup.address,
        p.pickup.contactName, p.pickup.contactPhone, p.pickup.lat, p.pickup.lng, p.scheduledAt, JSON.stringify(p.handling),
        p.handlingNotes, p.notes, p.source, t, t);
      const id = Number(r.lastInsertRowid);
      insertDropoffs(id, p.dropoffs);
      logActivity(user, id, 'created', `${user.name} created a request: ${p.title}`,
        { dropoffs: p.dropoffs.length, source: p.source, scheduled: !!p.scheduledAt });
      return id;
    });
    return { request: getVisibleRequest(user, id) };
  });

  route('GET', '/api/requests/:id', ({ user, params }) => {
    const id = intId(params.id);
    const request = getVisibleRequest(user, id);
    const records = st(`SELECT rec.*, u.name AS user_name, d.seq AS dropoff_seq FROM records rec JOIN users u ON u.id = rec.user_id
      LEFT JOIN dropoffs d ON d.id = rec.dropoff_id WHERE rec.request_id = ? ORDER BY rec.id`).all(id).map((x) => ({
      id: x.id, kind: x.kind, dropoffId: x.dropoff_id, dropoffSeq: x.dropoff_seq, by: x.user_name, counterpart: x.counterpart,
      outcome: x.outcome, itemCount: x.item_count, note: x.note, gpsStatus: x.gps_status, createdAt: x.created_at,
    }));
    const activity = st(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.request_id = ? ORDER BY a.id DESC`).all(id).map(activityOut);
    const overrides = isStaff(user) ? st(`SELECT o.*, u.name AS dispatcher_name, k.name AS rider_name FROM overrides o
      JOIN users u ON u.id = o.dispatcher_id JOIN users k ON k.id = o.rider_id WHERE o.request_id = ? ORDER BY o.id DESC`).all(id)
      .map((o) => ({ id: o.id, by: o.dispatcher_name, rider: o.rider_name, conflicts: parseJson(o.conflicts, []), reason: o.reason, createdAt: o.created_at }))
      : [];
    return { request, records, activity, overrides };
  });

  route('PATCH', '/api/requests/:id', ({ user, params, body }) => {
    const id = intId(params.id);
    const version = requireVersion(body);
    const row = getVisibleRequestRow(user, id);
    const owner = row.requester_id === user.id;
    if (user.role === 'rider') throw forbidden('Riders cannot edit request details.');
    if (!isStaff(user) && !(owner && row.status === 'pending')) throw forbidden('You can only edit your own requests before a rider is assigned.');
    if (['collected', 'delivered', 'cancelled'].includes(row.status)) throw new HttpError(409, 'locked', 'This request can no longer be edited.');
    const p = readRequestPayload(body);
    tx(db, () => {
      bump(user, id, version, `title = ?, category = ?, priority = ?, pickup_address = ?, pickup_contact_name = ?, pickup_contact_phone = ?,
        pickup_lat = ?, pickup_lng = ?, scheduled_at = ?, handling = ?, handling_notes = ?, notes = ?`,
      [p.title, p.category, p.priority, p.pickup.address, p.pickup.contactName, p.pickup.contactPhone, p.pickup.lat, p.pickup.lng,
        p.scheduledAt, JSON.stringify(p.handling), p.handlingNotes, p.notes]);
      st('DELETE FROM dropoffs WHERE request_id = ?').run(id);
      insertDropoffs(id, p.dropoffs);
      logActivity(user, id, 'edited', `${user.name} edited the request details`);
    });
    return { request: getVisibleRequest(user, id) };
  });

  route('POST', '/api/requests/:id/cancel', ({ user, params, body }) => {
    const id = intId(params.id);
    const version = requireVersion(body);
    const row = getVisibleRequestRow(user, id);
    const owner = row.requester_id === user.id;
    if (user.role === 'rider') throw forbidden('Riders cannot cancel requests.');
    if (!isStaff(user) && !(owner && row.status === 'pending')) throw forbidden('You can only cancel your own requests before a rider is assigned.');
    if (!['pending', 'assigned'].includes(row.status)) throw new HttpError(409, 'locked', 'Only requests that have not been collected can be cancelled.');
    const reason = str(body.reason, { max: 300, label: 'Reason' });
    tx(db, () => {
      bump(user, id, version, `status = 'cancelled', cancel_reason = ?, run_id = NULL`, [reason]);
      logActivity(user, id, 'cancelled', `${user.name} cancelled the request${reason ? `: ${reason}` : ''}`);
    });
    return { request: getVisibleRequest(user, id) };
  });

  route('POST', '/api/requests/:id/assign', ({ user, params, body }) => {
    needRole(user, STAFF);
    const id = intId(params.id);
    const version = requireVersion(body);
    const row = getVisibleRequestRow(user, id);
    if (['collected', 'delivered'].includes(row.status)) {
      throw new HttpError(409, 'rider_fixed', 'The rider is fixed once items have been collected.');
    }
    if (row.status === 'cancelled') throw new HttpError(409, 'locked', 'This request was cancelled.');
    if (body.riderId === null) {
      tx(db, () => {
        bump(user, id, version, `rider_id = NULL, run_id = NULL, status = 'pending', assigned_at = NULL`, []);
        logActivity(user, id, 'unassigned', `${user.name} unassigned ${row.rider_name || 'the rider'}`);
      });
      return { request: getVisibleRequest(user, id) };
    }
    const rider = getRider(user, intId(body.riderId, 'rider'));
    if (row.rider_id === rider.id) return { request: getVisibleRequest(user, id) };
    const conflicts = assignmentConflicts(row, rider, waitingReserved(user.company_id, id));
    const override = body.override;
    if (conflicts.length) {
      const reason = typeof override?.reason === 'string' ? override.reason.trim() : '';
      if (!override?.acknowledged || reason.length < 5) {
        throw new HttpError(409, 'override_required', 'This assignment conflicts with priority rules.', { conflicts, rider: rider.name });
      }
      if (reason.length > 500) throw bad('Keep the reason under 500 characters.');
    }
    tx(db, () => {
      bump(user, id, version, `rider_id = ?, run_id = NULL, status = 'assigned', assigned_at = ?`, [rider.id, iso()]);
      if (conflicts.length) {
        st(`INSERT INTO overrides (company_id, request_id, rider_id, dispatcher_id, conflicts, reason, created_at) VALUES (?,?,?,?,?,?,?)`)
          .run(user.company_id, id, rider.id, user.id, JSON.stringify(conflicts), override.reason.trim(), iso());
        logActivity(user, id, 'override', `${user.name} overrode priority rules to assign ${rider.name}: ${override.reason.trim()}`,
          { conflicts: conflicts.map((c) => c.code) });
      }
      logActivity(user, id, 'assigned', `${user.name} assigned ${rider.name}${row.rider_name ? ` (was ${row.rider_name})` : ''}`);
    });
    return { request: getVisibleRequest(user, id) };
  });

  route('POST', '/api/requests/:id/collect', ({ user, params, body }) => {
    const id = intId(params.id);
    const version = requireVersion(body);
    const row = getVisibleRequestRow(user, id);
    if (row.rider_id !== user.id) throw forbidden('Only the assigned rider can record the collection.');
    if (row.status !== 'assigned') throw new HttpError(409, 'bad_state', 'This request is not waiting for collection.');
    const counterpart = str(body.collectedFrom, { max: 120, required: true, label: 'Collected from' });
    const note = str(body.note, { max: 500, label: 'Note' });
    const itemCount = body.itemCount == null || body.itemCount === '' ? null : intId(body.itemCount, 'item count');
    tx(db, () => {
      bump(user, id, version, `status = 'collected', collected_at = ?`, [iso()]);
      st(`INSERT INTO records (request_id, kind, user_id, counterpart, item_count, note, gps_status, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, 'collection', user.id, counterpart, itemCount, note, 'unconnected', iso());
      logActivity(user, id, 'collected', `${user.name} collected from ${counterpart}${itemCount ? ` (${itemCount} item${itemCount > 1 ? 's' : ''})` : ''}`);
    });
    return { request: getVisibleRequest(user, id) };
  });

  route('POST', '/api/requests/:id/dropoffs/:dropoffId/handover', ({ user, params, body }) => {
    const id = intId(params.id);
    const dropoffId = intId(params.dropoffId, 'drop-off');
    const version = requireVersion(body);
    const row = getVisibleRequestRow(user, id);
    if (row.rider_id !== user.id) throw forbidden('Only the assigned rider can record a handover.');
    if (row.status !== 'collected') throw new HttpError(409, 'bad_state', 'Record the collection before handing over.');
    const d = st('SELECT * FROM dropoffs WHERE id = ? AND request_id = ?').get(dropoffId, id);
    if (!d) throw notFound('Drop-off not found.');
    if (d.status === 'delivered') throw new HttpError(409, 'bad_state', 'This drop-off has already been handed over.');
    const outcome = body.outcome === 'failed' ? 'failed' : 'delivered';
    const receivedBy = str(body.receivedBy, { max: 120, required: outcome === 'delivered', label: 'Received by' });
    const note = str(body.note, { max: 500, required: outcome === 'failed', label: 'What happened' });
    const result = tx(db, () => {
      bump(user, id, version, '', []);
      st('UPDATE dropoffs SET status = ?, handled_at = ?, received_by = ?, note = ? WHERE id = ?')
        .run(outcome, iso(), receivedBy, note, dropoffId);
      st(`INSERT INTO records (request_id, dropoff_id, kind, user_id, counterpart, outcome, note, gps_status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, dropoffId, 'handover', user.id, receivedBy, outcome, note, 'unconnected', iso());
      logActivity(user, id, outcome === 'delivered' ? 'handover' : 'handover_failed',
        outcome === 'delivered'
          ? `${user.name} handed over drop-off ${d.seq} to ${receivedBy}`
          : `${user.name} could not complete drop-off ${d.seq}: ${note}`);
      const left = st(`SELECT COUNT(*) AS n FROM dropoffs WHERE request_id = ? AND status != 'delivered'`).get(id).n;
      if (left === 0) {
        st(`UPDATE requests SET status = 'delivered', delivered_at = ? WHERE id = ?`).run(iso(), id);
        logActivity(user, id, 'delivered', `All drop-offs delivered`);
      }
      return left;
    });
    return { request: getVisibleRequest(user, id), remaining: result };
  });

  // WhatsApp import (parsing only; nothing is stored until the request is submitted)
  route('POST', '/api/import/whatsapp', ({ user, body }) => {
    needRole(user, ['requester', ...STAFF]);
    const text = str(body.text, { max: 20000, required: true, label: 'Message' });
    return { parsed: parseWhatsApp(text) };
  });

  // Runs
  const runOut = (r, requests) => ({
    id: r.id, name: r.name, status: r.status, rider: { id: r.rider_id, name: r.rider_name },
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, requests,
  });
  function listRuns(user, id) {
    const conds = ['run.company_id = ?'];
    const params = [user.company_id];
    if (user.role === 'rider') { conds.push('run.rider_id = ?'); params.push(user.id); }
    else if (!isStaff(user)) throw forbidden();
    if (id) { conds.push('run.id = ?'); params.push(id); }
    const runs = st(`SELECT run.*, u.name AS rider_name FROM runs run JOIN users u ON u.id = run.rider_id
      WHERE ${conds.join(' AND ')} ORDER BY CASE run.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, run.id DESC LIMIT 200`).all(...params);
    if (!runs.length) return [];
    const reqRows = st(`${REQUEST_SELECT} WHERE r.run_id IN (SELECT value FROM json_each(?)) ORDER BY r.id`).all(JSON.stringify(runs.map((r) => r.id)));
    const reqs = withDropoffs(reqRows);
    return runs.map((r) => runOut(r, reqs.filter((q) => q.runId === r.id)));
  }
  route('GET', '/api/runs', ({ user }) => ({ runs: listRuns(user) }));

  route('POST', '/api/runs', ({ user, body }) => {
    needRole(user, STAFF);
    const rider = getRider(user, intId(body.riderId, 'rider'));
    const name = str(body.name, { max: 80, label: 'Run name' }) || `${rider.name.split(' ')[0]}'s run`;
    const ids = Array.isArray(body.requestIds) ? [...new Set(body.requestIds.map((x) => intId(x, 'request')))] : [];
    if (!ids.length) throw bad('Choose at least one request for the run.');
    const id = tx(db, () => {
      for (const rid of ids) {
        const r = st('SELECT * FROM requests WHERE id = ? AND company_id = ?').get(rid, user.company_id);
        if (!r) throw bad('A selected request was not found.');
        if (r.rider_id !== rider.id || !['assigned', 'collected'].includes(r.status)) throw bad(`RR-${String(rid).padStart(4, '0')} is not an open job for ${rider.name}.`);
        if (r.run_id) throw bad(`RR-${String(rid).padStart(4, '0')} is already on another run.`);
      }
      const res = st(`INSERT INTO runs (company_id, rider_id, name, created_by, created_at) VALUES (?,?,?,?,?)`)
        .run(user.company_id, rider.id, name, user.id, iso());
      const runId = Number(res.lastInsertRowid);
      for (const rid of ids) {
        st('UPDATE requests SET run_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(runId, iso(), rid);
        logActivity(user, rid, 'run', `${user.name} added the request to run “${name}”`);
      }
      return runId;
    });
    return { run: listRuns(user, id)[0] };
  });

  route('POST', '/api/runs/:id/:action', ({ user, params }) => {
    const id = intId(params.id);
    const action = params.action;
    if (!['start', 'finish', 'delete'].includes(action)) throw notFound();
    const run = st('SELECT * FROM runs WHERE id = ? AND company_id = ?').get(id, user.company_id);
    if (!run) throw notFound('Run not found.');
    const own = user.role === 'rider' && run.rider_id === user.id;
    if (!isStaff(user) && !(own && action !== 'delete')) throw forbidden();
    tx(db, () => {
      if (action === 'start') {
        if (run.status !== 'planned') throw new HttpError(409, 'bad_state', 'Only planned runs can be started.');
        st(`UPDATE runs SET status = 'active', started_at = ? WHERE id = ?`).run(iso(), id);
      } else if (action === 'finish') {
        if (run.status !== 'active') throw new HttpError(409, 'bad_state', 'Only active runs can be finished.');
        st(`UPDATE runs SET status = 'done', finished_at = ? WHERE id = ?`).run(iso(), id);
      } else {
        if (run.status !== 'planned') throw new HttpError(409, 'bad_state', 'Only planned runs can be removed.');
        st('UPDATE requests SET run_id = NULL, version = version + 1, updated_at = ? WHERE run_id = ?').run(iso(), id);
        st('DELETE FROM runs WHERE id = ?').run(id);
      }
      logActivity(user, null, `run_${action}`, `${user.name} ${action === 'delete' ? 'removed' : action === 'start' ? 'started' : 'finished'} run “${run.name}”`);
    });
    return action === 'delete' ? { ok: true } : { run: listRuns(user, id)[0] };
  });

  // Shifts
  const shiftOut = (s) => ({ id: s.id, rider: { id: s.rider_id, name: s.rider_name }, startsAt: s.starts_at, endsAt: s.ends_at, note: s.note });
  route('GET', '/api/shifts', ({ user, query }) => {
    if (!isStaff(user) && user.role !== 'rider') throw forbidden();
    const from = isoDate(query.get('from'), 'from') || new Date(now() - 7 * 864e5).toISOString();
    const to = isoDate(query.get('to'), 'to') || new Date(now() + 14 * 864e5).toISOString();
    const params = [user.company_id, to, from];
    let extra = '';
    if (user.role === 'rider') { extra = ' AND s.rider_id = ?'; params.push(user.id); }
    return {
      shifts: st(`SELECT s.*, u.name AS rider_name FROM shifts s JOIN users u ON u.id = s.rider_id
        WHERE s.company_id = ? AND s.starts_at < ? AND s.ends_at > ?${extra} ORDER BY s.starts_at`).all(...params).map(shiftOut),
    };
  });
  route('POST', '/api/shifts', ({ user, body }) => {
    needRole(user, STAFF);
    const rider = getRider(user, intId(body.riderId, 'rider'));
    const startsAt = isoDate(body.startsAt, 'Shift start');
    const endsAt = isoDate(body.endsAt, 'Shift end');
    if (!startsAt || !endsAt) throw bad('Shift start and end are required.');
    if (endsAt <= startsAt) throw bad('The shift must end after it starts.');
    if (new Date(endsAt) - new Date(startsAt) > 16 * 3600e3) throw bad('Shifts can be at most 16 hours.');
    const overlap = st('SELECT 1 FROM shifts WHERE rider_id = ? AND starts_at < ? AND ends_at > ?').get(rider.id, endsAt, startsAt);
    if (overlap) throw new HttpError(409, 'overlap', `${rider.name} already has a shift during that time.`);
    const id = tx(db, () => {
      const r = st('INSERT INTO shifts (company_id, rider_id, starts_at, ends_at, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(user.company_id, rider.id, startsAt, endsAt, str(body.note, { max: 200, label: 'Note' }), user.id, iso());
      logActivity(user, null, 'shift_added', `${user.name} scheduled a shift for ${rider.name}`);
      return r.lastInsertRowid;
    });
    return { shift: shiftOut(st('SELECT s.*, u.name AS rider_name FROM shifts s JOIN users u ON u.id = s.rider_id WHERE s.id = ?').get(id)) };
  });
  route('DELETE', '/api/shifts/:id', ({ user, params }) => {
    needRole(user, STAFF);
    const s = st('SELECT s.*, u.name AS rider_name FROM shifts s JOIN users u ON u.id = s.rider_id WHERE s.id = ? AND s.company_id = ?')
      .get(intId(params.id), user.company_id);
    if (!s) throw notFound('Shift not found.');
    tx(db, () => {
      st('DELETE FROM shifts WHERE id = ?').run(s.id);
      logActivity(user, null, 'shift_removed', `${user.name} removed a shift for ${s.rider_name}`);
    });
    return { ok: true };
  });

  // Activity
  function activityOut(a) {
    return {
      id: a.id, requestId: a.request_id, ref: a.request_id ? `RR-${String(a.request_id).padStart(4, '0')}` : null,
      user: a.user_name, action: a.action, message: a.message, meta: parseJson(a.meta, null), createdAt: a.created_at,
    };
  }
  route('GET', '/api/activity', ({ user, query }) => {
    const limit = Math.min(Number(query.get('limit')) || 100, 300);
    if (isStaff(user)) {
      return { activity: st(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.company_id = ? ORDER BY a.id DESC LIMIT ?`).all(user.company_id, limit).map(activityOut) };
    }
    const col = user.role === 'rider' ? 'rider_id' : 'requester_id';
    return { activity: st(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
      JOIN requests r ON r.id = a.request_id WHERE r.company_id = ? AND r.${col} = ? ORDER BY a.id DESC LIMIT ?`)
      .all(user.company_id, user.id, limit).map(activityOut) };
  });

  // Dashboard stats
  route('GET', '/api/stats', ({ user }) => {
    const { where, params } = scopeSql(user);
    const byStatus = Object.fromEntries(st(`SELECT r.status, COUNT(*) AS n FROM requests r WHERE ${where} GROUP BY r.status`)
      .all(...params).map((x) => [x.status, x.n]));
    const startOfDay = new Date(now()); startOfDay.setHours(0, 0, 0, 0);
    const deliveredToday = st(`SELECT COUNT(*) AS n FROM requests r WHERE ${where} AND r.status = 'delivered' AND r.delivered_at >= ?`)
      .get(...params, startOfDay.toISOString()).n;
    const urgentOpen = st(`SELECT COUNT(*) AS n FROM requests r WHERE ${where} AND r.priority = 'urgent' AND r.status IN ('pending','assigned','collected')`)
      .get(...params).n;
    const reservedWaiting = st(`SELECT COUNT(*) AS n FROM requests r WHERE ${where} AND r.status = 'pending' AND r.category IN ('triangle','finance')`)
      .get(...params).n;
    const avg = st(`SELECT AVG((julianday(r.delivered_at) - julianday(r.created_at)) * 1440) AS m FROM requests r
      WHERE ${where} AND r.status = 'delivered' AND r.delivered_at >= ?`).get(...params, new Date(now() - 7 * 864e5).toISOString()).m;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d0 = new Date(startOfDay.getTime() - i * 864e5);
      const d1 = new Date(d0.getTime() + 864e5);
      const created = st(`SELECT COUNT(*) AS n FROM requests r WHERE ${where} AND r.created_at >= ? AND r.created_at < ?`).get(...params, d0.toISOString(), d1.toISOString()).n;
      const delivered = st(`SELECT COUNT(*) AS n FROM requests r WHERE ${where} AND r.delivered_at >= ? AND r.delivered_at < ?`).get(...params, d0.toISOString(), d1.toISOString()).n;
      days.push({ date: d0.toISOString(), created, delivered });
    }
    let riders = [];
    if (isStaff(user)) {
      const t = iso();
      riders = st(`SELECT u.id, u.name, u.tags,
          (SELECT COUNT(*) FROM requests r WHERE r.rider_id = u.id AND r.status IN ('assigned','collected')) AS open_jobs,
          (SELECT COUNT(*) FROM requests r WHERE r.rider_id = u.id AND r.status = 'delivered' AND r.delivered_at >= ?) AS done_today,
          EXISTS (SELECT 1 FROM shifts s WHERE s.rider_id = u.id AND s.starts_at <= ? AND s.ends_at > ?) AS on_shift
        FROM users u WHERE u.company_id = ? AND u.role = 'rider' AND u.active = 1 ORDER BY u.name`)
        .all(startOfDay.toISOString(), t, t, user.company_id)
        .map((r) => ({ id: r.id, name: r.name, tags: parseJson(r.tags, []), openJobs: r.open_jobs, doneToday: r.done_today, onShift: !!r.on_shift }));
    }
    return { byStatus, deliveredToday, urgentOpen, reservedWaiting, avgMinutes: avg ? Math.round(avg) : null, days, riders };
  });

  // ---------- HTTP plumbing ----------
  function send(res, status, data, headers = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new HttpError(413, 'too_large', 'Request body is too large.');
      chunks.push(chunk);
    }
    if (!size) return {};
    if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'json_only', 'Send JSON.');
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw bad('Malformed JSON.');
    }
  }

  async function handleApi(req, res, url) {
    const method = req.method;
    let match;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = url.pathname.match(r.re);
      if (m) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
    }
    if (!match) {
      const exists = routes.some((r) => r.re.test(url.pathname));
      throw new HttpError(exists ? 405 : 404, exists ? 'method' : 'not_found', exists ? 'Method not allowed.' : 'Unknown endpoint.');
    }
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating) {
      const o = req.headers.origin;
      if (!o || o !== allowedOrigin) throw new HttpError(403, 'bad_origin', 'Cross-origin request blocked.');
    }
    const body = mutating ? await readBody(req) : {};
    const ctx = { req, res, body, params: match.params, query: url.searchParams };
    if (!match.r.opts.public) {
      const session = loadSession(req);
      if (!session) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
      if (mutating && req.headers['x-csrf-token'] !== session.csrf) throw new HttpError(403, 'bad_csrf', 'Your session token is invalid. Reload the page.');
      if (session.must_change && !match.r.opts.allowPending) {
        throw new HttpError(403, 'password_change_required', 'Replace your temporary password to continue.');
      }
      ctx.session = session;
      ctx.user = session;
    }
    const out = await match.r.handler(ctx);
    send(res, 200, out);
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(distDir, rel));
    if (!file.startsWith(path.normalize(distDir + path.sep))) return send(res, 404, { error: 'not_found' });
    try {
      const s = await stat(file);
      if (!s.isFile()) throw new Error();
      const data = await readFile(file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': data.length,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      send(res, 404, { error: 'not_found' });
    }
  }

  return async function handler(req, res) {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://local');
      if (url.pathname === '/healthz') {
        db.prepare('SELECT 1').get();
        return send(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) });
      }
      log('error', err);
      return send(res, 500, { error: 'server', message: 'Something went wrong on the server.' });
    } finally {
      if (url?.pathname.startsWith('/api/')) log('info', `${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };
}

export { RESERVED };
