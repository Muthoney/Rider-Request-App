// Idempotent account bootstrap. Creates example accounts that don't exist yet and writes their
// temporary passwords to a private file in the data volume. Existing accounts are never reset.
//   node server/provision.mjs            accounts only
//   node server/provision.mjs --sample   also add sample requests, a shift log, riders on shift with demo GPS, and a run
import { writeFileSync, chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openDb, tx } from './db.mjs';
import { hashPassword, tempPassword } from './security.mjs';
import { TEMP_TTL_MS } from './app.mjs';

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'rider-requests.sqlite');
const OUT = process.env.CREDENTIALS_FILE || path.join(DATA_DIR, 'bootstrap-credentials.json');
const sample = process.argv.includes('--sample') && !process.argv.includes('--accounts');

// Real deployments: pass a private JSON file instead of editing these examples
//   node server/provision.mjs --accounts accounts.json      (or "--accounts -" to read it from stdin)
// Format: see deploy/vps/accounts.example.json.
const accountsArg = process.argv.indexOf('--accounts');
const custom = accountsArg > 0 ? JSON.parse(readFileSync(process.argv[accountsArg + 1] === '-' ? 0 : process.argv[accountsArg + 1], 'utf8')) : null;
if (custom && (!custom.company || !Array.isArray(custom.accounts) || !custom.accounts.length)) {
  console.error('Accounts file needs a "company" name and a non-empty "accounts" list.');
  process.exit(1);
}
const ROLES = ['admin', 'manager', 'dispatcher', 'requester', 'rider'];
for (const a of custom?.accounts || []) {
  if (!a.email || !a.name || !ROLES.includes(a.role)) {
    console.error(`Invalid account ${JSON.stringify(a)}: needs email, name and a role (${ROLES.join(', ')}).`);
    process.exit(1);
  }
  a.email = String(a.email).trim().toLowerCase();
}
const COMPANY = custom ? custom.company : 'Example Media Ltd';
const ACCOUNTS = custom ? custom.accounts : [
  { email: 'admin@example.com', name: 'Amina Wanjiku', role: 'admin', phone: '+254700000001' },
  { email: 'manager@example.com', name: 'Brian Otieno', role: 'manager', phone: '+254700000002' },
  { email: 'dispatch@example.com', name: 'Cynthia Mwangi', role: 'dispatcher', phone: '+254700000003' },
  { email: 'studio@example.com', name: 'David Kamau', role: 'requester', phone: '+254700000004' },
  { email: 'finance@example.com', name: 'Esther Njeri', role: 'requester', phone: '+254700000005' },
  { email: 'rider.felix@example.com', name: 'Felix Ouma', role: 'rider', phone: '+254700000011', tags: ['triangle'] },
  { email: 'rider.grace@example.com', name: 'Grace Akinyi', role: 'rider', phone: '+254700000012', tags: ['finance'] },
  { email: 'rider.hassan@example.com', name: 'Hassan Ali', role: 'rider', phone: '+254700000013' },
  { email: 'rider.irene@example.com', name: 'Irene Chebet', role: 'rider', phone: '+254700000014', vehicle: 'electric' },
];

const db = openDb(DB_FILE);
const now = new Date().toISOString();
const created = [];

tx(db, () => {
  db.prepare('INSERT OR IGNORE INTO companies (name, created_at) VALUES (?, ?)').run(COMPANY, now);
  const companyId = db.prepare('SELECT id FROM companies WHERE name = ?').get(COMPANY).id;
  const expires = new Date(Date.now() + TEMP_TTL_MS).toISOString();
  for (const a of ACCOUNTS) {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(a.email)) continue;
    const temp = tempPassword();
    db.prepare(`INSERT INTO users (company_id, email, name, phone, role, tags, vehicle, password_hash, must_change, temp_expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?)`).run(companyId, a.email, a.name, a.phone, a.role, JSON.stringify(a.tags || []), a.vehicle || 'petrol', hashPassword(temp), expires, now);
    created.push({ email: a.email, role: a.role, temporaryPassword: temp, expiresAt: expires });
  }
  if (sample && !db.prepare('SELECT 1 FROM requests WHERE company_id = ?').get(companyId)) seed(companyId);
});

