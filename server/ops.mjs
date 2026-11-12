// Operations added after the MVP demo (v2):
//   rider availability & standby · emergency/incident reports with photo/video evidence ·
//   pickup/drop-off location changes with rider acknowledgement · ETA · client ratings ·
//   contact history · shift length, overtime requests and reports · announcements · in-app inbox ·
//   Android push tokens · offline GPS upload · Africa's Talking delivery reports.
// Everything here uses the same database, sessions and role rules as the rest of the API.
import { isInKenya, lookupPlace } from '../dist/js/kenya.js';
import { haversineKm } from '../dist/js/fuel.js';

export const DETAIL_KEYS = ['building', 'buildingNo', 'floor', 'unit', 'gate', 'landmark', 'directions'];
export const AVAILABILITY = ['available', 'assigned', 'on_delivery', 'on_break', 'offline'];
const INCIDENT_TYPES = { accident: 'a road accident', breakdown: 'a vehicle breakdown', medical: 'a medical emergency', security: 'a security incident', other: 'an emergency' };
const SEVERITY = { accident: 'critical', medical: 'critical', security: 'critical', breakdown: 'high', other: 'high' };
const VIDEO_MAX = 30 * 1024 * 1024;
const SIGNIFICANT_KM = 0.3;
const GPS_MATCH_KM = 0.3;
const DEFAULTS = {
  max_active_jobs: 2, standby_timeout_min: 15, break_max_min: 60, shift_hours: 8, overtime_max_hours: 4,
  sms_recipients: 0, sms_fallback_seconds: 90, dispatch_phone: null,
};

