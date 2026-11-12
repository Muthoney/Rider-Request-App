// External providers: Google Maps (geocoding, routes), WhatsApp Cloud API, Africa's Talking SMS and
// SMTP email. Each one is optional. When its environment variables are missing, `configured` is false
// and the app falls back (Kenyan place list for geocoding, straight-line estimates for routes, SMS for
// WhatsApp, WhatsApp then SMS for email, and "skipped" notification records when nothing is configured).
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { isInKenya } from '../dist/js/kenya.js';

const TIMEOUT_MS = 8000;

async function fetchJson(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

/** E.164 without spaces, Kenyan numbers normalised: 0712… / 254712… → +254712… */
export function e164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `+254${digits}`;
  if (/^254[17]\d{8}$/.test(digits)) return `+${digits}`;
  if (String(phone).trim().startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function createIntegrations(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const mapsBrowserKey = env.GOOGLE_MAPS_BROWSER_KEY || env.GOOGLE_MAPS_API_KEY || '';
  const mapsServerKey = env.GOOGLE_MAPS_SERVER_KEY || env.GOOGLE_MAPS_API_KEY || '';

  // ---------- Google geocoding (Kenya only) ----------
  const geocode = {
    configured: !!mapsServerKey,
    async search(query) {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('address', query);
      url.searchParams.set('components', 'country:KE');
      url.searchParams.set('region', 'ke');
      url.searchParams.set('key', mapsServerKey);
      const { data } = await fetchJson(fetchImpl, url);
      if (!data || !['OK', 'ZERO_RESULTS'].includes(data.status)) throw new Error(`Google geocoding failed: ${data?.status || 'no response'}`);
      return (data.results || [])
        .filter((r) => (r.address_components || []).some((c) => c.types?.includes('country') && c.short_name === 'KE'))
        .map((r) => ({ label: r.address_components?.[0]?.long_name || r.formatted_address, address: r.formatted_address,
          lat: r.geometry.location.lat, lng: r.geometry.location.lng, source: 'google', approximate: r.geometry.location_type === 'APPROXIMATE' }))
        .filter((r) => isInKenya(r.lat, r.lng))
        .slice(0, 6);
    },
  };

  // ---------- Google Routes API (distance + duration along roads) ----------
  const routes = {
    configured: !!mapsServerKey,
    async compute(points) {
      const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
      const body = {
        origin: wp(points[0]), destination: wp(points.at(-1)),
        intermediates: points.slice(1, -1).map(wp),
        travelMode: env.GOOGLE_ROUTES_TRAVEL_MODE || 'DRIVE', regionCode: 'KE',
      };
      const { ok, data } = await fetchJson(fetchImpl, 'https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': mapsServerKey, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
        body: JSON.stringify(body),
      });
      const r = data?.routes?.[0];
      if (!ok || !r) throw new Error(`Google routes failed: ${data?.error?.message || 'no route'}`);
      return { km: (r.distanceMeters || 0) / 1000, minutes: parseFloat(r.duration || '0') / 60 };
    },
  };

  // ---------- WhatsApp Cloud API ----------
  const waToken = env.WHATSAPP_TOKEN, waPhoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  const whatsapp = {
    configured: !!(waToken && waPhoneId),
    template: env.WHATSAPP_TEMPLATE || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    /** Template for password-recovery links (one body variable: the link). Optional. */
    resetTemplate: env.WHATSAPP_RESET_TEMPLATE || '',
    /**
     * Sends an approved template (needed outside the 24-hour window) or, without one, plain text.
     * `template` defaults to the job-notification template; pass '' to force plain text.
     */
    async send({ to, text, params = [], template = whatsapp.template }) {
      const recipient = to.replace(/^\+/, '');
      const payload = template
        ? {
          messaging_product: 'whatsapp', to: recipient, type: 'template',
          template: {
            name: template, language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
            components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: clean(p) })) }],
          },
        }
        : { messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body: text, preview_url: false } };
      const { ok, data } = await fetchJson(fetchImpl, `https://graph.facebook.com/${env.WHATSAPP_API_VERSION || 'v21.0'}/${waPhoneId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!ok || !data?.messages?.[0]?.id) throw new Error(data?.error?.message || 'WhatsApp did not accept the message');
      return { id: data.messages[0].id };
    },
    /** Checks Meta's X-Hub-Signature-256 header against the raw request body. */
    validSignature(raw, header) {
      if (!whatsapp.appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
      const expected = Buffer.from(createHmac('sha256', whatsapp.appSecret).update(raw).digest('hex'));
      const given = Buffer.from(header.slice(7));
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };

  // ---------- Africa's Talking SMS ----------
  const atUser = env.AT_USERNAME, atKey = env.AT_API_KEY;
  const sms = {
    configured: !!(atUser && atKey),
    async send({ to, text }) {
      const host = atUser === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
      const form = new URLSearchParams({ username: atUser, to, message: text });
      if (env.AT_SENDER_ID) form.set('from', env.AT_SENDER_ID);
      let res;
      try {
        res = await fetchJson(fetchImpl, `${host}/version1/messaging`, {
          method: 'POST', headers: { apiKey: atKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
        });
      } catch (err) {
        throw Object.assign(new Error(`SMS gateway unreachable: ${err.message}`), { permanent: false });
      }
      const { ok, status, data } = res;
      const r = data?.SMSMessageData?.Recipients?.[0];
      if (!ok || !r || ![100, 101, 102].includes(Number(r.statusCode))) {
        const code = Number(r?.statusCode);
        // Africa's Talking: 401 RiskHold, 402 InvalidSenderId, 403 InvalidPhoneNumber, 404 UnsupportedNumberType,
        // 406 UserInBlacklist, 409 DoNotDisturb are final; 405 InsufficientBalance, 407 CouldNotRoute and 5xx are retried.
        const permanent = [401, 402, 403, 404, 406, 409].includes(code) || status === 401 || (status >= 400 && status < 500 && status !== 429 && !r);
        throw Object.assign(new Error(r?.status || data?.SMSMessageData?.Message || data?.raw || `SMS provider did not accept the message (HTTP ${status})`), { permanent, code });
      }
      return { id: r.messageId };
    },
  };

  // ---------- Firebase Cloud Messaging (Android push, optional) ----------
  // FCM_SERVICE_ACCOUNT: the service-account JSON (inline, or base64 of it). Without it the app relies
  // on the live event stream while open, and on SMS fallback when it is not.
  let fcmAccount = null;
  try {
    const raw = env.FCM_SERVICE_ACCOUNT || '';
    if (raw) fcmAccount = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch { fcmAccount = null; }
  let fcmToken = null;
  const push = {
    configured: !!(fcmAccount?.client_email && fcmAccount?.private_key && fcmAccount?.project_id),
    async send({ token, title, body, data = {} }) {
      if (!fcmToken || fcmToken.exp < Date.now() + 60e3) fcmToken = await googleAccessToken(fetchImpl, fcmAccount, 'https://www.googleapis.com/auth/firebase.messaging');
      const { ok, data: out } = await fetchJson(fetchImpl, `https://fcm.googleapis.com/v1/projects/${fcmAccount.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${fcmToken.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, notification: { title, body }, data, android: { priority: 'high', notification: { channel_id: 'dispatch' } } } }),
      });
      if (!ok) {
        const code = out?.error?.details?.find?.((d) => d.errorCode)?.errorCode || out?.error?.status;
        throw Object.assign(new Error(out?.error?.message || 'FCM rejected the message'), { unregistered: code === 'UNREGISTERED' || code === 'NOT_FOUND' });
      }
      return { id: out?.name };
    },
  };

  // ---------- SMTP email (password recovery) ----------
  const smtpPort = Number(env.SMTP_PORT || 587);
  const email = {
    configured: !!(env.SMTP_HOST && env.SMTP_FROM),
    async send({ to, subject, text }) {
      return smtpSend({
        host: env.SMTP_HOST, port: smtpPort, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : smtpPort === 465,
        user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.SMTP_FROM, name: env.SMTP_HELO || 'rider-requests',
      }, { to, subject, text });
    },
  };

  return {
    maps: { browserKey: mapsBrowserKey, mapId: env.GOOGLE_MAPS_MAP_ID || '' },
    geocode, routes, whatsapp, sms, email, push,
    /** Shared secret Africa's Talking must send (?token=…) on delivery-report callbacks. */
    smsCallbackToken: env.AT_CALLBACK_TOKEN || '',
  };
}