if (created.length) {
  writeFileSync(OUT, JSON.stringify({ generatedAt: now, accounts: created }, null, 2), { mode: 0o600 });
  try { chmodSync(OUT, 0o600); } catch {}
  console.log(`Created ${created.length} account(s). Temporary passwords written to ${OUT} (keep it private).`);
} else {
  console.log('All example accounts already exist; nothing was reset.');
}
if (sample) console.log('Sample requests, shifts and a run are present.');

function seed(companyId) {
  const id = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const U = Object.fromEntries(ACCOUNTS.map((a) => [a.email.split('@')[0], id(a.email)]));
  const t = (mins) => new Date(Date.now() + mins * 60e3).toISOString();
  const insReq = db.prepare(`INSERT INTO requests (company_id, requester_id, title, category, priority, status, pickup_address,
    pickup_contact_name, pickup_contact_phone, pickup_lat, pickup_lng, scheduled_at, handling, handling_notes, notes, source, rider_id,
    created_at, updated_at, assigned_at, collected_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insDrop = db.prepare(`INSERT INTO dropoffs (request_id, seq, address, contact_name, contact_phone, lat, lng, instructions, status, handled_at, received_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const act = db.prepare(`INSERT INTO activity (company_id, request_id, user_id, action, message, created_at) VALUES (?,?,?,?,?,?)`);
  const HQ = ['Example Media HQ, Westlands', 'Reception desk', '+254700000100', -1.2649, 36.8028];
  const items = [
    ['Signed contracts for client review', 'general', 'urgent', 'pending', U.studio, null, ['documents', 'signature'], [['Upper Hill Chambers, 4th floor', 'Mercy Atieno', '+254711000201', -1.2992, 36.8137]], -40],
    ['Triangle campaign proofs', 'triangle', 'normal', 'pending', U.studio, null, ['fragile', 'keep_upright'], [['Triangle Agency, Kilimani', 'Joseph Kip', '+254711000202', -1.2905, 36.7840], ['Print House, Industrial Area', 'Print desk', '+254711000203', -1.3065, 36.8530]], -25],
    ['Petty cash float', 'finance', 'urgent', 'pending', U.finance, null, ['cash', 'confidential', 'signature'], [['Branch office, CBD', 'Peter Mutua', '+254711000204', -1.2864, 36.8232]], -15],
    ['Camera kit return', 'general', 'normal', 'assigned', U.studio, U['rider.hassan'], ['fragile', 'heavy'], [['Rental studio, Karen', 'Studio desk', '+254711000205', -1.3197, 36.7073]], -90],
    ['Bank deposit slips', 'finance', 'normal', 'collected', U.finance, U['rider.grace'], ['confidential', 'documents'], [['Bank branch, Moi Avenue', 'Teller 3', '+254711000206', -1.2833, 36.8236], ['Auditor office, Parklands', 'Ruth', '+254711000207', -1.2600, 36.8180]], -150],
    ['Triangle event banners', 'triangle', 'normal', 'assigned', U.studio, U['rider.felix'], ['heavy'], [['Venue, Lavington', 'Event manager', '+254711000208', -1.2780, 36.7690]], -60],
    ['Hard drive to post-production', 'general', 'normal', 'delivered', U.studio, U['rider.irene'], ['fragile'], [['Edit suite, Kileleshwa', 'Tom', '+254711000209', -1.2810, 36.7830]], -300],
    ['Invoices to client', 'finance', 'normal', 'delivered', U.finance, U['rider.grace'], ['documents', 'signature'], [['Client HQ, Gigiri', 'Accounts', '+254711000210', -1.2330, 36.8050]], -420],
    ['Quarterly brochures to the printer', 'general', 'normal', 'pending', U.studio, null, ['heavy'], [['Print House, Industrial Area', 'Print desk', '+254711000203', -1.3065, 36.8530]], -20, 26 * 60],
  ];
  for (const [title, cat, pri, status, req, rider, handling, drops, ago, scheduleIn] of items) {
    const created = t(ago);
    const r = insReq.run(companyId, req, title, cat, pri, status, ...HQ, scheduleIn ? t(scheduleIn) : status === 'pending' && cat === 'general' ? t(45) : null,
      JSON.stringify(handling), handling.includes('cash') ? 'Count with recipient before handing over.' : null, null,
      title.includes('Triangle') ? 'whatsapp' : 'form', rider, created, created,
      rider ? t(ago + 10) : null, ['collected', 'delivered'].includes(status) ? t(ago + 25) : null, status === 'delivered' ? t(ago + 70) : null);
    const rid = Number(r.lastInsertRowid);
    drops.forEach((d, i) => insDrop.run(rid, i + 1, d[0], d[1], d[2], d[3], d[4], null,
      status === 'delivered' ? 'delivered' : status === 'collected' && i === 0 ? 'delivered' : 'pending',
      status === 'delivered' || (status === 'collected' && i === 0) ? t(ago + 50) : null,
      status === 'delivered' || (status === 'collected' && i === 0) ? d[1] : null));
    act.run(companyId, rid, req, 'created', `Request created: ${title}`, created);
    if (rider) act.run(companyId, rid, U.dispatch, 'assigned', `Cynthia Mwangi assigned the rider`, t(ago + 10));
    if (status === 'delivered') act.run(companyId, rid, rider, 'delivered', 'All drop-offs delivered', t(ago + 70));
  }
  // Shift log for the past week, and three riders switched on shift now with a demo GPS position.
  const day = new Date(); day.setHours(8, 0, 0, 0);
  const insShift = db.prepare('INSERT INTO shifts (company_id, rider_id, starts_at, ends_at, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)');
  for (let d = -6; d < 0; d++) {
    for (const [k, start, len] of [['rider.felix', 8, 9], ['rider.grace', 8, 8], ['rider.hassan', 10, 8], ['rider.irene', 12, 8]]) {
      if ((d + k.length) % 7 === 6) continue;
      const s = new Date(day.getTime() + d * 864e5 + (start - 8) * 3600e3);
      insShift.run(companyId, U[k], s.toISOString(), new Date(s.getTime() + len * 3600e3).toISOString(), null, U.dispatch, now);
    }
  }
  const insLoc = db.prepare(`INSERT OR REPLACE INTO rider_locations (rider_id, company_id, lat, lng, accuracy, heading, speed, recorded_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insPoint = db.prepare('INSERT INTO location_points (company_id, rider_id, lat, lng, accuracy, speed, recorded_at) VALUES (?,?,?,?,?,?,?)');
  for (const [k, track] of [
    ['rider.felix', [[-1.2649, 36.8028], [-1.2700, 36.7900], [-1.2760, 36.7760]]],
    ['rider.grace', [[-1.2649, 36.8028], [-1.2750, 36.8150], [-1.2840, 36.8240]]],
    ['rider.hassan', [[-1.2649, 36.8028], [-1.2900, 36.7700], [-1.3050, 36.7450]]],
  ]) {
    db.prepare('UPDATE users SET on_shift = 1, on_shift_since = ? WHERE id = ?').run(t(-180), U[k]);
    track.forEach(([lat, lng], i) => insPoint.run(companyId, U[k], lat, lng, 12, 24, t(-30 + i * 14.5)));
    const [lat, lng] = track.at(-1);
    insLoc.run(U[k], companyId, lat, lng, 12, 210, 24, t(-1));
  }
  const run = db.prepare(`INSERT INTO runs (company_id, rider_id, name, status, created_by, created_at, started_at) VALUES (?,?,?,?,?,?,?)`)
    .run(companyId, U['rider.grace'], 'Afternoon finance loop', 'active', U.dispatch, t(-140), t(-130));
  db.prepare(`UPDATE requests SET run_id = ? WHERE rider_id = ? AND status = 'collected'`).run(run.lastInsertRowid, U['rider.grace']);
}
