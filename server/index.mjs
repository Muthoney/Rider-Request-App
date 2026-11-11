import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { createApp } from './app.mjs';
import { createIntegrations } from './integrations.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(process.env.DATA_DIR || '/data', 'rider-requests.sqlite');
const APP_ORIGIN = process.env.APP_ORIGIN;
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

if (!APP_ORIGIN) {
  console.error('APP_ORIGIN must be set to the exact origin users open, e.g. https://riders.example.com');
  process.exit(1);
}
if (!COOKIE_SECURE && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(APP_ORIGIN)) {
  console.error('COOKIE_SECURE=false is only allowed for loopback development origins.');
  process.exit(1);
}

const db = openDb(DB_FILE);
const integrations = createIntegrations(process.env);
const handler = createApp({
  integrations,
  db, origin: APP_ORIGIN, cookieSecure: COOKIE_SECURE, trustProxy: TRUST_PROXY, distDir: path.join(root, 'dist'),
  log: (level, msg) => (level === 'error' ? console.error(msg) : process.env.LOG_REQUESTS === '1' && console.log(msg)),
  // Local development only (loopback origin, non-Secure cookies): when no email, WhatsApp or SMS
  // provider is configured, print password-reset links here so recovery can be tried end to end.
  onResetLink: COOKIE_SECURE ? null : ({ email, link }) => console.log(`[dev] Password reset link for ${email}: ${link}`),
});

const server = http.createServer(handler);
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.listen(PORT, HOST, () => {
  console.log(`Rider Requests listening on ${HOST}:${PORT} (origin ${APP_ORIGIN})`);
  const on = (b) => (b ? 'on' : 'off');
  console.log(`Integrations: Google Maps ${on(integrations.maps.browserKey)}, geocoding/routes ${on(integrations.geocode.configured)}, ` +
    `WhatsApp ${on(integrations.whatsapp.configured)}, SMS ${on(integrations.sms.configured)}, email ${on(integrations.email.configured)}`);
});

const shutdown = () => server.close(async () => { await handler.idle(); db.close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
