// Consistent SQLite snapshot with integrity check and 14-copy retention.
import { DatabaseSync } from 'node:sqlite';
import { readdir, unlink, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const DB_FILE = process.env.DB_FILE || path.join(process.env.DATA_DIR || '/data', 'rider-requests.sqlite');
const DIR = process.env.BACKUP_DIR || '/backups';
const KEEP = Number(process.env.BACKUP_KEEP || 14);

await mkdir(DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tmp = path.join(DIR, `.rider-requests-${stamp}.partial`);
const final = path.join(DIR, `rider-requests-${stamp}.sqlite`);

const src = new DatabaseSync(DB_FILE, { readOnly: true });
src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
src.close();

const check = new DatabaseSync(tmp, { readOnly: true });
const result = check.prepare('PRAGMA integrity_check').get();
const counts = check.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM requests) AS requests').get();
check.close();
if (Object.values(result)[0] !== 'ok') {
  await unlink(tmp);
  console.error('Backup failed integrity check:', result);
  process.exit(1);
}
await rename(tmp, final);

const files = (await readdir(DIR)).filter((f) => /^rider-requests-.*\.sqlite$/.test(f)).sort();
for (const old of files.slice(0, Math.max(0, files.length - KEEP))) await unlink(path.join(DIR, old));
console.log(`Backup written: ${final} (${counts.users} users, ${counts.requests} requests). Keeping ${Math.min(files.length, KEEP)}.`);