export function registerOps(k) {
  const {
    route, st, tx, db, iso, now, hub, notifier, TEMPLATES, integrations, origin, log,
    HttpError, bad, forbidden, notFound, needWriter, needRole, str, num, intId, isoDate, parseJson, readImage, kenyaPin, readDetails, detailsJson,
    logActivity, getVisibleRequestRow, getVisibleRequest, refOf, isStaff, canWrite, fuelSettings, securityHeaders, proofBodyLimit,
  } = k;
  const t2 = (isoStr) => new Date(isoStr).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' });
  const minutesSince = (isoStr, at = now()) => (isoStr ? Math.max(0, Math.round((at - new Date(isoStr).getTime()) / 60e3)) : 0);
  const trackUrl = (id) => `${origin}/#/requests/${id}`;

  // ---------- settings ----------
  function settings(companyId) {
    return { ...DEFAULTS, ...(st('SELECT * FROM ops_settings WHERE company_id = ?').get(companyId) || {}) };
  }
  const settingsOut = (s) => ({
    maxActiveJobs: s.max_active_jobs, standbyTimeoutMin: s.standby_timeout_min, breakMaxMin: s.break_max_min, shiftHours: s.shift_hours,
    overtimeMaxHours: s.overtime_max_hours, smsRecipients: !!s.sms_recipients, smsFallbackSeconds: s.sms_fallback_seconds, dispatchPhone: s.dispatch_phone,
  });
  const publicSettings = (companyId) => settingsOut(settings(companyId));

  route('GET', '/api/ops/settings', ({ user }) => {
    if (!isStaff(user) && user.role !== 'rider') throw forbidden();
    return { settings: publicSettings(user.company_id) };
  });
  route('PATCH', '/api/ops/settings', ({ user, body }) => {
    if (user.role !== 'admin') throw forbidden('Only administrators can change operational settings.');
    const cur = settings(user.company_id);
    const pick = (key, v, min, max, label, int = true) => {
      if (v === undefined) return cur[key];
      const n = num(v, min, max, label);
      if (n == null || (int && !Number.isInteger(n))) throw bad(`${label} must be ${int ? 'a whole number' : 'a number'} between ${min} and ${max}.`);
      return n;
    };
    const next = {
      max_active_jobs: pick('max_active_jobs', body.maxActiveJobs, 1, 10, 'Active jobs per rider'),
      standby_timeout_min: pick('standby_timeout_min', body.standbyTimeoutMin, 5, 240, 'Standby timeout (minutes)'),
      break_max_min: pick('break_max_min', body.breakMaxMin, 5, 240, 'Maximum break (minutes)'),
      shift_hours: pick('shift_hours', body.shiftHours, 1, 16, 'Standard shift (hours)', false),
      overtime_max_hours: pick('overtime_max_hours', body.overtimeMaxHours, 0.5, 8, 'Maximum overtime (hours)', false),
      sms_fallback_seconds: pick('sms_fallback_seconds', body.smsFallbackSeconds, 30, 900, 'SMS fallback delay (seconds)'),
      sms_recipients: body.smsRecipients === undefined ? cur.sms_recipients : body.smsRecipients ? 1 : 0,
      dispatch_phone: body.dispatchPhone === undefined ? cur.dispatch_phone : str(body.dispatchPhone, { max: 40, label: 'Dispatch phone' }),
    };
    st(`INSERT INTO ops_settings (company_id, max_active_jobs, standby_timeout_min, break_max_min, shift_hours, overtime_max_hours, sms_recipients,
        sms_fallback_seconds, dispatch_phone, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(company_id) DO UPDATE SET max_active_jobs = excluded.max_active_jobs, standby_timeout_min = excluded.standby_timeout_min,
        break_max_min = excluded.break_max_min, shift_hours = excluded.shift_hours, overtime_max_hours = excluded.overtime_max_hours,
        sms_recipients = excluded.sms_recipients, sms_fallback_seconds = excluded.sms_fallback_seconds, dispatch_phone = excluded.dispatch_phone,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(user.company_id, next.max_active_jobs, next.standby_timeout_min, next.break_max_min, next.shift_hours, next.overtime_max_hours,
        next.sms_recipients, next.sms_fallback_seconds, next.dispatch_phone, user.id, iso());
    logActivity(user, null, 'ops_settings', `${user.name} updated operational settings`, settingsOut(next));
    return { settings: publicSettings(user.company_id) };
  });

  // ---------- real-time stream ----------
  route('GET', '/api/events', ({ req, res, user }) => {
    hub.attach(req, res, user, securityHeaders);
    return { __stream: true };
  });

  // ---------- availability ----------
  const staffUsers = (companyId) => st(`SELECT * FROM users WHERE company_id = ? AND role IN ('admin','dispatcher') AND active = 1`).all(companyId);
  const userRow = (id) => (id ? st('SELECT * FROM users WHERE id = ?').get(id) : null);

  function shiftTotals(rider, endIso = iso()) {
    const s = settings(rider.company_id);
    if (!rider.on_shift_since) return { workedMinutes: 0, plannedMinutes: Math.round(s.shift_hours * 60), overtimeMinutes: 0, approvedMinutes: 0 };
    const worked = minutesSince(rider.on_shift_since, new Date(endIso).getTime());
    const planned = Math.round(s.shift_hours * 60);
    const approved = st(`SELECT COALESCE(SUM(minutes), 0) AS m FROM overtime WHERE rider_id = ? AND shift_started_at = ? AND status = 'approved'`)
      .get(rider.id, rider.on_shift_since).m;
    return { workedMinutes: worked, plannedMinutes: planned, overtimeMinutes: Math.max(0, worked - planned), approvedMinutes: approved };
  }

  function availabilityOf(u, counts, s, at = now()) {
    const lastSeen = [u.last_seen_at, counts.loc_at].filter(Boolean).sort().at(-1) || null;
    const status = !u.on_shift ? 'offline' : u.break_since ? 'on_break' : counts.collected_n ? 'on_delivery' : counts.assigned_n ? 'assigned' : 'available';
    const open = counts.assigned_n + counts.collected_n;
    const shift = u.on_shift ? shiftTotals(u, new Date(at).toISOString()) : null;
    return {
      availability: status,
      lastSeenAt: lastSeen,
      lastActivityAt: counts.last_act || null,
      // Standby timeout: an on-shift rider whose app has not been heard from in time is flagged.
      unresponsive: !!u.on_shift && (!lastSeen || at - new Date(lastSeen).getTime() > s.standby_timeout_min * 60e3),
      breakSince: u.break_since || null,
      breakOverdue: !!u.break_since && minutesSince(u.break_since, at) > s.break_max_min,
      openJobs: open,
      atCapacity: open >= s.max_active_jobs,
      rating: counts.n_r ? { avg: Math.round(counts.avg * 10) / 10, count: counts.n_r } : null,
      shift: shift && { ...shift, overLimit: shift.overtimeMinutes > shift.approvedMinutes },
    };
  }

  function availabilityMap(companyId) {
    const s = settings(companyId);
    const rows = st(`SELECT u.*,
        (SELECT COUNT(*) FROM requests r WHERE r.rider_id = u.id AND r.status = 'assigned') AS assigned_n,
        (SELECT COUNT(*) FROM requests r WHERE r.rider_id = u.id AND r.status = 'collected') AS collected_n,
        (SELECT recorded_at FROM rider_locations l WHERE l.rider_id = u.id) AS loc_at,
        (SELECT AVG(stars) FROM ratings g WHERE g.rider_id = u.id) AS avg,
        (SELECT COUNT(*) FROM ratings g WHERE g.rider_id = u.id) AS n_r,
        (SELECT MAX(created_at) FROM activity a WHERE a.user_id = u.id) AS last_act
      FROM users u WHERE u.company_id = ? AND u.role = 'rider' AND u.active = 1`).all(companyId);
    return new Map(rows.map((u) => [u.id, availabilityOf(u, u, s)]));
  }
  function availabilitySummary(riders) {
    const c = Object.fromEntries(AVAILABILITY.map((a) => [a, 0]));
    for (const r of riders) if (r.availability) c[r.availability]++;
    return { ...c, unresponsive: riders.filter((r) => r.unresponsive).length, total: riders.length, readyNow: riders.filter((r) => r.availability === 'available' && !r.unresponsive).length };
  }

  /** Conflicts that need an authorised override: rider on break, or already at the active-job limit. */
  function busyConflicts(rider, excludeRequestId = 0) {
    const s = settings(rider.company_id);
    const out = [];
    if (rider.on_shift && rider.break_since) {
      out.push({ code: 'rider_on_break', message: `${rider.name} is on a break since ${t2(rider.break_since)}.`, selfMessage: 'End your break before accepting jobs.' });
    }
    const open = st(`SELECT COUNT(*) AS n FROM requests WHERE rider_id = ? AND status IN ('assigned','collected') AND id != ?`).get(rider.id, excludeRequestId).n;
    if (open >= s.max_active_jobs) {
      out.push({
        code: 'rider_at_capacity', message: `${rider.name} already has ${open} active job${open === 1 ? '' : 's'} (limit ${s.max_active_jobs}).`,
        selfMessage: `You already have ${open} active job${open === 1 ? '' : 's'}. Finish one before accepting another.`,
      });
    }
    return out;
  }
  function assignWarnings(rider) {
    const w = [];
    if (!rider.on_shift) w.push({ code: 'rider_offline', message: `${rider.name} is offline (clocked out). They will see the job when they clock in.` });
    else {
      const a = availabilityMap(rider.company_id).get(rider.id);
      if (a?.unresponsive) w.push({ code: 'rider_unresponsive', message: `${rider.name}'s app has not been heard from since ${a.lastSeenAt ? t2(a.lastSeenAt) : 'they clocked in'}.` });
    }
    return w;
  }

  // Riders set Available / On break themselves; Assigned and On delivery follow their jobs; Offline = clocked out.
  route('POST', '/api/riders/:id/availability', ({ user, params, body }) => {
    const id = intId(params.id, 'rider');
    if (user.role === 'manager') throw forbidden('Managers have read-only access.');
    if (!canWrite(user) && user.id !== id) throw forbidden('You can only change your own status.');
    const rider = st(`SELECT * FROM users WHERE id = ? AND company_id = ? AND role = 'rider'`).get(id, user.company_id);
    if (!rider) throw notFound('Rider not found.');
    const status = body.status;
    if (!['available', 'on_break'].includes(status)) throw bad('Set the status to available or on_break. Clock in or out to go online or offline.');
    if (!rider.on_shift) throw new HttpError(409, 'off_shift', 'Clock in first.');
    if (status === 'on_break') {
      const open = st(`SELECT COUNT(*) AS n FROM requests WHERE rider_id = ? AND status IN ('assigned','collected')`).get(id).n;
      if (open) throw new HttpError(409, 'has_jobs', `Finish or hand back your ${open} active job${open > 1 ? 's' : ''} before taking a break.`);
      if (!rider.break_since) {
        st('UPDATE users SET break_since = ? WHERE id = ?').run(iso(), id);
        logActivity(user, null, 'break_start', user.id === id ? `${rider.name} went on break` : `${user.name} put ${rider.name} on break`);
      }
    } else if (rider.break_since) {
      st('UPDATE users SET break_since = NULL WHERE id = ?').run(id);
      logActivity(user, null, 'break_end', `${rider.name} is back from break (${minutesSince(rider.break_since)} min)`);
    }
    hub.publish(user.company_id, 'riders', { id });
    return { rider: { id, ...availabilityMap(user.company_id).get(id) } };
  });

  // ---------- GPS on proof records ----------
  function stopPin(row, kind, seq) {
    if (kind === 'pickup') {
      if (seq === 1) return row.pickup_lat != null ? { lat: row.pickup_lat, lng: row.pickup_lng } : null;
      const p = st('SELECT lat, lng FROM pickups WHERE request_id = ? AND seq = ?').get(row.id, seq);
      return p?.lat != null ? p : null;
    }
    const d = st('SELECT lat, lng FROM dropoffs WHERE request_id = ? AND seq = ?').get(row.id, seq);
    return d?.lat != null ? d : null;
  }
  /** Phone GPS sent with a collection/handover. Compared with the stop's pin when there is one. */
  function readGps(v, pin) {
    if (!v || typeof v !== 'object') return { status: 'unconnected', lat: null, lng: null, accuracy: null, recordedAt: null };
    const lat = num(v.lat, -90, 90, 'GPS latitude'), lng = num(v.lng, -180, 180, 'GPS longitude');
    if (lat == null || lng == null) return { status: 'unconnected', lat: null, lng: null, accuracy: null, recordedAt: null };
    const accuracy = num(v.accuracy, 0, 100000, 'GPS accuracy');
    const recordedAt = isoDate(v.recordedAt, 'GPS time');
    let status = 'captured';
    if (!isInKenya(lat, lng)) status = 'outside_kenya';
    else if (pin) status = haversineKm(pin, { lat, lng }) <= Math.max(GPS_MATCH_KM, (accuracy || 0) / 1000) ? 'verified' : 'distant';
    return { status, lat, lng, accuracy, recordedAt };
  }

  // ---------- location changes ----------
  function stopsOf(requestId) {
    const r = st('SELECT * FROM requests WHERE id = ?').get(requestId);
    const pick = (x) => ({ address: x.address, lat: x.lat, lng: x.lng, details: parseJson(x.details, null), contactName: x.contact_name, contactPhone: x.contact_phone });
    return [
      { kind: 'pickup', seq: 1, ...pick({ address: r.pickup_address, lat: r.pickup_lat, lng: r.pickup_lng, details: r.pickup_details, contact_name: r.pickup_contact_name, contact_phone: r.pickup_contact_phone }) },
      ...st('SELECT * FROM pickups WHERE request_id = ? ORDER BY seq').all(requestId).map((p) => ({ kind: 'pickup', seq: p.seq, ...pick(p) })),
      ...st('SELECT * FROM dropoffs WHERE request_id = ? ORDER BY seq').all(requestId).map((d) => ({ kind: 'dropoff', seq: d.seq, ...pick(d), instructions: d.instructions })),
    ];
  }
  const sameStop = (a, b) => a.address === b.address && a.lat === b.lat && a.lng === b.lng && JSON.stringify(a.details) === JSON.stringify(b.details);
  const placeOf = (s) => (s.lat != null ? { lat: s.lat, lng: s.lng } : lookupPlace(s.address));
  const stopLabel = (kind, seq, total) => (kind === 'pickup' ? (total > 1 ? `pickup ${seq}` : 'pickup') : `drop-off ${seq}`);

  /** Records every changed stop; tells an assigned rider at once and asks them to confirm significant changes. */
  function recordStopChanges(user, row, before, after, reason) {
    const changes = [];
    const pickups = after.filter((s) => s.kind === 'pickup').length;
    const active = row.rider_id && ['assigned', 'collected'].includes(row.status);
    for (const b of before) {
      const a = after.find((x) => x.kind === b.kind && x.seq === b.seq);
      if (!a || sameStop(a, b)) continue;
      const pa = placeOf(a), pb = placeOf(b);
      const km = pa && pb ? Math.round(haversineKm(pa, pb) * 100) / 100 : null;
      const significant = a.address !== b.address ? (km == null || km > SIGNIFICANT_KM || a.lat == null || b.lat == null) : km != null && km > SIGNIFICANT_KM;
      const res = st(`INSERT INTO location_changes (company_id, request_id, stop_kind, stop_seq, old_value, new_value, distance_km, significant, reason, changed_by, rider_id, acknowledged_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.company_id, row.id, b.kind, b.seq, JSON.stringify(b), JSON.stringify(a), km, significant ? 1 : 0, reason,
        user.id, active ? row.rider_id : null, active && significant ? null : iso(), iso());
      const label = stopLabel(b.kind, b.seq, pickups);
      logActivity(user, row.id, 'location_changed', `${user.name} changed the ${label}: ${b.address} → ${a.address}${km != null ? ` (${km} km)` : ''}${reason ? ` — ${reason}` : ''}`,
        { kind: b.kind, seq: b.seq, significant, km });
      changes.push({ id: Number(res.lastInsertRowid), kind: b.kind, seq: b.seq, significant, label, address: a.address });
    }
    if (changes.length && active) {
      const rider = userRow(row.rider_id);
      for (const c of changes) {
        const tpl = TEMPLATES.locationChanged({ ref: refOf(row.id), what: c.label, address: c.address, by: user.name });
        notifier.notify({
          users: [rider], event: 'location_changed', ...tpl, linkPath: `/requests/${row.id}`, requestId: row.id, critical: c.significant,
          dedupe: `locchg:${c.id}`,
        });
      }
    }
    if (changes.length) hub.publish(row.company_id, 'request', { id: row.id, change: 'location' });
    return changes;
  }

  /** Blocks collection/handover at a stop whose significant change the rider has not confirmed. */
  function requireAcknowledged(requestId, kind, seq) {
    const p = st(`SELECT id FROM location_changes WHERE request_id = ? AND stop_kind = ? AND stop_seq = ? AND significant = 1 AND acknowledged_at IS NULL
      AND rider_id = (SELECT rider_id FROM requests WHERE id = ?)`).get(requestId, kind, seq, requestId);
    if (p) throw new HttpError(409, 'ack_required', `The ${kind === 'pickup' ? 'pickup' : 'drop-off'} address changed. Confirm the new address before recording this stop.`, { changeId: p.id });
  }

  // Requester (own request) or dispatch changes one stop while the delivery is under way. Stop ids stay the same.
  route('POST', '/api/requests/:id/stops/change', ({ user, params, body }) => {
    const id = intId(params.id);
    if (!Number.isInteger(body?.version)) throw bad('The current version is required for updates.');
    const row = getVisibleRequestRow(user, id);
    if (user.role === 'rider') throw forbidden('Riders cannot change addresses. Ask dispatch or the requester.');
    if (user.role === 'manager') throw forbidden('Managers have read-only access.');
    if (!canWrite(user) && row.requester_id !== user.id) throw forbidden('You can only change your own requests.');
    if (['delivered', 'cancelled'].includes(row.status)) throw new HttpError(409, 'locked', 'This request is finished.');
    const kind = body.kind === 'pickup' ? 'pickup' : body.kind === 'dropoff' ? 'dropoff' : null;
    if (!kind) throw bad('Say which stop changes: pickup or dropoff.');
    const seq = intId(body.seq, 'stop');
    const before = stopsOf(id);
    const cur = before.find((s) => s.kind === kind && s.seq === seq);
    if (!cur) throw notFound('Stop not found.');
    if (kind === 'pickup') {
      const done = st(`SELECT 1 FROM records WHERE request_id = ? AND kind = 'collection' AND COALESCE(pickup_seq, 1) = ?`).get(id, seq);
      if (done) throw new HttpError(409, 'locked', 'This pickup was already collected.');
    } else if (st('SELECT status FROM dropoffs WHERE request_id = ? AND seq = ?').get(id, seq).status === 'delivered') {
      throw new HttpError(409, 'locked', 'This drop-off was already delivered.');
    }
    const label = kind === 'pickup' ? 'Pickup' : `Drop-off ${seq}`;
    const next = {
      address: str(body.address, { max: 300, required: true, label: `${label} address` }),
      ...kenyaPin(num(body.lat, -90, 90, `${label} latitude`), num(body.lng, -180, 180, `${label} longitude`), `The ${label.toLowerCase()} pin`),
      details: readDetails(body.details, label),
      contactName: body.contactName === undefined ? cur.contactName : str(body.contactName, { max: 120, label: `${label} contact` }),
      contactPhone: body.contactPhone === undefined ? cur.contactPhone : str(body.contactPhone, { max: 40, label: `${label} phone` }),
    };
    const instructions = kind === 'dropoff' ? (body.instructions === undefined ? cur.instructions : str(body.instructions, { max: 500, label: `${label} instructions` })) : null;
    const reason = str(body.reason, { max: 300, label: 'Reason' });
    if (sameStop({ ...cur }, { ...cur, ...next }) && next.contactName === cur.contactName && next.contactPhone === cur.contactPhone && instructions === (cur.instructions ?? null)) {
      return { request: getVisibleRequest(user, id), changes: [] };
    }
    const changes = tx(db, () => {
      const r = st(`UPDATE requests SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).run(iso(), id, body.version);
      if (!r.changes) throw new HttpError(409, 'stale', 'This request was changed by someone else. The latest version has been loaded.', { current: getVisibleRequest(user, id) });
      if (kind === 'pickup' && seq === 1) {
        st(`UPDATE requests SET pickup_address = ?, pickup_lat = ?, pickup_lng = ?, pickup_details = ?, pickup_contact_name = ?, pickup_contact_phone = ? WHERE id = ?`)
          .run(next.address, next.lat, next.lng, detailsJson(next.details), next.contactName, next.contactPhone, id);
      } else if (kind === 'pickup') {
        st(`UPDATE pickups SET address = ?, lat = ?, lng = ?, details = ?, contact_name = ?, contact_phone = ? WHERE request_id = ? AND seq = ?`)
          .run(next.address, next.lat, next.lng, detailsJson(next.details), next.contactName, next.contactPhone, id, seq);
      } else {
        st(`UPDATE dropoffs SET address = ?, lat = ?, lng = ?, details = ?, contact_name = ?, contact_phone = ?, instructions = ? WHERE request_id = ? AND seq = ?`)
          .run(next.address, next.lat, next.lng, detailsJson(next.details), next.contactName, next.contactPhone, instructions, id, seq);
      }
      const after = stopsOf(id);
      const ch = recordStopChanges(user, row, before, after, reason);
      if (!ch.length) logActivity(user, id, 'edited', `${user.name} updated the ${stopLabel(kind, seq, after.filter((s) => s.kind === 'pickup').length)} contact details`);
      return ch;
    });
    return { request: getVisibleRequest(user, id), changes };
  });

  route('POST', '/api/requests/:id/location-changes/:cid/ack', ({ user, params }) => {
    const id = intId(params.id);
    const row = getVisibleRequestRow(user, id);
    if (row.rider_id !== user.id) throw forbidden('Only the assigned rider confirms address changes.');
    const c = st('SELECT * FROM location_changes WHERE id = ? AND request_id = ?').get(intId(params.cid, 'change'), id);
    if (!c) throw notFound('Change not found.');
    if (!c.acknowledged_at) {
      st('UPDATE location_changes SET acknowledged_at = ?, rider_id = ? WHERE id = ?').run(iso(), user.id, c.id);
      const v = parseJson(c.new_value, {});
      logActivity(user, id, 'location_ack', `${user.name} confirmed the new ${c.stop_kind === 'pickup' ? 'pickup' : `drop-off ${c.stop_seq}`}: ${v.address}`);
    }
    return { ok: true };
  });

  const changeOut = (c) => ({
    id: c.id, kind: c.stop_kind, seq: c.stop_seq, from: parseJson(c.old_value, {}), to: parseJson(c.new_value, {}), distanceKm: c.distance_km,
    significant: !!c.significant, reason: c.reason, by: c.by_name, at: c.created_at, needsAck: !!c.significant && !c.acknowledged_at && !!c.rider_id, acknowledgedAt: c.acknowledged_at,
  });

  // ---------- ETA ----------
  const etaCache = new Map();
  route('GET', '/api/requests/:id/eta', async ({ user, params }) => {
    const id = intId(params.id);
    const req = getVisibleRequest(user, id);
    if (!req.rider || !['assigned', 'collected'].includes(req.status)) return { available: false, reason: 'No rider is on the way.' };
    const loc = st(`SELECT l.*, u.on_shift FROM rider_locations l JOIN users u ON u.id = l.rider_id WHERE l.rider_id = ?`).get(req.rider.id);
    if (!loc?.on_shift) return { available: false, reason: 'The rider is not sharing a live position.' };
    const next = req.status === 'assigned'
      ? { kind: 'pickup', ...(req.pickups.find((p) => !p.collected) || req.pickup) }
      : { kind: 'dropoff', ...(req.dropoffs.find((d) => d.status !== 'delivered') || {}) };
    const place = next.lat != null ? { lat: next.lat, lng: next.lng } : next.address ? lookupPlace(next.address) : null;
    if (!place) return { available: false, reason: 'The next stop has no map position.' };
    const from = { lat: loc.lat, lng: loc.lng };
    const key = `${id}:${next.kind}:${next.seq}:${from.lat.toFixed(3)}:${from.lng.toFixed(3)}`;
    const hit = etaCache.get(key);
    if (hit && hit.at > now() - 60e3) return hit.value;
    let km, minutes, source = 'estimate';
    if (integrations.routes.configured) {
      try { ({ km, minutes } = await integrations.routes.compute([from, place])); source = 'google'; } catch (err) { log('error', err); }
    }
    if (source === 'estimate') {
      const factor = fuelSettings(user.company_id).roadFactor || 1.3;
      km = haversineKm(from, place) * factor;
      minutes = (km / 22) * 60 + 2; // motorbike in city traffic, plus parking
    }
    const value = {
      available: true, km: Math.round(km * 10) / 10, minutes: Math.max(1, Math.round(minutes)), source, arriveBy: new Date(now() + minutes * 60e3).toISOString(),
      to: { kind: next.kind, seq: next.seq, address: next.address }, positionAt: loc.recorded_at,
    };
    etaCache.set(key, { at: now(), value });
    if (etaCache.size > 500) etaCache.delete(etaCache.keys().next().value);
    return value;
  });

  // ---------- ratings ----------
  const ratingOut = (g, full) => g && ({
    stars: g.stars, professionalism: g.professionalism, timeliness: g.timeliness, communication: g.communication, handling: g.handling,
    ...(full ? { comment: g.comment, by: g.rater_name } : {}), createdAt: g.created_at,
  });
  route('POST', '/api/requests/:id/rating', ({ user, params, body }) => {
    const id = intId(params.id);
    const row = getVisibleRequestRow(user, id);
    if (row.requester_id !== user.id || user.role === 'rider') throw forbidden('Only the client who requested this delivery can rate the rider.');
    if (row.status !== 'delivered' || !row.rider_id) throw new HttpError(409, 'bad_state', 'You can rate the rider once the delivery is complete.');
    const score = (v, label, required = false) => {
      if (v === undefined || v === null || v === '') { if (required) throw bad(`${label} is required.`); return null; }
      if (!Number.isInteger(v) || v < 1 || v > 5) throw bad(`${label} must be 1 to 5 stars.`);
      return v;
    };
    const g = {
      stars: score(body.stars, 'Overall rating', true), professionalism: score(body.professionalism, 'Professionalism'), timeliness: score(body.timeliness, 'Timeliness'),
      communication: score(body.communication, 'Communication'), handling: score(body.handling, 'Handling of items'),
      comment: str(body.comment, { max: 1000, label: 'Feedback' }),
    };
    const res = st(`INSERT OR IGNORE INTO ratings (company_id, request_id, rider_id, rater_id, stars, professionalism, timeliness, communication, handling, comment, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(row.company_id, id, row.rider_id, user.id, g.stars, g.professionalism, g.timeliness, g.communication, g.handling, g.comment, iso());
    if (!res.changes) throw new HttpError(409, 'already_rated', 'This delivery has already been rated.');
    logActivity(user, id, 'rated', `${user.name} rated ${row.rider_name} ${'★'.repeat(g.stars)}${'☆'.repeat(5 - g.stars)}`, { stars: g.stars });
    return { rating: ratingOut({ ...g, created_at: iso(), rater_name: user.name }, true) };
  });

  // ---------- communication ----------
  route('POST', '/api/requests/:id/contact', ({ user, params, body }) => {
    const id = intId(params.id);
    const row = getVisibleRequestRow(user, id);
    const target = String(body.target || '');
    const channel = ['call', 'sms', 'whatsapp'].includes(body.channel) ? body.channel : 'call';
    const m = /^(rider|requester|dispatch|pickup:\d{1,2}|dropoff:\d{1,2})$/.exec(target);
    if (!m) throw bad('Unknown contact.');
    const allowed = isStaff(user) || (user.role === 'rider' ? row.rider_id === user.id && target !== 'rider' : row.requester_id === user.id && ['rider', 'dispatch'].includes(target));
    if (!allowed) throw forbidden();
    st('INSERT INTO contact_log (company_id, request_id, user_id, target, channel, created_at) VALUES (?,?,?,?,?,?)').run(row.company_id, id, user.id, target, channel, iso());
    const who = target === 'rider' ? `the rider${row.rider_name ? ` (${row.rider_name})` : ''}` : target === 'requester' ? 'the requester'
      : target === 'dispatch' ? 'dispatch' : target.startsWith('pickup') ? `the pickup contact${target !== 'pickup:1' ? ` (pickup ${target.split(':')[1]})` : ''}`
        : `the recipient at drop-off ${target.split(':')[1]}`;
    logActivity(user, id, 'contact', `${user.name} ${channel === 'call' ? 'called' : `sent a ${channel === 'sms' ? 'text' : 'WhatsApp'} to`} ${who}`, { target, channel });
    return { ok: true };
  }, { quiet: true });

  // ---------- incidents ----------
  const incidentOut = (i, media = []) => ({
    id: i.id, clientId: i.client_id, type: i.type, severity: i.severity, description: i.description, status: i.status,
    location: i.lat != null ? { lat: i.lat, lng: i.lng, accuracy: i.accuracy } : null, occurredAt: i.occurred_at, createdAt: i.created_at,
    rider: { id: i.rider_id, name: i.rider_name, phone: i.rider_phone ?? null }, request: i.request_id ? { id: i.request_id, ref: refOf(i.request_id) } : null,
    acknowledgedBy: i.ack_name || null, acknowledgedAt: i.acknowledged_at, resolvedBy: i.res_name || null, resolvedAt: i.resolved_at, resolution: i.resolution,
    media: media.map((m) => ({ id: m.id, kind: m.kind, mime: m.mime, size: m.size, url: `/api/incidents/${i.id}/media/${m.id}`, createdAt: m.created_at })),
  });
  const INCIDENT_SELECT = `SELECT i.*, u.name AS rider_name, u.phone AS rider_phone, a.name AS ack_name, z.name AS res_name FROM incidents i
    JOIN users u ON u.id = i.rider_id LEFT JOIN users a ON a.id = i.acknowledged_by LEFT JOIN users z ON z.id = i.resolved_by`;
  const mediaOf = (ids) => {
    const m = new Map(ids.map((x) => [x, []]));
    if (ids.length) {
      for (const r of st(`SELECT id, incident_id, kind, mime, size, created_at FROM incident_media WHERE incident_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(ids))) m.get(r.incident_id).push(r);
    }
    return m;
  };
  function visibleIncident(user, id) {
    const i = st(`${INCIDENT_SELECT} WHERE i.id = ? AND i.company_id = ?`).get(id, user.company_id);
    if (!i || (!isStaff(user) && i.rider_id !== user.id)) throw notFound('Incident not found.');
    return i;
  }
  const openIncidents = (companyId) => {
    const rows = st(`${INCIDENT_SELECT} WHERE i.company_id = ? AND i.status != 'resolved' ORDER BY i.id DESC LIMIT 50`).all(companyId);
    const media = mediaOf(rows.map((r) => r.id));
    return rows.map((r) => incidentOut(r, media.get(r.id)));
  };

  function notifyIncident(user, incident, isNew) {
    if (!isNew) return;
    const rider = userRow(user.id);
    const mapUrl = incident.lat != null ? `https://maps.google.com/?q=${incident.lat.toFixed(5)},${incident.lng.toFixed(5)}` : null;
    const tpl = TEMPLATES.emergency({ rider: rider.name, phone: rider.phone, type: INCIDENT_TYPES[incident.type], ref: incident.request_id ? refOf(incident.request_id) : null, mapUrl });
    notifier.notify({
      users: staffUsers(user.company_id), event: 'emergency', ...tpl, linkPath: `/incidents/${incident.id}`, incidentId: incident.id, requestId: incident.request_id,
      critical: true, immediateSms: incident.severity === 'critical', dedupe: `incident:${incident.id}`,
    });
    hub.publish(user.company_id, 'incident', { id: incident.id, type: incident.type, severity: incident.severity });
  }

  // Riders report incidents; works offline (the app queues the report with a clientId and replays it).
  route('POST', '/api/incidents', ({ user, body }) => {
    needRole(user, ['rider']);
    const clientId = str(body.clientId, { max: 80, label: 'Client id' });
    if (clientId) {
      const prev = st(`${INCIDENT_SELECT} WHERE i.rider_id = ? AND i.client_id = ?`).get(user.id, clientId);
      if (prev) return { incident: incidentOut(prev, mediaOf([prev.id]).get(prev.id)), duplicate: true };
    }
    const type = body.type;
    if (!INCIDENT_TYPES[type]) throw bad('Choose the type of emergency.');
    const description = str(body.description, { max: 1000, label: 'Description' });
    let requestId = null;
    if (body.requestId != null && body.requestId !== '') {
      const r = getVisibleRequestRow(user, intId(body.requestId, 'request'));
      if (r.rider_id !== user.id) throw forbidden('That delivery is not yours.');
      requestId = r.id;
    }
    let lat = num(body.lat, -90, 90, 'Latitude'), lng = num(body.lng, -180, 180, 'Longitude');
    if ((lat == null) !== (lng == null)) { lat = null; lng = null; }
    const accuracy = num(body.accuracy, 0, 100000, 'Accuracy');
    let occurredAt = isoDate(body.occurredAt, 'Time of the incident') || iso();
    if (new Date(occurredAt) > now() + 5 * 60e3 || new Date(occurredAt) < now() - 7 * 864e5) occurredAt = iso();
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 4).map((p, i) => readImage(p, `Photo ${i + 1}`, { required: true })) : [];
    const id = tx(db, () => {
      const r = st(`INSERT INTO incidents (company_id, client_id, rider_id, request_id, type, severity, description, lat, lng, accuracy, occurred_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.company_id, clientId, user.id, requestId, type, SEVERITY[type], description, lat, lng, accuracy, occurredAt, iso());
      const iid = Number(r.lastInsertRowid);
      photos.forEach((p, i) => st(`INSERT INTO incident_media (incident_id, company_id, client_id, kind, mime, size, data, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(iid, user.company_id, `${clientId || iid}:p${i}`, 'photo', p.mime, p.data.length, p.data, user.id, iso()));
      logActivity(user, requestId, 'incident', `${user.name} reported ${INCIDENT_TYPES[type]}${description ? `: ${description.slice(0, 120)}` : ''}`, { incidentId: iid, type });
      return iid;
    });
    const inc = st(`${INCIDENT_SELECT} WHERE i.id = ?`).get(id);
    notifyIncident(user, inc, true);
    return { incident: incidentOut(inc, mediaOf([id]).get(id)) };
  }, { bodyLimit: proofBodyLimit });

  const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/3gpp', 'video/quicktime'];
  route('POST', '/api/incidents/:id/media', ({ user, params, query, req, raw }) => {
    needRole(user, ['rider']);
    const inc = visibleIncident(user, intId(params.id, 'incident'));
    if (inc.rider_id !== user.id) throw forbidden();
    const clientId = str(query.get('clientId'), { max: 80, label: 'Client id' });
    if (clientId) {
      const prev = st('SELECT id FROM incident_media WHERE incident_id = ? AND client_id = ?').get(inc.id, clientId);
      if (prev) return { mediaId: prev.id, duplicate: true };
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let kind;
    if (VIDEO_TYPES.includes(mime)) {
      kind = 'video';
      const isMp4 = raw.length > 12 && raw.subarray(4, 8).toString('latin1') === 'ftyp';
      const isWebm = raw.length > 4 && raw.readUInt32BE(0) === 0x1a45dfa3;
      if (!(mime === 'video/webm' ? isWebm : isMp4)) throw bad('That file is not a valid video.');
    } else if (['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      kind = 'photo';
      readImage(`data:${mime};base64,${raw.toString('base64')}`, 'Photo', { required: true });
    } else throw new HttpError(415, 'unsupported', 'Upload an MP4, WebM or 3GP video, or a JPEG/PNG/WebP photo.');
    if (raw.length < 40) throw bad('The file is empty.');
    const r = st(`INSERT INTO incident_media (incident_id, company_id, client_id, kind, mime, size, data, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(inc.id, user.company_id, clientId, kind, mime, raw.length, raw, user.id, iso());
    logActivity(user, inc.request_id, 'incident_media', `${user.name} added a ${kind} to the ${inc.type} report`, { incidentId: inc.id });
    hub.publish(user.company_id, 'incident', { id: inc.id });
    return { mediaId: Number(r.lastInsertRowid) };
  }, { bodyLimit: VIDEO_MAX, binary: true });

  route('GET', '/api/incidents', ({ user, query }) => {
    if (!isStaff(user) && user.role !== 'rider') throw forbidden();
    const conds = ['i.company_id = ?'];
    const params = [user.company_id];
    if (user.role === 'rider') { conds.push('i.rider_id = ?'); params.push(user.id); }
    const status = query.get('status');
    if (status === 'open') conds.push(`i.status != 'resolved'`);
    else if (['acknowledged', 'resolved'].includes(status)) { conds.push('i.status = ?'); params.push(status); }
    const rows = st(`${INCIDENT_SELECT} WHERE ${conds.join(' AND ')} ORDER BY i.id DESC LIMIT 200`).all(...params);
    const media = mediaOf(rows.map((r) => r.id));
    return { incidents: rows.map((r) => incidentOut(r, media.get(r.id))) };
  });
  route('GET', '/api/incidents/:id', ({ user, params }) => {
    const i = visibleIncident(user, intId(params.id, 'incident'));
    const activity = st(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.company_id = ? AND json_extract(a.meta, '$.incidentId') = ? ORDER BY a.id`).all(user.company_id, i.id)
      .map((a) => ({ id: a.id, message: a.message, user: a.user_name, createdAt: a.created_at }));
    return { incident: incidentOut(i, mediaOf([i.id]).get(i.id)), activity };
  });
  route('GET', '/api/incidents/:id/media/:mid', ({ user, params }) => {
    const i = visibleIncident(user, intId(params.id, 'incident'));
    const m = st('SELECT * FROM incident_media WHERE id = ? AND incident_id = ?').get(intId(params.mid, 'file'), i.id);
    if (!m) throw notFound('File not found.');
    return { __binary: Buffer.from(m.data), type: m.mime, ranges: true };
  });
  route('POST', '/api/incidents/:id/:action', ({ user, params, body }) => {
    const action = params.action;
    if (!['ack', 'resolve'].includes(action)) throw notFound();
    needWriter(user);
    const i = visibleIncident(user, intId(params.id, 'incident'));
    if (action === 'ack') {
      if (i.status !== 'open') return { incident: incidentOut(i, mediaOf([i.id]).get(i.id)) };
      st(`UPDATE incidents SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?`).run(user.id, iso(), i.id);
      logActivity(user, i.request_id, 'incident_ack', `${user.name} acknowledged ${i.rider_name}'s ${i.type} report`, { incidentId: i.id });
      const tpl = TEMPLATES.incidentAck({ by: user.name, type: i.type });
      notifier.notify({ users: [userRow(i.rider_id)], event: 'incident_ack', ...tpl, linkPath: '/jobs', incidentId: i.id, critical: true, dedupe: `incident-ack:${i.id}` });
    } else {
      if (i.status === 'resolved') throw new HttpError(409, 'bad_state', 'This incident is already resolved.');
      const resolution = str(body.resolution, { max: 1000, required: true, label: 'Resolution' });
      st(`UPDATE incidents SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ?, acknowledged_by = COALESCE(acknowledged_by, ?),
        acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?`).run(user.id, iso(), resolution, user.id, iso(), i.id);
      logActivity(user, i.request_id, 'incident_resolved', `${user.name} resolved ${i.rider_name}'s ${i.type} report: ${resolution.slice(0, 120)}`, { incidentId: i.id });
    }
    hub.publish(user.company_id, 'incident', { id: i.id });
    const fresh = st(`${INCIDENT_SELECT} WHERE i.id = ?`).get(i.id);
    return { incident: incidentOut(fresh, mediaOf([i.id]).get(i.id)) };
  });

  // ---------- shifts and overtime ----------
  const overtimeOut = (o) => ({
    id: o.id, rider: { id: o.rider_id, name: o.rider_name }, shiftStartedAt: o.shift_started_at, minutes: o.minutes, reason: o.reason, status: o.status,
    requestedBy: o.req_name, requestedByRider: o.requested_by === o.rider_id, decidedBy: o.dec_name || null, decidedAt: o.decided_at, note: o.decision_note, createdAt: o.created_at,
  });
  const OT_SELECT = `SELECT o.*, u.name AS rider_name, q.name AS req_name, d.name AS dec_name FROM overtime o JOIN users u ON u.id = o.rider_id
    JOIN users q ON q.id = o.requested_by LEFT JOIN users d ON d.id = o.decided_by`;

  function shiftStatus(rider) {
    const s = settings(rider.company_id);
    const totals = shiftTotals(rider);
    const requests = rider.on_shift_since ? st(`${OT_SELECT} WHERE o.rider_id = ? AND o.shift_started_at = ? ORDER BY o.id`).all(rider.id, rider.on_shift_since).map(overtimeOut) : [];
    const allowance = totals.plannedMinutes + totals.approvedMinutes;
    return {
      onShift: !!rider.on_shift, since: rider.on_shift_since || null, ...totals, remainingMinutes: rider.on_shift ? allowance - totals.workedMinutes : null,
      state: !rider.on_shift ? 'off' : totals.workedMinutes <= totals.plannedMinutes ? 'normal' : totals.workedMinutes <= allowance ? 'overtime_approved' : 'over_unapproved',
      overtimeMaxMinutes: Math.round(s.overtime_max_hours * 60), requests, breakSince: rider.break_since || null,
    };
  }
  route('GET', '/api/shift/me', ({ user, query }) => {
    let rider = user;
    if (query.get('riderId')) {
      if (!isStaff(user)) throw forbidden();
      rider = st(`SELECT * FROM users WHERE id = ? AND company_id = ? AND role = 'rider'`).get(intId(query.get('riderId'), 'rider'), user.company_id);
      if (!rider) throw notFound('Rider not found.');
    } else needRole(user, ['rider']);
    rider = userRow(rider.id);
    return { shift: shiftStatus(rider), availability: availabilityMap(user.company_id).get(rider.id) };
  });

  function createOvertime(user, rider, body) {
    if (!rider.on_shift) throw new HttpError(409, 'off_shift', `${user.id === rider.id ? 'You are' : `${rider.name} is`} not clocked in.`);
    const s = settings(rider.company_id);
    const max = Math.round(s.overtime_max_hours * 60);
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > max) throw bad(`Overtime must be between 15 and ${max} minutes.`);
    const used = st(`SELECT COALESCE(SUM(minutes), 0) AS m FROM overtime WHERE rider_id = ? AND shift_started_at = ? AND status IN ('approved','pending')`).get(rider.id, rider.on_shift_since).m;
    if (used + minutes > max) throw bad(`That exceeds the ${s.overtime_max_hours} h overtime limit for one shift (${used} min already requested or approved).`);
    if (st(`SELECT 1 FROM overtime WHERE rider_id = ? AND shift_started_at = ? AND status = 'pending'`).get(rider.id, rider.on_shift_since)) {
      throw new HttpError(409, 'pending', 'There is already an overtime request waiting for a decision.');
    }
    const reason = str(body.reason, { max: 300, label: 'Reason' });
    const r = st(`INSERT INTO overtime (company_id, rider_id, shift_started_at, minutes, reason, requested_by, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(rider.company_id, rider.id, rider.on_shift_since, minutes, reason, user.id, iso());
    const oid = Number(r.lastInsertRowid);
    if (user.id === rider.id) {
      logActivity(user, null, 'overtime_request', `${rider.name} requested ${minutes} min overtime${reason ? `: ${reason}` : ''}`);
      notifier.notify({ users: staffUsers(rider.company_id), event: 'overtime', ...TEMPLATES.overtimeRequest({ rider: rider.name, minutes }), linkPath: '/shifts', dedupe: `ot:${oid}` });
    } else {
      logActivity(user, null, 'overtime_offer', `${user.name} offered ${rider.name} ${minutes} min authorised overtime${reason ? `: ${reason}` : ''}`);
      notifier.notify({ users: [rider], event: 'overtime', title: 'Overtime offered', body: `${user.name} authorised ${minutes} min overtime. Accept or decline.`, linkPath: '/shifts', sms: `Dispatch authorised ${minutes} min overtime for you. Open the app to accept.`, dedupe: `ot:${oid}` });
    }
    hub.publish(rider.company_id, 'shifts', { riderId: rider.id });
    return st(`${OT_SELECT} WHERE o.id = ?`).get(oid);
  }
  route('POST', '/api/overtime', ({ user, body }) => {
    needRole(user, ['rider']);
    return { overtime: overtimeOut(createOvertime(user, userRow(user.id), body)) };
  });
  route('POST', '/api/riders/:id/overtime', ({ user, params, body }) => {
    needWriter(user);
    const rider = st(`SELECT * FROM users WHERE id = ? AND company_id = ? AND role = 'rider'`).get(intId(params.id, 'rider'), user.company_id);
    if (!rider) throw notFound('Rider not found.');
    return { overtime: overtimeOut(createOvertime(user, rider, body)) };
  });
  route('POST', '/api/overtime/:id/decide', ({ user, params, body }) => {
    const o = st(`${OT_SELECT} WHERE o.id = ? AND o.company_id = ?`).get(intId(params.id, 'overtime'), user.company_id);
    if (!o) throw notFound('Overtime request not found.');
    const byRider = o.requested_by === o.rider_id;
    if (byRider) needWriter(user); else if (user.id !== o.rider_id) throw forbidden('Only the rider can accept overtime offered to them.');
    if (o.status !== 'pending') throw new HttpError(409, 'bad_state', 'This overtime request was already decided.');
    if (typeof body.approve !== 'boolean') throw bad('Approve or reject the request.');
    const status = body.approve ? 'approved' : 'rejected';
    const note = str(body.note, { max: 300, label: 'Note' });
    st('UPDATE overtime SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(status, user.id, iso(), note, o.id);
    logActivity(user, null, `overtime_${status}`, `${user.name} ${status} ${o.minutes} min overtime for ${o.rider_name}${note ? `: ${note}` : ''}`);
    const target = byRider ? [userRow(o.rider_id)] : staffUsers(user.company_id);
    const tpl = TEMPLATES.overtimeDecision({ status, minutes: o.minutes, by: user.name });
    notifier.notify({ users: target, event: 'overtime', ...tpl, sms: byRider ? tpl.sms : null, linkPath: '/shifts', dedupe: `ot-decide:${o.id}` });
    hub.publish(user.company_id, 'shifts', { riderId: o.rider_id });
    return { overtime: overtimeOut(st(`${OT_SELECT} WHERE o.id = ?`).get(o.id)) };
  });
  route('GET', '/api/overtime', ({ user, query }) => {
    if (!isStaff(user) && user.role !== 'rider') throw forbidden();
    const conds = ['o.company_id = ?'];
    const p = [user.company_id];
    if (user.role === 'rider') { conds.push('o.rider_id = ?'); p.push(user.id); }
    if (['pending', 'approved', 'rejected'].includes(query.get('status'))) { conds.push('o.status = ?'); p.push(query.get('status')); }
    return { overtime: st(`${OT_SELECT} WHERE ${conds.join(' AND ')} ORDER BY o.id DESC LIMIT 200`).all(...p).map(overtimeOut) };
  });

  // Hours, standard time and overtime per rider for a period (completed shifts plus any shift in progress).
  route('GET', '/api/shifts/report', ({ user, query }) => {
    if (!isStaff(user) && user.role !== 'rider') throw forbidden();
    const from = isoDate(query.get('from'), 'from') || new Date(now() - 7 * 864e5).toISOString();
    const to = isoDate(query.get('to'), 'to') || iso();
    const riderFilter = user.role === 'rider' ? user.id : query.get('riderId') ? intId(query.get('riderId'), 'rider') : null;
    const rows = st(`SELECT s.*, u.name AS rider_name FROM shifts s JOIN users u ON u.id = s.rider_id
      WHERE s.company_id = ? AND s.starts_at < ? AND s.ends_at > ? ${riderFilter ? 'AND s.rider_id = ?' : ''} ORDER BY s.starts_at DESC LIMIT 2000`)
      .all(user.company_id, to, from, ...(riderFilter ? [riderFilter] : []));
    const plannedDefault = Math.round(settings(user.company_id).shift_hours * 60);
    const shifts = rows.map((s) => {
      const minutes = minutesSince(s.starts_at, new Date(s.ends_at).getTime());
      const planned = s.planned_minutes ?? plannedDefault;
      const overtime = s.overtime_minutes ?? Math.max(0, minutes - planned);
      const approved = Math.min(overtime, s.approved_overtime_minutes ?? 0);
      return { id: s.id, rider: { id: s.rider_id, name: s.rider_name }, startsAt: s.starts_at, endsAt: s.ends_at, minutes, plannedMinutes: planned, overtimeMinutes: overtime, approvedOvertimeMinutes: approved, unapprovedOvertimeMinutes: overtime - approved, inProgress: false };
    });
    const live = st(`SELECT * FROM users WHERE company_id = ? AND role = 'rider' AND on_shift = 1 ${riderFilter ? 'AND id = ?' : ''}`).all(user.company_id, ...(riderFilter ? [riderFilter] : []));
    for (const r of live) {
      const t = shiftTotals(r);
      shifts.unshift({ id: null, rider: { id: r.id, name: r.name }, startsAt: r.on_shift_since, endsAt: null, minutes: t.workedMinutes, plannedMinutes: t.plannedMinutes, overtimeMinutes: t.overtimeMinutes, approvedOvertimeMinutes: Math.min(t.overtimeMinutes, t.approvedMinutes), unapprovedOvertimeMinutes: Math.max(0, t.overtimeMinutes - t.approvedMinutes), inProgress: true });
    }
    const byRider = new Map();
    for (const s of shifts) {
      const r = byRider.get(s.rider.id) || { rider: s.rider, shifts: 0, minutes: 0, overtimeMinutes: 0, approvedOvertimeMinutes: 0, unapprovedOvertimeMinutes: 0 };
      r.shifts++; r.minutes += s.minutes; r.overtimeMinutes += s.overtimeMinutes; r.approvedOvertimeMinutes += s.approvedOvertimeMinutes; r.unapprovedOvertimeMinutes += s.unapprovedOvertimeMinutes;
      byRider.set(s.rider.id, r);
    }
    return { from, to, shifts, riders: [...byRider.values()].sort((a, b) => b.minutes - a.minutes) };
  });

  // ---------- rider performance ----------
  route('GET', '/api/reports/riders', ({ user, query }) => {
    if (!isStaff(user)) throw forbidden();
    const from = isoDate(query.get('from'), 'from') || new Date(now() - 30 * 864e5).toISOString();
    const to = isoDate(query.get('to'), 'to') || iso();
    const riders = st(`SELECT id, name, tags, vehicle FROM users WHERE company_id = ? AND role = 'rider' ORDER BY name`).all(user.company_id);
    const out = riders.map((r) => {
      const d = st(`SELECT COUNT(*) AS n, AVG((julianday(delivered_at) - julianday(assigned_at)) * 1440) AS m FROM requests
        WHERE rider_id = ? AND status = 'delivered' AND delivered_at >= ? AND delivered_at <= ?`).get(r.id, from, to);
      const g = st(`SELECT COUNT(*) AS n, AVG(stars) AS stars, AVG(professionalism) AS p, AVG(timeliness) AS t, AVG(communication) AS c, AVG(handling) AS h
        FROM ratings WHERE rider_id = ? AND created_at >= ? AND created_at <= ?`).get(r.id, from, to);
      const failed = st(`SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND kind = 'handover' AND outcome = 'failed' AND created_at >= ? AND created_at <= ?`).get(r.id, from, to).n;
      const incidents = st(`SELECT COUNT(*) AS n FROM incidents WHERE rider_id = ? AND created_at >= ? AND created_at <= ?`).get(r.id, from, to).n;
      const comments = st(`SELECT g.stars, g.comment, g.created_at, g.request_id FROM ratings g WHERE g.rider_id = ? AND g.comment IS NOT NULL AND g.created_at >= ? AND g.created_at <= ?
        ORDER BY g.id DESC LIMIT 5`).all(r.id, from, to).map((c) => ({ stars: c.stars, comment: c.comment, ref: refOf(c.request_id), createdAt: c.created_at }));
      const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
      return {
        rider: { id: r.id, name: r.name, tags: parseJson(r.tags, []), vehicle: r.vehicle }, deliveries: d.n, avgDeliveryMinutes: d.m == null ? null : Math.round(d.m),
        failedDropoffs: failed, incidents, ratings: { count: g.n, stars: r1(g.stars), professionalism: r1(g.p), timeliness: r1(g.t), communication: r1(g.c), handling: r1(g.h) }, comments,
      };
    });
    return { from, to, riders: out };
  });

  // ---------- announcements ----------
  route('POST', '/api/announcements', ({ user, body }) => {
    needWriter(user);
    const text = str(body.text, { max: 300, required: true, label: 'Message' });
    const audience = ['on_shift', 'riders', 'everyone'].includes(body.audience) ? body.audience : 'on_shift';
    const users = st(`SELECT * FROM users WHERE company_id = ? AND active = 1 AND id != ? AND ${audience === 'everyone' ? '1' : audience === 'riders' ? "role = 'rider'" : "role = 'rider' AND on_shift = 1"}`)
      .all(user.company_id, user.id);
    const tpl = TEMPLATES.announcement({ from: user.name, text });
    const sent = notifier.notify({ users, event: 'announcement', ...tpl, critical: !!body.important, linkPath: '/', dedupe: `ann:${user.id}:${now()}` });
    logActivity(user, null, 'announcement', `${user.name} sent an announcement to ${sent.length} ${audience === 'everyone' ? 'people' : 'riders'}: ${text}`);
    return { sent: sent.length };
  });

  // ---------- notification preferences ----------
  route('GET', '/api/me/preferences', ({ user }) => ({ smsPref: userRow(user.id).sms_pref || 'critical', hasPhone: !!userRow(user.id).phone }));
  route('PATCH', '/api/me/preferences', ({ user, body }) => {
    if (!['critical', 'all', 'off'].includes(body.smsPref)) throw bad('Choose critical, all or off.');
    st('UPDATE users SET sms_pref = ? WHERE id = ?').run(body.smsPref, user.id);
    return { smsPref: body.smsPref };
  }, { quiet: true });

  // ---------- in-app inbox ----------
  route('GET', '/api/inbox', ({ user, query }) => {
    const limit = Math.min(Number(query.get('limit')) || 30, 100);
    const items = st('SELECT * FROM inbox WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(user.id, limit).map((i) => ({
      id: i.id, event: i.event, title: i.title, body: i.body, link: i.link, requestId: i.request_id, incidentId: i.incident_id, critical: !!i.critical,
      seenAt: i.seen_at, smsSent: !!i.sms_queued_at && !!i.sms_text, createdAt: i.created_at,
    }));
    return { items, unread: st('SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND seen_at IS NULL').get(user.id).n };
  });
  route('POST', '/api/inbox/seen', ({ user, body }) => {
    if (body.all === true) st('UPDATE inbox SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL').run(iso(), user.id);
    else {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => Number.isInteger(x)).slice(0, 200) : [];
      if (ids.length) st(`UPDATE inbox SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL AND id IN (SELECT value FROM json_each(?))`).run(iso(), user.id, JSON.stringify(ids));
    }
    return { unread: st('SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND seen_at IS NULL').get(user.id).n };
  }, { quiet: true });

  // ---------- push tokens (Android app) ----------
  route('POST', '/api/push/register', ({ user, body }) => {
    const token = str(body.token, { max: 4096, required: true, label: 'Token' });
    st(`INSERT INTO push_tokens (token, user_id, platform, created_at, last_seen_at) VALUES (?,?,?,?,?)
      ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, last_seen_at = excluded.last_seen_at`).run(token, user.id, 'android', iso(), iso());
    return { ok: true, push: !!integrations.push?.configured };
  }, { quiet: true });
  route('POST', '/api/push/unregister', ({ user, body }) => {
    st('DELETE FROM push_tokens WHERE token = ? AND user_id = ?').run(String(body.token || ''), user.id);
    return { ok: true };
  }, { quiet: true });

  // ---------- offline GPS upload ----------
  // Points captured while the phone had no connection, uploaded later. Kept only if the rider was clocked in then.
  route('POST', '/api/location/batch', ({ user, body }) => {
    needRole(user, ['rider']);
    const points = Array.isArray(body.points) ? body.points.slice(0, 500) : [];
    const me = userRow(user.id);
    const windows = st('SELECT starts_at, ends_at FROM shifts WHERE rider_id = ? AND ends_at > ?').all(user.id, iso(now() - 864e5));
    if (me.on_shift_since) windows.push({ starts_at: me.on_shift_since, ends_at: iso(now() + 60e3) });
    let stored = 0, skipped = 0, newest = null;
    tx(db, () => {
      for (const p of points) {
        const lat = Number(p?.lat), lng = Number(p?.lng);
        const at = typeof p?.recordedAt === 'string' ? new Date(p.recordedAt) : null;
        const t = at?.getTime();
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isInKenya(lat, lng) || !Number.isFinite(t) || t > now() + 60e3 || t < now() - 864e5) { skipped++; continue; }
        const ts = at.toISOString();
        if (!windows.some((w) => w.starts_at <= ts && ts <= w.ends_at)) { skipped++; continue; }
        const acc = Number.isFinite(Number(p.accuracy)) ? Number(p.accuracy) : null;
        const speed = Number.isFinite(Number(p.speed)) ? Math.max(0, Math.min(200, Number(p.speed))) : null;
        st('INSERT INTO location_points (company_id, rider_id, lat, lng, accuracy, speed, recorded_at) VALUES (?,?,?,?,?,?,?)').run(user.company_id, user.id, lat, lng, acc, speed, ts);
        stored++;
        if (!newest || ts > newest.ts) newest = { lat, lng, acc, speed, ts, heading: Number.isFinite(Number(p.heading)) ? Number(p.heading) : null };
      }
      if (newest && me.on_shift) {
        st(`INSERT INTO rider_locations (rider_id, company_id, lat, lng, accuracy, heading, speed, recorded_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(rider_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, heading = excluded.heading,
            speed = excluded.speed, recorded_at = excluded.recorded_at WHERE excluded.recorded_at > rider_locations.recorded_at`)
          .run(user.id, user.company_id, newest.lat, newest.lng, newest.acc, newest.heading, newest.speed, newest.ts);
      }
    });
    if (stored) hub.publish(user.company_id, 'location', { riderId: user.id });
    return { stored, skipped };
  }, { quiet: true, bodyLimit: 512 * 1024 });

  // ---------- Africa's Talking delivery reports ----------
  // Callback URL: https://<APP_ORIGIN>/api/webhooks/sms?token=<AT_CALLBACK_TOKEN>
  route('POST', '/api/webhooks/sms', ({ body, query }) => {
    const token = integrations.smsCallbackToken;
    if (!token || query.get('token') !== token) throw forbidden('Invalid callback token.');
    notifier.deliveryReport({ id: body.id, status: body.status, failureReason: body.failureReason });
    return { ok: true };
  }, { public: true, webhook: true, form: true });

  // ---------- smart defaults for the request form ----------
  route('GET', '/api/places/recent', ({ user }) => {
    const rows = st(`SELECT * FROM requests WHERE requester_id = ? ORDER BY id DESC LIMIT 40`).all(user.id);
    const seen = new Set();
    const pickups = [];
    for (const r of rows) {
      const key = r.pickup_address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pickups.push({ address: r.pickup_address, lat: r.pickup_lat, lng: r.pickup_lng, details: parseJson(r.pickup_details, null), contactName: r.pickup_contact_name, contactPhone: r.pickup_contact_phone });
    }
    const drops = [];
    const seenD = new Set();
    if (rows.length) {
      for (const d of st(`SELECT * FROM dropoffs WHERE request_id IN (SELECT value FROM json_each(?)) ORDER BY id DESC`).all(JSON.stringify(rows.map((r) => r.id)))) {
        const key = d.address.toLowerCase();
        if (seenD.has(key)) continue;
        seenD.add(key);
        drops.push({ address: d.address, lat: d.lat, lng: d.lng, details: parseJson(d.details, null), contactName: d.contact_name, contactPhone: d.contact_phone, instructions: d.instructions });
      }
    }
    return { pickups: pickups.slice(0, 8), dropoffs: drops.slice(0, 8) };
  });

  // ---------- workflow events → notifications ----------
  const requesterOf = (row) => userRow(row.requester_id);
  const events = {
    assigned(id, rider) {
      const row = st('SELECT * FROM requests WHERE id = ?').get(id);
      // The new rider gets the current addresses, so older unconfirmed changes no longer need confirming.
      st('UPDATE location_changes SET acknowledged_at = ? WHERE request_id = ? AND acknowledged_at IS NULL AND (rider_id IS NULL OR rider_id != ?)').run(iso(), id, rider.id);
      if (row.requester_id !== rider.id) {
        const tpl = TEMPLATES.assignedRequester({ ref: refOf(id), rider: rider.name, phone: rider.phone, url: trackUrl(id) });
        notifier.notify({ users: [requesterOf(row)], event: 'assigned', ...tpl, linkPath: `/requests/${id}`, requestId: id, dedupe: `assigned:${id}:${rider.id}:${row.assigned_at}` });
      }
    },
    accepted(id, rider) {
      const row = st('SELECT * FROM requests WHERE id = ?').get(id);
      const tpl = TEMPLATES.accepted({ ref: refOf(id), rider: rider.name, phone: rider.phone, url: trackUrl(id) });
      notifier.notify({ users: [requesterOf(row)], event: 'accepted', ...tpl, linkPath: `/requests/${id}`, requestId: id, dedupe: `accepted:${id}:${row.assigned_at}` });
      notifier.notify({ users: staffUsers(row.company_id), event: 'accepted', title: tpl.title, body: `${rider.name} accepted ${refOf(id)}: ${row.title}`, linkPath: `/requests/${id}`, requestId: id, dedupe: `accepted-staff:${id}:${row.assigned_at}` });
    },
    collected(id) {
      const row = st('SELECT r.*, k.name AS rider_name, k.phone AS rider_phone, c.name AS company_name FROM requests r JOIN users k ON k.id = r.rider_id JOIN companies c ON c.id = r.company_id WHERE r.id = ?').get(id);
      const drops = st('SELECT * FROM dropoffs WHERE request_id = ? ORDER BY seq').all(id);
      const tpl = TEMPLATES.collected({ ref: refOf(id), rider: row.rider_name, stops: drops.length, url: trackUrl(id) });
      notifier.notify({ users: [requesterOf(row)], event: 'collected', ...tpl, linkPath: `/requests/${id}`, requestId: id, dedupe: `collected:${id}` });
      if (settings(row.company_id).sms_recipients) {
        for (const d of drops) {
          if (!d.contact_phone) continue;
          const msg = TEMPLATES.recipientOnTheWay({ ref: refOf(id), company: row.company_name, rider: row.rider_name, phone: row.rider_phone });
          notifier.queueSms({ companyId: row.company_id, requestId: id, event: 'recipient_on_the_way', phone: d.contact_phone, text: msg.sms, dedupe: `recipient:${id}:${d.seq}` });
        }
      }
    },
    handover(id, seq, { delivered, receivedBy, note, allDone }) {
      const row = st('SELECT * FROM requests WHERE id = ?').get(id);
      const n = st(`SELECT COUNT(*) AS n FROM records WHERE request_id = ? AND kind = 'handover'`).get(id).n;
      const requester = requesterOf(row);
      if (delivered) {
        const tpl = TEMPLATES.dropoffDone({ ref: refOf(id), seq, receivedBy, time: t2(iso()) });
        if (!allDone) notifier.notify({ users: [requester], event: 'dropoff', ...tpl, linkPath: `/requests/${id}`, requestId: id, dedupe: `drop:${id}:${seq}:${n}` });
      } else {
        const tpl = TEMPLATES.dropoffFailed({ ref: refOf(id), seq, note });
        notifier.notify({ users: [requester], event: 'dropoff_failed', ...tpl, linkPath: `/requests/${id}`, requestId: id, dedupe: `dropfail:${id}:${seq}:${n}` });
        notifier.notify({ users: staffUsers(row.company_id), event: 'dropoff_failed', ...tpl, sms: null, linkPath: `/requests/${id}`, requestId: id, dedupe: `dropfail-staff:${id}:${seq}:${n}` });
      }
      if (allDone) {
        const tpl = TEMPLATES.delivered({ ref: refOf(id), url: trackUrl(id) });
        notifier.notify({ users: [requester], event: 'delivered', ...tpl, linkPath: `/requests/${id}`, requestId: id, dedupe: `delivered:${id}` });
      }
    },
    cancelled(row, by, reason) {
      if (by.id === row.rider_id) return;
      notifier.notify({
        users: [userRow(row.rider_id)], event: 'cancelled', title: `${refOf(row.id)} cancelled`, body: `${by.name} cancelled it${reason ? `: ${reason}` : ''}. Do not go to the pickup.`,
        sms: `${refOf(row.id)} was CANCELLED by ${by.name}. Do not go to the pickup.`, linkPath: `/requests/${row.id}`, requestId: row.id, critical: true, dedupe: `cancel:${row.id}`,
      });
    },
  };

  /** Significant address changes the rider still has to confirm, by request id. */
  function pendingAcks(riderId) {
    const m = new Map();
    for (const c of st(`SELECT c.*, u.name AS by_name FROM location_changes c JOIN users u ON u.id = c.changed_by
      JOIN requests r ON r.id = c.request_id WHERE c.rider_id = ? AND r.rider_id = ? AND c.significant = 1 AND c.acknowledged_at IS NULL ORDER BY c.id`).all(riderId, riderId)) {
      if (!m.has(c.request_id)) m.set(c.request_id, []);
      m.get(c.request_id).push(changeOut(c));
    }
    return m;
  }

  /** Extra sections for the request page, by role. */
  function detailExtras(user, request) {
    const changes = st(`SELECT c.*, u.name AS by_name FROM location_changes c JOIN users u ON u.id = c.changed_by WHERE c.request_id = ? ORDER BY c.id DESC`).all(request.id).map(changeOut);
    const g = st('SELECT g.*, u.name AS rater_name FROM ratings g JOIN users u ON u.id = g.rater_id WHERE g.request_id = ?').get(request.id);
    const full = isStaff(user) || request.requester.id === user.id;
    const incidents = isStaff(user) || request.rider?.id === user.id
      ? st(`${INCIDENT_SELECT} WHERE i.request_id = ? ORDER BY i.id DESC`).all(request.id).map((i) => incidentOut(i, mediaOf([i.id]).get(i.id))) : [];
    const s = settings(user.company_id);
    return {
      locationChanges: changes, rating: ratingOut(g, full), incidents,
      canRate: !g && request.status === 'delivered' && !!request.rider && request.requester.id === user.id && user.role !== 'rider',
      dispatchPhone: s.dispatch_phone,
    };
  }

  // ---------- periodic checks ----------
  let ticks = 0;
  function tick() {
    const at = now();
    for (const c of st('SELECT id FROM companies').all()) {
      const s = settings(c.id);
      const staff = staffUsers(c.id);
      for (const r of st(`SELECT * FROM users WHERE company_id = ? AND role = 'rider' AND on_shift = 1 AND active = 1`).all(c.id)) {
        const t = shiftTotals(r, new Date(at).toISOString());
        if (t.workedMinutes > t.plannedMinutes + t.approvedMinutes) {
          const hours = Math.round((t.workedMinutes / 60) * 10) / 10;
          notifier.notify({ users: [r], event: 'shift_over', ...TEMPLATES.shiftOver({ hours }), linkPath: '/shifts', dedupe: `shiftover:${r.id}:${r.on_shift_since}:${t.approvedMinutes}` });
          notifier.notify({ users: staff, event: 'shift_over', title: `${r.name} is past their shift`, body: `${hours} h worked, ${t.approvedMinutes} min overtime approved.`, linkPath: '/shifts', dedupe: `shiftover-staff:${r.id}:${r.on_shift_since}:${t.approvedMinutes}` });
        }
        if (r.break_since && minutesSince(r.break_since, at) > s.break_max_min) {
          notifier.notify({ users: staff, event: 'break_overdue', title: `${r.name}'s break is over ${s.break_max_min} min`, body: `On break since ${t2(r.break_since)}.`, linkPath: '/dispatch', dedupe: `break:${r.id}:${r.break_since}` });
        }
        const seen = r.last_seen_at || r.on_shift_since;
        if (seen && at - new Date(seen).getTime() > s.standby_timeout_min * 60e3) {
          notifier.notify({ users: staff, event: 'unresponsive', title: `${r.name} is not responding`, body: `No contact from the app since ${t2(seen)}.`, linkPath: '/live', dedupe: `quiet:${r.id}:${seen}` });
        }
      }
    }
    if (++ticks % 720 === 0) st('DELETE FROM idempotency WHERE created_at < ?').run(iso(at - 7 * 864e5));
  }

  return {
    settings, publicSettings, stopsOf, pendingAcks, recordStopChanges, requireAcknowledged, busyConflicts, assignWarnings, readGps, stopPin, detailExtras,
    shiftTotals, availabilityMap, availabilitySummary, openIncidents, events, tick,
  };
}