/** OAuth2 access token for a Google service account (JWT bearer grant, RS256). */
async function googleAccessToken(fetchImpl, account, scope) {
  const { createSign } = await import('node:crypto');
  const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iss: account.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url');
  const { ok, data } = await fetchJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  if (!ok || !data?.access_token) throw new Error(`Google token request failed: ${data?.error_description || data?.error || 'no token'}`);
  return { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
}

// ---------- minimal SMTP client (STARTTLS or implicit TLS, AUTH PLAIN/LOGIN) ----------
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const addressOf = (s) => (/<([^>]+)>/.exec(s)?.[1] || s).trim();
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

/** Sends one plain-text email. Resolves with the server's queue reply; rejects on any SMTP error. */
export async function smtpSend(cfg, { to, subject, text }) {
  const rcpt = addressOf(oneLine(to));
  const from = oneLine(cfg.from);
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(rcpt)) throw new Error('Invalid recipient address');
  let socket;
  let buf = '';
  let pending = null;
  let failure = null;
  const onData = (d) => { buf += d; pump(); };
  const onError = (e) => { failure = e; if (pending) { const p = pending; pending = null; p.reject(e); } };
  const attach = (s) => { socket = s; s.setEncoding('utf8'); s.on('data', onData); s.on('error', onError); };
  function pump() {
    if (!pending) return;
    const m = /^(?:\d{3}-[^\r\n]*\r?\n)*(\d{3})(?: [^\r\n]*)?\r?\n/.exec(buf);
    if (!m) return;
    buf = buf.slice(m[0].length);
    const p = pending; pending = null;
    p.resolve({ code: Number(m[1]), text: m[0] });
  }
  const read = () => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    pending = { resolve, reject };
    pump();
  });
  const cmd = async (line, ok, secret = false) => {
    if (line != null) socket.write(`${line}\r\n`);
    const r = await read();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${secret ? 'authentication' : (line || 'greeting').split(' ')[0]} failed: ${r.code} ${oneLine(r.text).slice(0, 160)}`);
    return r;
  };
  const connect = () => new Promise((resolve, reject) => {
    const s = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
    s.once(cfg.secure ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
  const timer = setTimeout(() => onError(new Error('SMTP timed out')), 20000);
  try {
    attach(await connect());
    socket.setTimeout(20000, () => onError(new Error('SMTP timed out')));
    await cmd(null, [220]);
    let ehlo = await cmd(`EHLO ${cfg.name}`, [250]);
    if (!cfg.secure && /STARTTLS/i.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      socket.removeListener('data', onData);
      const upgraded = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: cfg.host }, () => resolve(t));
        t.once('error', reject);
      });
      buf = '';
      attach(upgraded);
      ehlo = await cmd(`EHLO ${cfg.name}`, [250]);
    } else if (!cfg.secure && cfg.user) {
      throw new Error('SMTP server does not offer STARTTLS; refusing to send credentials in clear text');
    }
    if (cfg.user) {
      if (/AUTH[^\r\n]*PLAIN/i.test(ehlo.text)) await cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, [235], true);
      else {
        await cmd('AUTH LOGIN', [334]);
        await cmd(b64(cfg.user), [334], true);
        await cmd(b64(cfg.pass), [235], true);
      }
    }
    await cmd(`MAIL FROM:<${addressOf(from)}>`, [250]);
    await cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await cmd('DATA', [354]);
    const domain = addressOf(from).split('@')[1] || 'localhost';
    const message = [
      `From: ${from}`, `To: ${rcpt}`, `Subject: =?UTF-8?B?${b64(oneLine(subject))}?=`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text)),
    ].join('\r\n');
    const reply = await cmd(`${message}\r\n.`, [250]);
    socket.write('QUIT\r\n');
    return { id: oneLine(reply.text).slice(4, 120) };
  } finally {
    clearTimeout(timer);
    socket?.end();
  }
}

// WhatsApp template parameters may not contain new lines, tabs or more than four spaces in a row.
const clean = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 900) || '-';

/** Integrations with nothing configured, for tests and local development. */
export const noIntegrations = () => createIntegrations({});
