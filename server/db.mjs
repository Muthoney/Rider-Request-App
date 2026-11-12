import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','dispatcher','requester','rider')),
  tags TEXT NOT NULL DEFAULT '[]',
  password_hash TEXT,
  must_change INTEGER NOT NULL DEFAULT 1,
  temp_expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  requester_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general','triangle','finance')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','assigned','collected','delivered','cancelled')),
  pickup_address TEXT NOT NULL,
  pickup_contact_name TEXT,
  pickup_contact_phone TEXT,
  pickup_lat REAL,
  pickup_lng REAL,
  scheduled_at TEXT,
  handling TEXT NOT NULL DEFAULT '[]',
  handling_notes TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'form',
  rider_id INTEGER REFERENCES users(id),
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  cancel_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  assigned_at TEXT,
  collected_at TEXT,
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS dropoffs (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  address TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  lat REAL,
  lng REAL,
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  handled_at TEXT,
  received_by TEXT,
  note TEXT
);
-- Extra pickup stops (the first pickup lives on the request row as seq 1; these are seq 2+).
CREATE TABLE IF NOT EXISTS pickups (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  address TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  lat REAL,
  lng REAL
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  dropoff_id INTEGER REFERENCES dropoffs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('collection','handover')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  counterpart TEXT,
  outcome TEXT,
  item_count INTEGER,
  note TEXT,
  gps_status TEXT NOT NULL DEFAULT 'unconnected',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS overrides (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  rider_id INTEGER NOT NULL,
  dispatcher_id INTEGER NOT NULL,
  conflicts TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','done')),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  note TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rider_locations (
  rider_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  heading REAL,
  speed REAL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS location_points (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  rider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  speed REAL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','none')),
  status TEXT NOT NULL CHECK (status IN ('sent','delivered','read','failed','skipped')),
  recipient TEXT,
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  fuel_price REAL NOT NULL,
  fuel_type TEXT NOT NULL DEFAULT 'petrol',
  fuel_price_updated_at TEXT NOT NULL,
  km_per_litre REAL NOT NULL,
  time_rate_per_hour REAL NOT NULL,
  base_fee REAL NOT NULL,
  road_factor REAL NOT NULL,
  updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('photo','signature')),
  stage TEXT NOT NULL CHECK (stage IN ('collection','handover')),
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  channel TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
-- ---- v2: MVP feedback (availability, incidents, location changes, ratings, overtime, notifications, sync) ----
-- Operational settings per company (standby timeout, job limit, shift length, notification options).
CREATE TABLE IF NOT EXISTS ops_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  max_active_jobs INTEGER NOT NULL DEFAULT 2,
  standby_timeout_min INTEGER NOT NULL DEFAULT 15,
  break_max_min INTEGER NOT NULL DEFAULT 60,
  shift_hours REAL NOT NULL DEFAULT 8,
  overtime_max_hours REAL NOT NULL DEFAULT 4,
  sms_recipients INTEGER NOT NULL DEFAULT 0,
  sms_fallback_seconds INTEGER NOT NULL DEFAULT 90,
  dispatch_phone TEXT,
  updated_by INTEGER,
  updated_at TEXT
);
-- Emergencies and incidents reported by riders (accidents, breakdowns, medical, security, other).
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  client_id TEXT,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('accident','breakdown','medical','security','other')),
  severity TEXT NOT NULL DEFAULT 'high' CHECK (severity IN ('critical','high','normal')),
  description TEXT,
  lat REAL, lng REAL, accuracy REAL,
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by INTEGER REFERENCES users(id), acknowledged_at TEXT,
  resolved_by INTEGER REFERENCES users(id), resolved_at TEXT, resolution TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (rider_id, client_id)
);
CREATE TABLE IF NOT EXISTS incident_media (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  client_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('photo','video')),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (incident_id, client_id)
);
-- Pickup / drop-off address changes after a request was submitted.
CREATE TABLE IF NOT EXISTS location_changes (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stop_kind TEXT NOT NULL CHECK (stop_kind IN ('pickup','dropoff')),
  stop_seq INTEGER NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  distance_km REAL,
  significant INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  rider_id INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
-- Client ratings of a completed delivery (one per request).
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  rater_id INTEGER NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  professionalism INTEGER CHECK (professionalism BETWEEN 1 AND 5),
  timeliness INTEGER CHECK (timeliness BETWEEN 1 AND 5),
  communication INTEGER CHECK (communication BETWEEN 1 AND 5),
  handling INTEGER CHECK (handling BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL
);
-- Overtime requests: a rider asks (or is asked) to work past the standard shift; staff decide.
CREATE TABLE IF NOT EXISTS overtime (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  shift_started_at TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL
);
-- Calls and other contact made from a delivery (communication history; numbers are not stored).
CREATE TABLE IF NOT EXISTS contact_log (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  target TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('call','sms','whatsapp')),
  created_at TEXT NOT NULL
);
-- In-app notifications (the "push" channel). Unseen critical items fall back to SMS.
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  request_id INTEGER,
  incident_id INTEGER,
  critical INTEGER NOT NULL DEFAULT 0,
  sms_text TEXT,
  dedupe_key TEXT UNIQUE,
  seen_at TEXT,
  sms_queued_at TEXT,
  created_at TEXT NOT NULL
);
-- SMS outbox (Africa's Talking): queued, retried with backoff, de-duplicated, delivery-tracked.
CREATE TABLE IF NOT EXISTS sms_outbox (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  request_id INTEGER,
  incident_id INTEGER,
  event TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','delivered','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Offline sync: responses to mutating calls sent with an Idempotency-Key, so replays never duplicate.
CREATE TABLE IF NOT EXISTS idempotency (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
-- Android push tokens (Firebase Cloud Messaging), registered by the mobile app.
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'android',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_company ON incidents(company_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_incident_media ON incident_media(incident_id);
CREATE INDEX IF NOT EXISTS idx_locchanges_request ON location_changes(request_id, id);
CREATE INDEX IF NOT EXISTS idx_ratings_rider ON ratings(rider_id);
CREATE INDEX IF NOT EXISTS idx_overtime_rider ON overtime(rider_id, shift_started_at);
CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_unseen ON inbox(critical, seen_at, sms_queued_at);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON sms_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_provider ON sms_outbox(provider_id);
CREATE INDEX IF NOT EXISTS idx_contact_request ON contact_log(request_id);
CREATE INDEX IF NOT EXISTS idx_requests_company ON requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_attachments_request ON attachments(request_id);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_rider ON requests(rider_id);
CREATE INDEX IF NOT EXISTS idx_dropoffs_request ON dropoffs(request_id, seq);
CREATE INDEX IF NOT EXISTS idx_pickups_request ON pickups(request_id, seq);
CREATE INDEX IF NOT EXISTS idx_activity_company ON activity(company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_company ON shifts(company_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_points_rider ON location_points(rider_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_notifications_request ON notifications(request_id, id);
CREATE INDEX IF NOT EXISTS idx_notifications_provider ON notifications(provider_id);
`;

/** Additive migrations for databases created by earlier versions. */
function migrate(db) {
  const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const add = (table, col, def) => { if (!cols(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  add('users', 'on_shift', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'on_shift_since', 'TEXT');
  // Riders ride petrol or electric motorcycles; fuel and quotes follow the rider's vehicle.
  add('users', 'vehicle', "TEXT NOT NULL DEFAULT 'petrol'");
  // Proof of collection / delivery: a photo, a signed delivery note (D-note) and its number.
  add('records', 'photo_id', 'INTEGER REFERENCES attachments(id)');
  add('records', 'signature_id', 'INTEGER REFERENCES attachments(id)');
  add('records', 'dnote_ref', 'TEXT');
  add('records', 'signed_by', 'TEXT');
  // Which pickup a collection record is for (1 = the request's first pickup; NULL on older rows means 1).
  add('records', 'pickup_seq', 'INTEGER');
  // Electric motorcycles: energy price per kWh, efficiency, and which vehicle quotes assume.
  add('company_settings', 'electricity_price', 'REAL');
  add('company_settings', 'km_per_kwh', 'REAL');
  add('company_settings', 'default_vehicle', 'TEXT');
  // v2 — rider availability: a break the rider takes, and when the rider's app was last heard from.
  add('users', 'break_since', 'TEXT');
  add('users', 'last_seen_at', 'TEXT');
  // v2 — notification preferences: SMS for 'critical' events (default), 'all' events, or 'off'.
  add('users', 'sms_pref', "TEXT NOT NULL DEFAULT 'critical'");
  // v2 — structured location details (building, floor, unit, gate, landmark) as JSON per stop.
  add('requests', 'pickup_details', 'TEXT');
  add('pickups', 'details', 'TEXT');
  add('dropoffs', 'details', 'TEXT');
  // v2 — GPS captured on the rider's phone when a collection or handover is recorded.
  add('records', 'lat', 'REAL');
  add('records', 'lng', 'REAL');
  add('records', 'accuracy', 'REAL');
  add('records', 'client_recorded_at', 'TEXT');
  // v2 — shift log: the standard length that applied, and approved overtime.
  add('shifts', 'planned_minutes', 'INTEGER');
  add('shifts', 'overtime_minutes', 'INTEGER');
  add('shifts', 'approved_overtime_minutes', 'INTEGER');
  // "Keep cold" handling was retired; strip it from stored requests.
  db.exec(`UPDATE requests SET handling = (SELECT json_group_array(value) FROM json_each(requests.handling) WHERE value != 'cold')
    WHERE EXISTS (SELECT 1 FROM json_each(requests.handling) WHERE value = 'cold')`);
}

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Run fn inside an IMMEDIATE transaction; rolls back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
