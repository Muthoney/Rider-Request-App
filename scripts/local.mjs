// Cross-platform local runner (Windows, macOS, Linux).
// Loads .env.local if present, sets development defaults, then runs a server script:
//   node scripts/local.mjs dev | provision [--sample] | backup
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Optional private keys for local development (Google Maps, WhatsApp, SMS). Git ignores it.
try { process.loadEnvFile(path.join(root, '.env.local')); } catch {}
const defaults = {
  APP_ORIGIN: 'http://127.0.0.1:3000',
  COOKIE_SECURE: 'false',
  HOST: '127.0.0.1',
  DATA_DIR: path.join(root, 'data'),
  BACKUP_DIR: path.join(root, 'backups'),
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;

const scripts = { dev: 'index.mjs', provision: 'provision.mjs', backup: 'backup.mjs' };
const cmd = process.argv[2];
if (!scripts[cmd]) {
  console.error(`Usage: node scripts/local.mjs <${Object.keys(scripts).join('|')}> [--sample]`);
  process.exit(1);
}
await import(pathToFileURL(path.join(root, 'server', scripts[cmd])).href);
