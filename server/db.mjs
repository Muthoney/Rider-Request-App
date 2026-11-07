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
CREATE INDEX IF NOT EXISTS idx_requests_company ON requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_rider ON requests(rider_id);
CREATE INDEX IF NOT EXISTS idx_dropoffs_request ON dropoffs(request_id, seq);
CREATE INDEX IF NOT EXISTS idx_activity_company ON activity(company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_company ON shifts(company_id, starts_at);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
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
