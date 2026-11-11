import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tx } from './db.mjs';
import { hashPassword, verifyPassword, randomToken, sha256, tempPassword, passwordProblems } from './security.mjs';
import {
  ROLES, STAFF, WRITE_STAFF, VEHICLES, CATEGORIES, HANDLING, RIDER_TAGS, RESERVED, isStaff, canWrite, assignmentConflicts, priorityRank,
} from './rules.mjs';
import { parseWhatsApp } from '../dist/js/whatsapp.js';
import { isInKenya, lookupPlace, searchPlaces, KENYA_BOUNDS } from '../dist/js/kenya.js';
import { FUEL_DEFAULTS, quote, routeKm, estimateMinutes, trackKm, energyFor } from '../dist/js/fuel.js';
import { noIntegrations, e164 } from './integrations.mjs';

const SESSION_TTL_MS = 12 * 3600e3;
export const TEMP_TTL_MS = 72 * 3600e3;
const BODY_LIMIT = 256 * 1024;
const PROOF_BODY_LIMIT = 10 * 1024 * 1024; // collection / handover with a photo and a signature
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const RESET_TTL_MS = 30 * 60e3;
const SCHEDULE_MAX_DAYS = 180;
const MAX_EXTRA_PICKUPS = 4; // up to 5 pickups per request
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
const READ_ONLY = 'Managers have read-only access. Ask a dispatcher or administrator to make this change.';
/** Staff writes: admins and dispatchers. Managers get a clear read-only message. */
const needWriter = (user) => { if (!canWrite(user)) throw forbidden(user.role === 'manager' ? READ_ONLY : undefined); };
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
  'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
  // Google Maps JavaScript API needs its script, tile, font and worker hosts.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://maps.googleapis.com https://maps.gstatic.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com; " +
    "connect-src 'self' https://*.googleapis.com https://*.google.com https://*.gstatic.com data: blob:; " +
    "worker-src blob:; frame-src https://*.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
const refOf = (id) => `RR-${String(id).padStart(4, '0')}`;

