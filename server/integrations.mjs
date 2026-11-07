// External providers: Google Maps (geocoding, routes), WhatsApp Cloud API and Africa's Talking SMS.
// Each one is optional. When its environment variables are missing, `configured` is false and the
// app falls back (Kenyan place list for geocoding, straight-line estimates for routes, SMS for
// WhatsApp, and "skipped" notification records when nothing is configured).
import { createHmac, timingSafeEqual } from 'node:crypto';
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
    /** Sends an approved template (needed outside the 24-hour window) or, without one, plain text. */
    async send({ to, text, params }) {
      const recipient = to.replace(/^\+/, '');
      const payload = whatsapp.template
        ? {
          messaging_product: 'whatsapp', to: recipient, type: 'template',
          template: {
            name: whatsapp.template, language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
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
      const { ok, data } = await fetchJson(fetchImpl, `${host}/version1/messaging`, {
        method: 'POST', headers: { apiKey: atKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
      });
      const r = data?.SMSMessageData?.Recipients?.[0];
      if (!ok || !r || ![100, 101, 102].includes(Number(r.statusCode))) {
        throw new Error(r?.status || data?.SMSMessageData?.Message || 'SMS provider did not accept the message');
      }
      return { id: r.messageId };
    },
  };

  return {
    maps: { browserKey: mapsBrowserKey, mapId: env.GOOGLE_MAPS_MAP_ID || '' },
    geocode, routes, whatsapp, sms,
  };
}

// WhatsApp template parameters may not contain new lines, tabs or more than four spaces in a row.
const clean = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 900) || '-';

/** Integrations with nothing configured, for tests and local development. */
export const noIntegrations = () => createIntegrations({});
