// Prepares a throwaway database: sample data, known passwords, riders on shift, a dispatch phone.
// Usage: node setup.mjs <projectRoot> <dataDir>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, dataDir] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { openDb } = await imp('server/db.mjs');
const { hashPassword } = await imp('server/security.mjs');
const db = openDb(path.join(dataDir, 'rider-requests.sqlite'));
const h = hashPassword('smoke-test-password-1');
db.prepare('UPDATE users SET password_hash = ?, must_change = 0, temp_expires_at = NULL').run(h);
const company = db.prepare('SELECT id FROM companies LIMIT 1').get().id;
db.prepare(`INSERT OR REPLACE INTO ops_settings (company_id, dispatch_phone) VALUES (?, '+254700000003')`).run(company);
console.log(db.prepare('SELECT email, role, on_shift FROM users').all().map((u) => `${u.role}:${u.email}:${u.on_shift}`).join('\n'));