/** Decodes a data: URL image (photo or signature) and checks that the bytes match the declared type. */
function readImage(v, label, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  const m = typeof v === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) throw bad(`${label} must be a JPEG, PNG or WebP image.`);
  const data = Buffer.from(m[2], 'base64');
  if (data.length > IMAGE_MAX_BYTES) throw bad(`${label} is too large (max 3 MB).`);
  const sniff = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'image/jpeg'
    : data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
      : data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;
  if (!sniff || sniff !== m[1] || data.length < 40) throw bad(`${label} is not a valid image.`);
  return { mime: m[1], data };
}
const nairobiTime = (iso) => new Date(iso).toLocaleString('en-KE', {
  timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
/** Validates a pin: both coordinates or neither, and inside Kenya. */
function kenyaPin(lat, lng, label) {
  if ((lat == null) !== (lng == null)) throw bad(`${label}: give both latitude and longitude.`);
  if (lat != null && !isInKenya(lat, lng)) throw bad(`${label} must be a location in Kenya.`);
  return { lat, lng };
}

export function createApp({
  db, origin, cookieSecure = true, trustProxy = false, distDir, now = () => Date.now(), log = () => {},
  integrations = noIntegrations(), onResetLink = null,
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
    ...(u.role === 'rider' ? { onShift: !!u.on_shift, onShiftSince: u.on_shift_since || null, vehicle: u.vehicle || 'petrol' } : {}),
  });

  const dropoffOut = (d) => ({
    id: d.id, seq: d.seq, address: d.address, contactName: d.contact_name, contactPhone: d.contact_phone,
    lat: d.lat, lng: d.lng, instructions: d.instructions, status: d.status, handledAt: d.handled_at,
    receivedBy: d.received_by, note: d.note,
  });

  /** All pickups in order: the request's own pickup is seq 1, extra pickups follow. */
  const pickupsOut = (r, extra = [], collected = []) => {
    const done = new Map(collected.map((c) => [c.seq, c]));
    return [
      { seq: 1, address: r.pickup_address, contactName: r.pickup_contact_name, contactPhone: r.pickup_contact_phone, lat: r.pickup_lat, lng: r.pickup_lng },
      ...extra.map((p) => ({ seq: p.seq, address: p.address, contactName: p.contact_name, contactPhone: p.contact_phone, lat: p.lat, lng: p.lng })),
    ].map((p) => ({ ...p, collected: done.has(p.seq), collectedAt: done.get(p.seq)?.created_at || null, collectedFrom: done.get(p.seq)?.counterpart || null }));
  };

  const requestOut = (r, dropoffs = [], extra = [], collected = []) => ({
    id: r.id, ref: `RR-${String(r.id).padStart(4, '0')}`, title: r.title, category: r.category, priority: r.priority,
    status: r.status, version: r.version, source: r.source,
    requester: { id: r.requester_id, name: r.requester_name },
    rider: r.rider_id ? { id: r.rider_id, name: r.rider_name, phone: r.rider_phone } : null,
    runId: r.run_id, runName: r.run_name || null,
    pickup: {
      address: r.pickup_address, contactName: r.pickup_contact_name, contactPhone: r.pickup_contact_phone,
      lat: r.pickup_lat, lng: r.pickup_lng,
    },
    scheduledAt: r.scheduled_at, handling: parseJson(r.handling, []).filter((h) => HANDLING.includes(h)), handlingNotes: r.handling_notes, notes: r.notes,
    cancelReason: r.cancel_reason, createdAt: r.created_at, updatedAt: r.updated_at, assignedAt: r.assigned_at,
    collectedAt: r.collected_at, deliveredAt: r.delivered_at,
    pickups: pickupsOut(r, extra, collected),
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
    const group = (list) => {
      const m = new Map();
      for (const x of list) { if (!m.has(x.request_id)) m.set(x.request_id, []); m.get(x.request_id).push(x); }
      return m;
    };
    const by = group(ds);
    const ps = group(st(`SELECT * FROM pickups WHERE request_id IN (SELECT value FROM json_each(?)) ORDER BY request_id, seq`).all(JSON.stringify(ids)));
    const cs = group(st(`SELECT request_id, COALESCE(pickup_seq, 1) AS seq, counterpart, created_at FROM records
      WHERE kind = 'collection' AND request_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(ids)));
    return rows.map((r) => requestOut(r, by.get(r.id) || [], ps.get(r.id) || [], cs.get(r.id) || []));
  }

  function getVisibleRequestRow(user, id) {
    const { where, params } = scopeSql(user);
    let row = st(`${REQUEST_SELECT} WHERE r.id = ? AND ${where}`).get(id, ...params);
    if (!row && user.role === 'rider') {
      // Riders may also open waiting jobs they are allowed to accept themselves.
      const open = st(`${REQUEST_SELECT} WHERE r.id = ? AND r.company_id = ? AND r.status = 'pending' AND r.rider_id IS NULL`).get(id, user.company_id);
      if (open && riderMayAccept(user, open)) row = open;
    }
    if (!row) throw notFound('Request not found.');
    return row;
  }

  /** A rider may accept a waiting job when no priority rule would need a dispatcher override. */
  function riderMayAccept(rider, row, waiting = waitingReserved(rider.company_id, row.id)) {
    return assignmentConflicts(row, { ...rider, tags: Array.isArray(rider.tags) ? rider.tags : parseJson(rider.tags, []) }, waiting).length === 0;
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

  // ---------- rider notifications (WhatsApp first, SMS fallback) ----------
  const inflight = new Set();
  const background = (promise) => {
    const p = promise.catch((err) => log('error', err)).finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  };

  function logSystem(companyId, requestId, action, message, meta) {
    st(`INSERT INTO activity (company_id, request_id, user_id, action, message, meta, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(companyId, requestId ?? null, null, action, message, meta ? JSON.stringify(meta) : null, iso());
  }

  function assignmentMessage(row, drops) {
    const ref = refOf(row.id);
    const when = row.scheduled_at ? nairobiTime(row.scheduled_at) : 'ASAP';
    const pickupContact = [row.pickup_contact_name, row.pickup_contact_phone].filter(Boolean).join(' ');
    const more = st('SELECT COUNT(*) AS n FROM pickups WHERE request_id = ?').get(row.id).n;
    const pickup = `${row.pickup_address}${pickupContact ? ` (${pickupContact})` : ''}${more ? ` +${more} more pickup${more > 1 ? 's' : ''}` : ''}`;
    const dropText = drops.length === 1 ? drops[0].address : `${drops.length} stops, first: ${drops[0]?.address || '-'}`;
    const link = `${allowedOrigin}/#/requests/${row.id}`;
    const urgent = row.priority === 'urgent' ? 'URGENT ' : '';
    return {
      text: `${urgent}New delivery ${ref}: ${row.title}\nPickup ${when}: ${pickup}\nDrop-off: ${dropText}\nOpen: ${link}`,
      params: [`${urgent}${ref}`, row.title, `${pickup} - ${when}`, dropText, link],
    };
  }

  function recordNotification(row, rider, channel, status, { recipient = null, providerId = null, error = null } = {}) {
    const t = iso();
    st(`INSERT INTO notifications (company_id, request_id, user_id, channel, status, recipient, provider_id, error, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.company_id, row.id, rider.id, channel, status, recipient, providerId, error, t, t);
    const label = channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
    const message = status === 'sent' ? `${rider.name} was notified by ${label}`
      : status === 'skipped' ? `${rider.name} was not notified: ${error}`
        : `${label} notification to ${rider.name} failed: ${error}`;
    logSystem(row.company_id, row.id, status === 'sent' ? 'notified' : 'notify_failed', message, { channel, status });
  }

  /** Tells the assigned rider about the job. Never throws; every attempt is recorded. */
  async function notifyRider(requestId, { smsOnly = false } = {}) {
    const row = st('SELECT * FROM requests WHERE id = ?').get(requestId);
    if (!row?.rider_id) return;
    const rider = st('SELECT * FROM users WHERE id = ?').get(row.rider_id);
    const drops = st('SELECT * FROM dropoffs WHERE request_id = ? ORDER BY seq').all(requestId);
    const msg = assignmentMessage(row, drops);
    const to = e164(rider.phone);
    const { whatsapp, sms } = integrations;
    if (!to) return recordNotification(row, rider, 'none', 'skipped', { error: 'the rider account has no valid mobile number' });
    if (!whatsapp.configured && !sms.configured) {
      return recordNotification(row, rider, 'none', 'skipped', { recipient: to, error: 'no WhatsApp or SMS provider is configured' });
    }
    if (!smsOnly && whatsapp.configured) {
      try {
        const { id } = await whatsapp.send({ to, text: msg.text, params: msg.params });
        return recordNotification(row, rider, 'whatsapp', 'sent', { recipient: to, providerId: id });
      } catch (err) {
        recordNotification(row, rider, 'whatsapp', 'failed', { recipient: to, error: String(err.message).slice(0, 300) });
      }
    }
    if (sms.configured) {
      try {
        const { id } = await sms.send({ to, text: msg.text });
        recordNotification(row, rider, 'sms', 'sent', { recipient: to, providerId: id });
      } catch (err) {
        recordNotification(row, rider, 'sms', 'failed', { recipient: to, error: String(err.message).slice(0, 300) });
      }
    }
  }

  const notificationOut = (n) => ({
    id: n.id, channel: n.channel, status: n.status, recipient: n.recipient, error: n.error, rider: n.rider_name,
    createdAt: n.created_at, updatedAt: n.updated_at,
  });
  const listNotifications = (requestId) => st(`SELECT n.*, u.name AS rider_name FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE n.request_id = ? ORDER BY n.id DESC LIMIT 30`).all(requestId).map(notificationOut);

  // ---------- fuel settings and trip costs ----------
  function fuelSettings(companyId) {
    const r = st('SELECT * FROM company_settings WHERE company_id = ?').get(companyId);
    if (!r) return { ...FUEL_DEFAULTS, isDefault: true };
    return {
      fuelType: r.fuel_type, fuelPrice: r.fuel_price, fuelPriceUpdatedAt: r.fuel_price_updated_at, kmPerLitre: r.km_per_litre,
      electricityPrice: r.electricity_price ?? FUEL_DEFAULTS.electricityPrice, kmPerKwh: r.km_per_kwh ?? FUEL_DEFAULTS.kmPerKwh,
      defaultVehicle: VEHICLES.includes(r.default_vehicle) ? r.default_vehicle : FUEL_DEFAULTS.defaultVehicle,
      timeRatePerHour: r.time_rate_per_hour, baseFee: r.base_fee, roadFactor: r.road_factor, isDefault: false,
    };
  }
  const settingsOut = ({ fuelType, fuelPrice, fuelPriceUpdatedAt, kmPerLitre, electricityPrice, kmPerKwh, defaultVehicle, timeRatePerHour, baseFee }) =>
    ({ fuelType, fuelPrice, fuelPriceUpdatedAt, kmPerLitre, electricityPrice, kmPerKwh, defaultVehicle, timeRatePerHour, baseFee });
  const vehicleOf = (riderId) => (riderId ? st('SELECT vehicle FROM users WHERE id = ?').get(riderId)?.vehicle : null);

  /** Stops with coordinates: exact pins first, otherwise the Kenyan landmark/street named in the address. */
  function placedStops(row, drops) {
    const place = (address, lat, lng) => (lat != null ? { lat, lng, exact: true } : (() => {
      const p = lookupPlace(address);
      return p ? { lat: p.lat, lng: p.lng, exact: false } : null;
    })());
    const extra = st('SELECT * FROM pickups WHERE request_id = ? ORDER BY seq').all(row.id);
    return [place(row.pickup_address, row.pickup_lat, row.pickup_lng), ...extra.map((p) => place(p.address, p.lat, p.lng)),
      ...drops.map((d) => place(d.address, d.lat, d.lng))];
  }

  const riderTrack = (riderId, from, to) => st(`SELECT lat, lng, accuracy, recorded_at AS recordedAt FROM location_points
    WHERE rider_id = ? AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at LIMIT 5000`).all(riderId, from, to);

  /** Quote estimate and (once delivered) actual trip cost. Uses the assigned rider's vehicle, else the default. */
  function requestFuel(row, drops, settings = fuelSettings(row.company_id)) {
    const stops = placedStops(row, drops);
    const placed = stops.filter(Boolean);
    const km = routeKm(placed, settings.roadFactor);
    const vehicle = vehicleOf(row.rider_id) || settings.defaultVehicle;
    const estimate = {
      ...quote({ km, minutes: estimateMinutes(km, stops.length), vehicle }, settings),
      source: 'estimate', placedStops: placed.length, totalStops: stops.length, exactStops: placed.filter((p) => p.exact).length,
    };
    let actual = null;
    if (row.status === 'delivered' && row.assigned_at && row.delivered_at && row.rider_id) {
      const gpsKm = trackKm(riderTrack(row.rider_id, row.assigned_at, row.delivered_at));
      const minutes = (new Date(row.delivered_at) - new Date(row.assigned_at)) / 60e3;
      actual = { ...quote({ km: gpsKm > 0.2 ? gpsKm : km, minutes, vehicle }, settings), source: gpsKm > 0.2 ? 'gps' : 'estimate' };
    }
    return { estimate, actual, settings: settingsOut(settings) };
  }

  // ---------- request payload validation ----------
  /** Scheduled pickups must be in the future (5 minutes' grace) and at most SCHEDULE_MAX_DAYS ahead. */
  function checkSchedule(at) {
    if (!at) return;
    const t = new Date(at).getTime();
    if (t < now() - 5 * 60e3) throw bad('Choose a scheduled pickup time in the future.');
    if (t > now() + SCHEDULE_MAX_DAYS * 864e5) throw bad(`Schedule at most ${SCHEDULE_MAX_DAYS} days ahead.`);
  }
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
      ...kenyaPin(num(p.lat, -90, 90, 'Pickup latitude'), num(p.lng, -180, 180, 'Pickup longitude'), 'The pickup pin'),
    };
    const extras = body.extraPickups ?? [];
    if (!Array.isArray(extras)) throw bad('Extra pickups must be a list.');
    if (extras.length > MAX_EXTRA_PICKUPS) throw bad(`A request can have at most ${MAX_EXTRA_PICKUPS + 1} pickups.`);
    const extraPickups = extras.map((x, i) => ({
      address: str(x?.address, { max: 300, required: true, label: `Pickup ${i + 2} address` }),
      contactName: str(x?.contactName, { max: 120, label: `Pickup ${i + 2} contact` }),
      contactPhone: str(x?.contactPhone, { max: 40, label: `Pickup ${i + 2} phone` }),
      ...kenyaPin(num(x?.lat, -90, 90, `Pickup ${i + 2} latitude`), num(x?.lng, -180, 180, `Pickup ${i + 2} longitude`), `The pickup ${i + 2} pin`),
    }));
    if (!Array.isArray(body.dropoffs) || body.dropoffs.length < 1) throw bad('Add at least one drop-off.');
    if (body.dropoffs.length > 12) throw bad('A request can have at most 12 drop-offs.');
    const dropoffs = body.dropoffs.map((d, i) => ({
      address: str(d?.address, { max: 300, required: true, label: `Drop-off ${i + 1} address` }),
      contactName: str(d?.contactName, { max: 120, label: `Drop-off ${i + 1} contact` }),
      contactPhone: str(d?.contactPhone, { max: 40, label: `Drop-off ${i + 1} phone` }),
      ...kenyaPin(num(d?.lat, -90, 90, `Drop-off ${i + 1} latitude`), num(d?.lng, -180, 180, `Drop-off ${i + 1} longitude`), `The drop-off ${i + 1} pin`),
      instructions: str(d?.instructions, { max: 500, label: `Drop-off ${i + 1} instructions` }),
    }));
    const handling = Array.isArray(body.handling) ? [...new Set(body.handling)] : [];
    if (handling.some((h) => !HANDLING.includes(h))) throw bad('Unknown handling instruction.');
    const source = body.source === 'whatsapp' ? 'whatsapp' : 'form';
    return {
      title, category, priority, pickup, extraPickups, dropoffs, handling, source,
      scheduledAt: isoDate(body.scheduledAt, 'Scheduled pickup'),
      handlingNotes: str(body.handlingNotes, { max: 1000, label: 'Handling notes' }),
      notes: str(body.notes, { max: 2000, label: 'Notes' }),
    };
  }

  function insertPickups(requestId, extra) {
    const ins = st('INSERT INTO pickups (request_id, seq, address, contact_name, contact_phone, lat, lng) VALUES (?,?,?,?,?,?,?)');
    extra.forEach((p, i) => ins.run(requestId, i + 2, p.address, p.contactName, p.contactPhone, p.lat, p.lng));
  }
  /** Number of pickups already collected for a request. */
  const collectedCount = (requestId) => st(`SELECT COUNT(DISTINCT COALESCE(pickup_seq, 1)) AS n FROM records WHERE request_id = ? AND kind = 'collection'`).get(requestId).n;

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

  function checkLoginRate(key, max = 10, message = 'Too many sign-in attempts. Try again in a few minutes.') {
    const t = now();
    const entry = loginAttempts.get(key) || { n: 0, reset: t + 15 * 60e3 };
    if (entry.reset < t) { entry.n = 0; entry.reset = t + 15 * 60e3; }
    if (entry.n >= max) throw new HttpError(429, 'rate_limited', message);
    entry.n++;
    loginAttempts.set(key, entry);
  }

  // ---------- password recovery: email first, then WhatsApp, then SMS ----------
  /** Sends the reset link. Never throws; records which channel worked (no token is logged). */
  async function deliverReset(user, link, resetId) {
    const { email, whatsapp, sms } = integrations;
    const text = `Hi ${user.name.split(' ')[0]},\n\nSomeone (hopefully you) asked to reset your Rider Requests password. Open this link within 30 minutes to choose a new one:\n\n${link}\n\nIf you didn't ask for this, ignore this message: your password stays the same.`;
    const short = `Rider Requests password reset: ${link} (valid 30 min). Ignore if you didn't ask.`;
    const tried = [];
    const done = (channel) => {
      st('UPDATE password_resets SET channel = ? WHERE id = ?').run(channel, resetId);
      logSystem(user.company_id, null, 'password_reset_sent', `Password reset link sent to ${user.name} by ${channel === 'email' ? 'email' : channel === 'whatsapp' ? 'WhatsApp' : channel === 'sms' ? 'SMS' : channel}`,
        { channel, fallbackFrom: tried.length ? tried : undefined });
    };
    if (email?.configured) {
      try { await email.send({ to: user.email, subject: 'Reset your Rider Requests password', text }); return done('email'); }
      catch (err) { tried.push('email'); log('error', `Reset email failed: ${err.message}`); }
    }
    const to = e164(user.phone);
    if (to && whatsapp.configured) {
      try { await whatsapp.send({ to, text: short, params: [link], template: whatsapp.resetTemplate }); return done('whatsapp'); }
      catch (err) { tried.push('whatsapp'); log('error', `Reset WhatsApp failed: ${err.message}`); }
    }
    if (to && sms.configured) {
      try { await sms.send({ to, text: short }); return done('sms'); }
      catch (err) { tried.push('sms'); log('error', `Reset SMS failed: ${err.message}`); }
    }
    if (onResetLink) { onResetLink({ email: user.email, link }); return done('console'); }
    logSystem(user.company_id, null, 'password_reset_failed', `A password reset for ${user.name} could not be sent: ${tried.length ? `${tried.join(', ')} failed` : 'no email, WhatsApp or SMS provider is configured'}`);
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

  // Forgotten password. The answer is the same whether or not the account exists.
  route('POST', '/api/auth/forgot', ({ body, req }) => {
    const email = str(body.email, { max: 200, required: true, label: 'Email' }).toLowerCase();
    checkLoginRate(`forgot|${clientIp(req)}`, 10, 'Too many reset requests. Try again in a few minutes.');
    checkLoginRate(`forgot|${email}`, 3, 'Too many reset requests for this account. Try again in a few minutes.');
    const user = st('SELECT * FROM users WHERE email = ?').get(email);
    if (user && user.active) {
      const token = randomToken();
      const resetId = tx(db, () => {
        st('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);
        return Number(st('INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?)')
          .run(user.id, sha256(token), iso(), new Date(now() + RESET_TTL_MS).toISOString()).lastInsertRowid);
      });
      background(deliverReset(user, `${allowedOrigin}/#/reset?token=${token}`, resetId));
    }
    return { ok: true, message: 'If that email belongs to an active account, a reset link is on its way. Check your email, then WhatsApp or SMS.' };
  }, { public: true });

  route('POST', '/api/auth/reset', ({ body, req }) => {
    checkLoginRate(`reset|${clientIp(req)}`, 10, 'Too many attempts. Try again in a few minutes.');
    const token = typeof body.token === 'string' ? body.token : '';
    const row = token ? st(`SELECT pr.*, u.email, u.name, u.active, u.company_id FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ?`).get(sha256(token)) : null;
    if (!row || row.used_at || row.expires_at < iso() || !row.active) {
      throw new HttpError(400, 'bad_token', 'This reset link is invalid or has expired. Ask for a new one.');
    }
    const problems = passwordProblems(body.password, { email: row.email });
    if (problems.length) throw bad(problems[0], { problems });
    tx(db, () => {
      st('UPDATE users SET password_hash = ?, must_change = 0, temp_expires_at = NULL WHERE id = ?').run(hashPassword(body.password), row.user_id);
      st('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      st('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(iso(), row.user_id);
      logActivity({ company_id: row.company_id, id: row.user_id }, null, 'password_recovered', `${row.name} reset their password with a recovery link`);
    });
    for (const k of loginAttempts.keys()) if (k.endsWith(`|${row.email}`)) loginAttempts.delete(k);
    return { ok: true };
  }, { public: true });

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
    if (!partial || body.vehicle !== undefined) {
      const vehicle = body.vehicle ?? 'petrol';
      if (!VEHICLES.includes(vehicle)) throw bad('Vehicle must be petrol or electric.');
      out.vehicle = vehicle;
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
      const r = st(`INSERT INTO users (company_id, email, name, phone, role, tags, vehicle, password_hash, must_change, temp_expires_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,1,?,?)`).run(user.company_id, email, p.name, p.phone, p.role, JSON.stringify(p.tags), p.vehicle, hashPassword(temp),
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
      st('UPDATE users SET name = ?, phone = ?, role = ?, tags = ?, vehicle = ?, active = ? WHERE id = ?')
        .run(p.name ?? target.name, p.phone !== undefined ? p.phone : target.phone, role, JSON.stringify(tags), p.vehicle ?? target.vehicle ?? 'petrol', active, id);
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
        OR EXISTS (SELECT 1 FROM dropoffs d WHERE d.request_id = r.id AND (d.address LIKE ? OR d.contact_name LIKE ?))
        OR EXISTS (SELECT 1 FROM pickups p WHERE p.request_id = r.id AND (p.address LIKE ? OR p.contact_name LIKE ?)))`);
      params.push(like, like, like, like, like, like, like, like, like);
    }
    const rows = st(`${REQUEST_SELECT} WHERE ${conds.join(' AND ')} ORDER BY r.id DESC LIMIT 500`).all(...params);
    const STATUS_ORDER = { pending: 0, assigned: 1, collected: 2, delivered: 3, cancelled: 4 };
    const list = withDropoffs(rows).sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || priorityRank(a) - priorityRank(b) ||
      String(a.scheduledAt || a.createdAt).localeCompare(String(b.scheduledAt || b.createdAt)));
    return { requests: list };
  });

  route('POST', '/api/requests', ({ user, body }) => {
    if (user.role === 'manager') throw forbidden(READ_ONLY);
    needRole(user, ['requester', ...WRITE_STAFF]);
    const p = readRequestPayload(body);
    checkSchedule(p.scheduledAt);
    const id = tx(db, () => {
      const t = iso();
      const r = st(`INSERT INTO requests (company_id, requester_id, title, category, priority, pickup_address, pickup_contact_name,
        pickup_contact_phone, pickup_lat, pickup_lng, scheduled_at, handling, handling_notes, notes, source, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.company_id, user.id, p.title, p.category, p.priority, p.pickup.address,
        p.pickup.contactName, p.pickup.contactPhone, p.pickup.lat, p.pickup.lng, p.scheduledAt, JSON.stringify(p.handling),
        p.handlingNotes, p.notes, p.source, t, t);
      const id = Number(r.lastInsertRowid);
      insertPickups(id, p.extraPickups);
      insertDropoffs(id, p.dropoffs);
      logActivity(user, id, 'created', `${user.name} created a request: ${p.title}${p.scheduledAt ? ` (scheduled for ${nairobiTime(p.scheduledAt)})` : ''}`,
        { pickups: p.extraPickups.length + 1, dropoffs: p.dropoffs.length, source: p.source, scheduled: !!p.scheduledAt });
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
      photo: x.photo_id ? `/api/attachments/${x.photo_id}` : null, signature: x.signature_id ? `/api/attachments/${x.signature_id}` : null,
      dnoteRef: x.dnote_ref, signedBy: x.signed_by, pickupSeq: x.kind === 'collection' ? (x.pickup_seq || 1) : null,
    }));
    const activity = st(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.request_id = ? ORDER BY a.id DESC`).all(id).map(activityOut);
    const overrides = isStaff(user) ? st(`SELECT o.*, u.name AS dispatcher_name, k.name AS rider_name FROM overrides o
      JOIN users u ON u.id = o.dispatcher_id JOIN users k ON k.id = o.rider_id WHERE o.request_id = ? ORDER BY o.id DESC`).all(id)
      .map((o) => ({ id: o.id, by: o.dispatcher_name, rider: o.rider_name, conflicts: parseJson(o.conflicts, []), reason: o.reason, createdAt: o.created_at }))
      : [];
    const notifications = isStaff(user) ? listNotifications(id) : [];
    let fuel = null;
    if (user.role !== 'rider') {
      const row = st('SELECT * FROM requests WHERE id = ?').get(id);
      fuel = requestFuel(row, st('SELECT * FROM dropoffs WHERE request_id = ? ORDER BY seq').all(id));
    }
    return { request, records, activity, overrides, notifications, fuel };
  });

  route('PATCH', '/api/requests/:id', ({ user, params, body }) => {
    const id = intId(params.id);
    const version = requireVersion(body);
    const row = getVisibleRequestRow(user, id);
    const owner = row.requester_id === user.id;
    if (user.role === 'rider') throw forbidden('Riders cannot edit request details.');
    if (user.role === 'manager') throw forbidden(READ_ONLY);
    if (!canWrite(user) && !(owner && row.status === 'pending')) throw forbidden('You can only edit your own requests before a rider is assigned.');
    if (['collected', 'delivered', 'cancelled'].includes(row.status) || collectedCount(id)) throw new HttpError(409, 'locked', 'This request can no longer be edited.');
    const p = readRequestPayload(body);
    if (p.scheduledAt !== row.scheduled_at) checkSchedule(p.scheduledAt);
    tx(db, () => {
      bump(user, id, version, `title = ?, category = ?, priority = ?, pickup_address = ?, pickup_contact_name = ?, pickup_contact_phone = ?,
        pickup_lat = ?, pickup_lng = ?, scheduled_at = ?, handling = ?, handling_notes = ?, notes = ?`,
      [p.title, p.category, p.priority, p.pickup.address, p.pickup.contactName, p.pickup.contactPhone, p.pickup.lat, p.pickup.lng,
        p.scheduledAt, JSON.stringify(p.handling), p.handlingNotes, p.notes]);
      st('DELETE FROM dropoffs WHERE request_id = ?').run(id);
      insertDropoffs(id, p.dropoffs);
      st('DELETE FROM pickups WHERE request_id = ?').run(id);
      insertPickups(id, p.extraPickups);
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
    if (user.role === 'manager') throw forbidden(READ_ONLY);
    if (!canWrite(user) && !(owner && row.status === 'pending')) throw forbidden('You can only cancel your own requests before a rider is assigned.');
    if (!['pending', 'assigned'].includes(row.status) || collectedCount(id)) throw new HttpError(409, 'locked', 'Only requests that have not been collected can be cancelled.');
    const reason = str(body.reason, { max: 300, label: 'Reason' });
    tx(db, () => {
      bump(user, id, version, `status = 'cancelled', cancel_reason = ?, run_id = NULL`, [reason]);
      logActivity(user, id, 'cancelled', `${user.name} cancelled the request${reason ? `: ${reason}` : ''}`);
    });
    return { request: getVisibleRequest(user, id) };
  });

  route('POST', '/api/requests/:id/assign', ({ user, params, body }) => {
    needRole(user, STAFF);
    needWriter(user);
    const id = intId(params.id);
    const version = requireVersion(body);
    const row = getVisibleRequestRow(user, id);
    if (['collected', 'delivered'].includes(row.status) || collectedCount(id)) {
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
    background(notifyRider(id));
    return { request: getVisibleRequest(user, id) };
  });

  route('POST', '/api/requests/:id/notify', async ({ user, params }) => {
    needRole(user, STAFF);
    needWriter(user);
    const id = intId(params.id);
    const row = getVisibleRequestRow(user, id);
    if (!row.rider_id || !['assigned', 'collected'].includes(row.status)) {
      throw new HttpError(409, 'bad_state', 'Only requests with an assigned rider can be re-sent.');
    }
    await notifyRider(id);
    return { notifications: listNotifications(id) };
  });

  route('GET', '/api/requests/:id/track', ({ user, params }) => {
    const row = getVisibleRequestRow(user, intId(params.id));
    let rider = null;
    if (row.rider_id && ['assigned', 'collected'].includes(row.status)) {
      const l = st(`SELECT l.*, u.on_shift FROM rider_locations l JOIN users u ON u.id = l.rider_id WHERE l.rider_id = ?`).get(row.rider_id);
      if (l?.on_shift) rider = { id: row.rider_id, name: row.rider_name, lat: l.lat, lng: l.lng, accuracy: l.accuracy, heading: l.heading, speed: l.speed, recordedAt: l.recorded_at };
    }
    let path = [];
    if ((isStaff(user) || row.rider_id === user.id) && row.rider_id && row.assigned_at) {
      path = riderTrack(row.rider_id, row.assigned_at, row.delivered_at || iso()).filter((p) => p.accuracy == null || p.accuracy <= 100)
        .map((p) => ({ lat: p.lat, lng: p.lng }));
    }
    return { rider, path, status: row.status };
  });

  route('POST', '/api/requests/:id/collect', ({ user, params, body }) => {
    const id = intId(params.id);
    const version = requireVersion(body);
    const row = getVisibleRequestRow(user, id);
    if (row.rider_id !== user.id) throw forbidden('Only the assigned rider can record the collection.');
    if (row.status !== 'assigned') throw new HttpError(409, 'bad_state', 'This request is not waiting for collection.');
    const total = 1 + st('SELECT COUNT(*) AS n FROM pickups WHERE request_id = ?').get(id).n;
    const done = new Set(st(`SELECT COALESCE(pickup_seq, 1) AS seq FROM records WHERE request_id = ? AND kind = 'collection'`).all(id).map((x) => x.seq));
    let seq = body.pickupSeq == null ? null : intId(body.pickupSeq, 'pickup');
    if (seq == null) seq = [...Array(total).keys()].map((i) => i + 1).find((n) => !done.has(n));
    if (seq > total) throw notFound('Pickup not found.');
    if (done.has(seq)) throw new HttpError(409, 'bad_state', `Pickup ${seq} has already been collected.`);
    const allDone = done.size + 1 === total;
    const counterpart = str(body.collectedFrom, { max: 120, required: true, label: 'Collected from' });
    const note = str(body.note, { max: 500, label: 'Note' });
    const itemCount = body.itemCount == null || body.itemCount === '' ? null : intId(body.itemCount, 'item count');
    const photo = readImage(body.photo, 'A photo of the collected items', { required: true });
    const signature = readImage(body.signature, 'The D-note signature');
    const dnoteRef = str(body.dnoteRef, { max: 60, label: 'D-note number' });
    tx(db, () => {
      // The request counts as collected (and moves to "in transit") once every pickup is done.
      if (allDone) bump(user, id, version, `status = 'collected', collected_at = ?`, [iso()]);
      else bump(user, id, version, '', []);
      const photoId = storeAttachment(user, id, 'photo', 'collection', photo);
      const signatureId = signature ? storeAttachment(user, id, 'signature', 'collection', signature) : null;
      st(`INSERT INTO records (request_id, kind, user_id, counterpart, item_count, note, gps_status, photo_id, signature_id, dnote_ref, signed_by, pickup_seq, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, 'collection', user.id, counterpart, itemCount, note, 'unconnected', photoId, signatureId, dnoteRef, signature ? counterpart : null, seq, iso());
      logActivity(user, id, 'collected', `${user.name} collected${total > 1 ? ` pickup ${seq} of ${total}` : ''} from ${counterpart}${itemCount ? ` (${itemCount} item${itemCount > 1 ? 's' : ''})` : ''} · photo${signature ? ' and signed D-note' : ''} recorded`);
    });
    return { request: getVisibleRequest(user, id), remainingPickups: total - done.size - 1 };
  }, { bodyLimit: PROOF_BODY_LIMIT });

  function storeAttachment(user, requestId, kind, stage, img) {
    const r = st(`INSERT INTO attachments (company_id, request_id, kind, stage, mime, data, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(user.company_id, requestId, kind, stage, img.mime, img.data, user.id, iso());
    return Number(r.lastInsertRowid);
  }

  // Proof photos and D-note signatures, visible to whoever can see the request.
  route('GET', '/api/attachments/:id', ({ user, params }) => {
    const a = st('SELECT * FROM attachments WHERE id = ? AND company_id = ?').get(intId(params.id), user.company_id);
    if (!a) throw notFound('File not found.');
    getVisibleRequestRow(user, a.request_id);
    return { __binary: Buffer.from(a.data), type: a.mime };
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
    const delivered = outcome === 'delivered';
    const receivedBy = str(body.receivedBy, { max: 120, required: delivered, label: 'Received by' });
    const note = str(body.note, { max: 500, required: !delivered, label: 'What happened' });
    // A delivered drop-off needs a photo of the handover and the recipient's signature on the D-note.
    const photo = readImage(body.photo, 'A photo of the delivery', { required: delivered });
    const signature = delivered ? readImage(body.signature, 'The recipient’s D-note signature', { required: true }) : null;
    const dnoteRef = str(body.dnoteRef, { max: 60, label: 'D-note number' });
    const result = tx(db, () => {
      bump(user, id, version, '', []);
      st('UPDATE dropoffs SET status = ?, handled_at = ?, received_by = ?, note = ? WHERE id = ?')
        .run(outcome, iso(), receivedBy, note, dropoffId);
      const photoId = photo ? storeAttachment(user, id, 'photo', 'handover', photo) : null;
      const signatureId = signature ? storeAttachment(user, id, 'signature', 'handover', signature) : null;
      st(`INSERT INTO records (request_id, dropoff_id, kind, user_id, counterpart, outcome, note, gps_status, photo_id, signature_id, dnote_ref, signed_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, dropoffId, 'handover', user.id, receivedBy, outcome, note, 'unconnected', photoId, signatureId, dnoteRef, signature ? receivedBy : null, iso());
      logActivity(user, id, delivered ? 'handover' : 'handover_failed',
        delivered
          ? `${user.name} handed over drop-off ${d.seq} to ${receivedBy} · photo and signed D-note${dnoteRef ? ` ${dnoteRef}` : ''} recorded`
          : `${user.name} could not complete drop-off ${d.seq}: ${note}`);
      const left = st(`SELECT COUNT(*) AS n FROM dropoffs WHERE request_id = ? AND status != 'delivered'`).get(id).n;
      if (left === 0) {
        st(`UPDATE requests SET status = 'delivered', delivered_at = ? WHERE id = ?`).run(iso(), id);
        logActivity(user, id, 'delivered', `All drop-offs delivered`);
      }
      return left;
    });
    return { request: getVisibleRequest(user, id), remaining: result };
  }, { bodyLimit: PROOF_BODY_LIMIT });

  // Riders pick up waiting work themselves. Only jobs that need no priority-rule override are offered;
  // dispatchers (and administrators, with a recorded override) can still assign anyone.
  route('GET', '/api/jobs/available', ({ user }) => {
    needRole(user, ['rider']);
    const me = st('SELECT * FROM users WHERE id = ?').get(user.id);
    const waiting = waitingReserved(user.company_id);
    const rows = st(`${REQUEST_SELECT} WHERE r.company_id = ? AND r.status = 'pending' AND r.rider_id IS NULL ORDER BY r.id LIMIT 300`)
      .all(user.company_id).filter((r) => {
        const w = { ...waiting };
        if (RESERVED.includes(r.category)) w[r.category] = Math.max(0, (w[r.category] || 0) - 1);
        return riderMayAccept(me, r, w);
      });
    const jobs = withDropoffs(rows).sort((a, b) => priorityRank(a) - priorityRank(b) ||
      String(a.scheduledAt || a.createdAt).localeCompare(String(b.scheduledAt || b.createdAt)));
    return { jobs, onShift: !!me.on_shift };
  });

  route('POST', '/api/requests/:id/accept', ({ user, params, body }) => {
    needRole(user, ['rider']);
    const id = intId(params.id);
    const version = requireVersion(body);
    const me = st('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!me.on_shift) throw new HttpError(409, 'off_shift', 'Switch on shift before accepting jobs.');
    const row = st(`${REQUEST_SELECT} WHERE r.id = ? AND r.company_id = ?`).get(id, user.company_id);
    if (!row) throw notFound('Request not found.');
    if (row.status !== 'pending' || row.rider_id) throw new HttpError(409, 'taken', 'This job has already been taken. Pick another one.');
    const conflicts = assignmentConflicts(row, { ...me, tags: parseJson(me.tags, []) }, waitingReserved(user.company_id, id));
    if (conflicts.length) throw new HttpError(403, 'not_eligible', `${conflicts[0].message} Ask dispatch to assign it.`, { conflicts });
    tx(db, () => {
      const res = st(`UPDATE requests SET rider_id = ?, run_id = NULL, status = 'assigned', assigned_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'pending' AND rider_id IS NULL`).run(user.id, iso(), iso(), id, version);
      if (res.changes === 0) throw new HttpError(409, 'taken', 'This job just changed or was taken by someone else. The list has been refreshed.');
      logActivity(user, id, 'accepted', `${user.name} accepted the job`);
    });
    return { request: getVisibleRequest(user, id) };
  });

  // WhatsApp import (parsing only; nothing is stored until the request is submitted)
  route('POST', '/api/import/whatsapp', ({ user, body }) => {
    needRole(user, ['requester', ...WRITE_STAFF]);
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
    needWriter(user);
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
    if (user.role === 'manager') throw forbidden(READ_ONLY);
    if (!canWrite(user) && !(own && action !== 'delete')) throw forbidden();
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
  // Shift on/off switch. Staff can switch any rider; riders switch themselves. Switching off
  // stores the completed shift in `shifts` (the shift log) and clears the rider's live position.
  const riderShiftOut = (u) => ({ id: u.id, name: u.name, onShift: !!u.on_shift, onShiftSince: u.on_shift_since || null });
  route('POST', '/api/riders/:id/shift', ({ user, params, body }) => {
    const id = intId(params.id, 'rider');
    if (user.role === 'manager') throw forbidden(READ_ONLY);
    if (!canWrite(user) && !(user.role === 'rider' && user.id === id)) throw forbidden('You can only switch your own shift.');
    if (typeof body.onShift !== 'boolean') throw bad('Say whether the rider is on or off shift.');
    const rider = st(`SELECT * FROM users WHERE id = ? AND company_id = ? AND role = 'rider'`).get(id, user.company_id);
    if (!rider) throw notFound('Rider not found.');
    if (!rider.active) throw bad(`${rider.name} is deactivated.`);
    if (!!rider.on_shift === body.onShift) return { rider: riderShiftOut(rider) };
    const self = user.id === rider.id;
    tx(db, () => {
      const t = iso();
      if (body.onShift) {
        st('UPDATE users SET on_shift = 1, on_shift_since = ? WHERE id = ?').run(t, id);
        logActivity(user, null, 'shift_on', self ? `${rider.name} went on shift` : `${user.name} put ${rider.name} on shift`);
      } else {
        if (rider.on_shift_since && rider.on_shift_since < t) {
          st('INSERT INTO shifts (company_id, rider_id, starts_at, ends_at, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
            .run(user.company_id, id, rider.on_shift_since, t, null, user.id, t);
        }
        st('UPDATE users SET on_shift = 0, on_shift_since = NULL WHERE id = ?').run(id);
        st('DELETE FROM rider_locations WHERE rider_id = ?').run(id);
        logActivity(user, null, 'shift_off', self ? `${rider.name} went off shift` : `${user.name} took ${rider.name} off shift`);
      }
    });
    return { rider: riderShiftOut(st('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  // Live GPS. Riders' browsers post positions only while they are on shift.
  let pointsSincePrune = 0;
  route('POST', '/api/location', ({ user, body }) => {
    needRole(user, ['rider']);
    const me = st('SELECT on_shift FROM users WHERE id = ?').get(user.id);
    if (!me.on_shift) throw new HttpError(409, 'off_shift', 'Location is only shared while you are on shift.');
    const lat = num(body.lat, -90, 90, 'Latitude');
    const lng = num(body.lng, -180, 180, 'Longitude');
    if (lat == null || lng == null) throw bad('Latitude and longitude are required.');
    if (!isInKenya(lat, lng)) throw new HttpError(400, 'outside_kenya', 'Your location is outside Kenya, so it was not recorded.');
    const accuracy = num(body.accuracy, 0, 100000, 'Accuracy');
    const heading = num(body.heading, 0, 360, 'Heading');
    const speed = num(body.speed, 0, 200, 'Speed');
    let at = isoDate(body.recordedAt, 'Recorded at') || iso();
    const t = now();
    if (new Date(at) > t + 60e3 || new Date(at) < t - 15 * 60e3) at = iso();
    const last = st('SELECT recorded_at FROM rider_locations WHERE rider_id = ?').get(user.id);
    if (last && new Date(at) - new Date(last.recorded_at) < 4000) return { ok: true, stored: false };
    tx(db, () => {
      st(`INSERT INTO rider_locations (rider_id, company_id, lat, lng, accuracy, heading, speed, recorded_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(rider_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy,
        heading = excluded.heading, speed = excluded.speed, recorded_at = excluded.recorded_at`)
        .run(user.id, user.company_id, lat, lng, accuracy, heading, speed, at);
      st('INSERT INTO location_points (company_id, rider_id, lat, lng, accuracy, speed, recorded_at) VALUES (?,?,?,?,?,?,?)')
        .run(user.company_id, user.id, lat, lng, accuracy, speed, at);
    });
    if (++pointsSincePrune >= 1000) {
      pointsSincePrune = 0;
      st('DELETE FROM location_points WHERE recorded_at < ?').run(new Date(t - 90 * 864e5).toISOString());
    }
    return { ok: true, stored: true };
  });

  route('GET', '/api/live', ({ user }) => {
    needRole(user, STAFF);
    const rows = st(`SELECT u.id, u.name, u.phone, u.tags, u.vehicle, u.on_shift, u.on_shift_since,
        l.lat, l.lng, l.accuracy, l.heading, l.speed, l.recorded_at
      FROM users u LEFT JOIN rider_locations l ON l.rider_id = u.id
      WHERE u.company_id = ? AND u.role = 'rider' AND u.active = 1 ORDER BY u.on_shift DESC, u.name`).all(user.company_id);
    const jobs = withDropoffs(st(`${REQUEST_SELECT} WHERE r.company_id = ? AND r.status IN ('assigned','collected')`).all(user.company_id));
    return {
      serverTime: iso(),
      riders: rows.map((r) => ({
        id: r.id, name: r.name, phone: r.phone, tags: parseJson(r.tags, []), vehicle: r.vehicle || 'petrol', onShift: !!r.on_shift, onShiftSince: r.on_shift_since,
        location: r.on_shift && r.lat != null
          ? { lat: r.lat, lng: r.lng, accuracy: r.accuracy, heading: r.heading, speed: r.speed, recordedAt: r.recorded_at } : null,
        jobs: jobs.filter((j) => j.rider?.id === r.id).map((j) => ({
          id: j.id, ref: j.ref, title: j.title, status: j.status, priority: j.priority, pickup: j.pickup,
          next: j.status === 'assigned' ? { kind: 'pickup', ...(j.pickups.find((p) => !p.collected) || j.pickup) } : { kind: 'drop', ...(j.dropoffs.find((d) => d.status !== 'delivered') || {}) },
        })),
      })),
    };
  });

  // Kenya-only address search: Google Geocoding (restricted to KE) when configured, else the built-in place list.
  route('GET', '/api/geocode', async ({ user, query }) => {
    needRole(user, ['requester', ...STAFF]);
    const q = str(query.get('q'), { max: 200, required: true, label: 'Search' });
    if (q.length < 2) throw bad('Type at least two characters.');
    if (integrations.geocode.configured) {
      try {
        const results = await integrations.geocode.search(q);
        if (results.length) return { results, source: 'google' };
      } catch (err) { log('error', err); }
    }
    return { results: searchPlaces(q), source: 'gazetteer' };
  });

  route('GET', '/api/config', () => ({
    maps: { browserKey: integrations.maps.browserKey || null, mapId: integrations.maps.mapId || null },
    kenyaBounds: KENYA_BOUNDS,
    geocoder: integrations.geocode.configured ? 'google' : 'gazetteer',
    routing: integrations.routes.configured ? 'google' : 'estimate',
    notifications: { whatsapp: integrations.whatsapp.configured, sms: integrations.sms.configured },
    email: integrations.email?.configured || false,
  }));

  // Fuel & quotes
  route('GET', '/api/fuel/settings', ({ user }) => ({ settings: fuelSettings(user.company_id) }));
  route('PATCH', '/api/fuel/settings', ({ user, body }) => {
    needRole(user, STAFF);
    needWriter(user);
    const cur = fuelSettings(user.company_id);
    const pick = (k, min, max, label) => (body[k] === undefined ? cur[k] : (() => {
      const v = num(body[k], min, max, label);
      if (v == null) throw bad(`${label} is required.`);
      return v;
    })());
    const next = {
      fuelPrice: pick('fuelPrice', 50, 1000, 'Fuel price per litre'),
      kmPerLitre: pick('kmPerLitre', 5, 120, 'Kilometres per litre'),
      electricityPrice: pick('electricityPrice', 1, 500, 'Electricity price per kWh'),
      kmPerKwh: pick('kmPerKwh', 5, 200, 'Kilometres per kWh'),
      timeRatePerHour: pick('timeRatePerHour', 0, 20000, 'Time rate per hour'),
      baseFee: pick('baseFee', 0, 100000, 'Base fee'),
      roadFactor: pick('roadFactor', 1, 3, 'Road factor'),
      fuelType: body.fuelType === undefined ? cur.fuelType : body.fuelType,
      defaultVehicle: body.defaultVehicle === undefined ? cur.defaultVehicle : body.defaultVehicle,
      fuelPriceUpdatedAt: body.fuelPriceUpdatedAt === undefined
        ? (body.fuelPrice !== undefined && body.fuelPrice !== cur.fuelPrice ? iso().slice(0, 10) : cur.fuelPriceUpdatedAt)
        : (isoDate(body.fuelPriceUpdatedAt, 'Price date') || iso()).slice(0, 10),
    };
    if (!['petrol', 'diesel'].includes(next.fuelType)) throw bad('Fuel type must be petrol or diesel.');
    if (!VEHICLES.includes(next.defaultVehicle)) throw bad('Default vehicle must be petrol or electric.');
    tx(db, () => {
      st(`INSERT INTO company_settings (company_id, fuel_price, fuel_type, fuel_price_updated_at, km_per_litre, time_rate_per_hour, base_fee, road_factor,
          electricity_price, km_per_kwh, default_vehicle, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET fuel_price = excluded.fuel_price, fuel_type = excluded.fuel_type,
        fuel_price_updated_at = excluded.fuel_price_updated_at, km_per_litre = excluded.km_per_litre, time_rate_per_hour = excluded.time_rate_per_hour,
        base_fee = excluded.base_fee, road_factor = excluded.road_factor, electricity_price = excluded.electricity_price,
        km_per_kwh = excluded.km_per_kwh, default_vehicle = excluded.default_vehicle, updated_by = excluded.updated_by`)
        .run(user.company_id, next.fuelPrice, next.fuelType, next.fuelPriceUpdatedAt, next.kmPerLitre, next.timeRatePerHour, next.baseFee, next.roadFactor,
          next.electricityPrice, next.kmPerKwh, next.defaultVehicle, user.id);
      logActivity(user, null, 'fuel_settings', `${user.name} updated fuel pricing (KES ${next.fuelPrice}/L ${next.fuelType}, ${next.kmPerLitre} km/L; `
        + `KES ${next.electricityPrice}/kWh, ${next.kmPerKwh} km/kWh; quotes assume ${next.defaultVehicle})`);
    });
    return { settings: fuelSettings(user.company_id) };
  });

  route('POST', '/api/fuel/quote', async ({ user, body }) => {
    needRole(user, ['requester', ...STAFF]);
    const settings = fuelSettings(user.company_id);
    let km = num(body.km, 0, 2000, 'Distance');
    let minutes = num(body.minutes, 0, 24 * 60, 'Time');
    let source = 'manual';
    if (km == null) {
      if (!Array.isArray(body.stops) || body.stops.length < 2 || body.stops.length > 13) throw bad('Give a distance, or at least two stops.');
      const stops = body.stops.map((p, i) => {
        const pin = kenyaPin(num(p?.lat, -90, 90, 'Latitude'), num(p?.lng, -180, 180, 'Longitude'), `Stop ${i + 1}`);
        if (pin.lat != null) return pin;
        const place = typeof p?.address === 'string' ? lookupPlace(p.address) : null;
        if (!place) throw bad(`Stop ${i + 1} could not be placed in Kenya. Add a pin or a known landmark or street.`);
        return { lat: place.lat, lng: place.lng };
      });
      source = 'estimate';
      if (integrations.routes.configured) {
        try {
          const r = await integrations.routes.compute(stops);
          km = r.km; if (minutes == null) minutes = r.minutes + stops.length * 5;
          source = 'google';
        } catch (err) { log('error', err); }
      }
      if (source === 'estimate') km = routeKm(stops, settings.roadFactor);
      if (minutes == null) minutes = estimateMinutes(km, stops.length);
    }
    if (minutes == null) minutes = estimateMinutes(km, 2);
    const vehicle = VEHICLES.includes(body.vehicle) ? body.vehicle : settings.defaultVehicle;
    const other = vehicle === 'electric' ? 'petrol' : 'electric';
    return { quote: quote({ km, minutes, vehicle }, settings), compare: quote({ km, minutes, vehicle: other }, settings), source, settings };
  });

  route('GET', '/api/fuel/report', ({ user, query }) => {
    needRole(user, STAFF);
    const days = Math.min(Math.max(Number(query.get('days')) || 7, 1), 90);
    const since = new Date(now() - days * 864e5).toISOString();
    const until = iso();
    const settings = fuelSettings(user.company_id);
    const riders = st(`SELECT id, name, vehicle FROM users WHERE company_id = ? AND role = 'rider' ORDER BY name`).all(user.company_id);
    const trips = st(`SELECT r.*, k.name AS rider_name FROM requests r JOIN users k ON k.id = r.rider_id
      WHERE r.company_id = ? AND r.status = 'delivered' AND r.delivered_at >= ? ORDER BY r.delivered_at DESC LIMIT 300`).all(user.company_id, since)
      .map((r) => {
        const f = requestFuel(r, st('SELECT * FROM dropoffs WHERE request_id = ? ORDER BY seq').all(r.id), settings);
        const a = f.actual || f.estimate;
        return { id: r.id, ref: refOf(r.id), title: r.title, rider: { id: r.rider_id, name: r.rider_name }, deliveredAt: r.delivered_at, ...a };
      });
    const perRider = riders.map((rd) => {
      const km = trackKm(riderTrack(rd.id, since, until));
      const e = energyFor(km, rd.vehicle, settings);
      const shiftHours = st(`SELECT COALESCE(SUM((julianday(MIN(ends_at, ?)) - julianday(MAX(starts_at, ?))) * 24), 0) AS h
        FROM shifts WHERE rider_id = ? AND ends_at > ?`).get(until, since, rd.id, since).h;
      const mine = trips.filter((t) => t.rider.id === rd.id);
      return {
        id: rd.id, name: rd.name, vehicle: e.vehicle, gpsKm: Math.round(km * 10) / 10, unit: e.unit, energy: Math.round(e.amount * 100) / 100,
        litres: e.vehicle === 'petrol' ? Math.round(e.amount * 100) / 100 : 0, kwh: e.vehicle === 'electric' ? Math.round(e.amount * 100) / 100 : 0,
        fuelCost: Math.round(e.cost), deliveries: mine.length, shiftHours: Math.round(shiftHours * 10) / 10,
        quoted: mine.reduce((sum, t) => sum + t.total, 0),
      };
    }).filter((r) => r.gpsKm > 0 || r.deliveries > 0 || r.shiftHours > 0);
    const totals = perRider.reduce((t, r) => ({
      gpsKm: t.gpsKm + r.gpsKm, litres: t.litres + r.litres, kwh: t.kwh + r.kwh, fuelCost: t.fuelCost + r.fuelCost,
      petrolCost: t.petrolCost + (r.vehicle === 'petrol' ? r.fuelCost : 0), electricCost: t.electricCost + (r.vehicle === 'electric' ? r.fuelCost : 0),
      deliveries: t.deliveries + r.deliveries, quoted: t.quoted + r.quoted,
    }), { gpsKm: 0, litres: 0, kwh: 0, fuelCost: 0, petrolCost: 0, electricCost: 0, deliveries: 0, quoted: 0 });
    return { days, settings, riders: perRider, trips, totals };
  });
  // WhatsApp Cloud API webhook: delivery statuses. A failed WhatsApp message falls back to SMS.
  route('GET', '/api/webhooks/whatsapp', ({ query }) => {
    const token = integrations.whatsapp.verifyToken;
    if (!token || query.get('hub.mode') !== 'subscribe' || query.get('hub.verify_token') !== token) throw forbidden('Verification failed.');
    return { __text: query.get('hub.challenge') || '' };
  }, { public: true });

  route('POST', '/api/webhooks/whatsapp', ({ req, body, raw }) => {
    if (!integrations.whatsapp.validSignature(raw, req.headers['x-hub-signature-256'])) throw forbidden('Invalid signature.');
    const RANK = { sent: 1, delivered: 2, read: 3 };
    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        for (const stt of Array.isArray(change?.value?.statuses) ? change.value.statuses : []) {
          if (typeof stt?.id !== 'string') continue;
          const n = st(`SELECT * FROM notifications WHERE provider_id = ? AND channel = 'whatsapp'`).get(stt.id);
          if (!n || n.status === 'failed') continue;
          if (stt.status === 'failed') {
            const error = String(stt.errors?.[0]?.title || stt.errors?.[0]?.message || 'WhatsApp could not deliver the message').slice(0, 300);
            st(`UPDATE notifications SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(error, iso(), n.id);
            const rider = st('SELECT name FROM users WHERE id = ?').get(n.user_id);
            logSystem(n.company_id, n.request_id, 'notify_failed', `WhatsApp could not deliver to ${rider?.name}: ${error}`, { channel: 'whatsapp' });
            const reqRow = st('SELECT rider_id, status FROM requests WHERE id = ?').get(n.request_id);
            const smsAlready = st(`SELECT 1 FROM notifications WHERE request_id = ? AND user_id = ? AND channel = 'sms' AND id > ?`).get(n.request_id, n.user_id, n.id);
            if (reqRow?.rider_id === n.user_id && ['assigned', 'collected'].includes(reqRow.status) && !smsAlready && integrations.sms.configured) {
              background(notifyRider(n.request_id, { smsOnly: true }));
            }
          } else if (RANK[stt.status] > (RANK[n.status] || 0)) {
            st('UPDATE notifications SET status = ?, updated_at = ? WHERE id = ?').run(stt.status, iso(), n.id);
          }
        }
      }
    }
    return { ok: true };
  }, { public: true, webhook: true });

  // Activity
  function activityOut(a) {
    return {
      id: a.id, requestId: a.request_id, ref: a.request_id ? `RR-${String(a.request_id).padStart(4, '0')}` : null,
      user: a.user_name, action: a.action, message: a.message, meta: parseJson(a.meta, null), createdAt: a.created_at,
    };
  }
  route('GET', '/api/activity', ({ user, query }) => {
    const limit = Math.min(Number(query.get('limit')) || 100, 5000);
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
    // Future pickups that haven't been collected yet.
    const scheduled = st(`SELECT COUNT(*) AS n FROM requests r WHERE ${where} AND r.status IN ('pending','assigned') AND r.scheduled_at > ?`)
      .get(...params, iso()).n;
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
      riders = st(`SELECT u.id, u.name, u.tags,
          (SELECT COUNT(*) FROM requests r WHERE r.rider_id = u.id AND r.status IN ('assigned','collected')) AS open_jobs,
          (SELECT COUNT(*) FROM requests r WHERE r.rider_id = u.id AND r.status = 'delivered' AND r.delivered_at >= ?) AS done_today,
          u.on_shift, u.on_shift_since, u.phone, u.vehicle
        FROM users u WHERE u.company_id = ? AND u.role = 'rider' AND u.active = 1 ORDER BY u.name`)
        .all(startOfDay.toISOString(), user.company_id)
        .map((r) => ({ id: r.id, name: r.name, phone: r.phone, tags: parseJson(r.tags, []), openJobs: r.open_jobs, doneToday: r.done_today,
          onShift: !!r.on_shift, onShiftSince: r.on_shift_since || null, vehicle: r.vehicle || 'petrol' }));
    }
    return { byStatus, deliveredToday, urgentOpen, reservedWaiting, scheduled, avgMinutes: avg ? Math.round(avg) : null, days, riders };
  });

  // ---------- HTTP plumbing ----------
  function send(res, status, data, headers = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  async function readBody(req, limit = BODY_LIMIT) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'too_large', 'Request body is too large.');
      chunks.push(chunk);
    }
    if (!size) return { body: {}, raw: Buffer.alloc(0) };
    if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'json_only', 'Send JSON.');
    const raw = Buffer.concat(chunks);
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return { body: parsed, raw };
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
    if (mutating && !match.r.opts.webhook) {
      const o = req.headers.origin;
      if (!o || o !== allowedOrigin) throw new HttpError(403, 'bad_origin', 'Cross-origin request blocked.');
    }
    const { body, raw } = mutating ? await readBody(req, match.r.opts.bodyLimit) : { body: {}, raw: Buffer.alloc(0) };
    const ctx = { req, res, body, raw, params: match.params, query: url.searchParams };
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
    if (out && out.__binary) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': out.type, 'Cache-Control': 'private, max-age=86400', 'Content-Length': out.__binary.length });
      return res.end(out.__binary);
    }
    if (out && typeof out.__text === 'string') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(out.__text);
    }
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

  async function handler(req, res) {
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
  }
  /** Resolves when background work (rider notifications) has finished. Used by tests and shutdown. */
  handler.idle = () => Promise.allSettled([...inflight]);
  return handler;
}

export { RESERVED };
