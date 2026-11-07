// Parses a pasted WhatsApp message (or exported chat snippet) into request fields.
// Pure function, shared by the browser and the server. Nothing is sent to WhatsApp.

const PHONE_RE = /(?:\+?254|0)\s?[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}/;
const COORD_RE = /(-?\d{1,2}\.\d{2,})\s*,\s*(-?\d{1,3}\.\d{2,})/;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

const HANDLING_WORDS = [
  ['fragile', /\bfragile|handle with care|glass\b/i],
  ['keep_upright', /\bupright|this way up|do not tilt\b/i],
  ['confidential', /\bconfidential|sealed|private\b/i],
  ['signature', /\bsignature|sign(ed)? for|must sign\b/i],
  ['cash', /\bcash|cheque|money\b/i],
  ['cold', /\bcold|chilled|frozen|keep cool\b/i],
  ['documents', /\bdocuments?|papers|envelope|files?\b/i],
  ['heavy', /\bheavy|bulky\b/i],
];

const PICKUP_KEYS = /^(pick\s*-?\s*up|pickup|collect(ion)?(\s+from)?|from|origin)\b\s*(point|address|location)?\s*[:\-–]\s*/i;
const DROP_KEYS = /^(drop\s*-?\s*off|drop|deliver(y)?(\s+to)?|to|destination)\s*(\d+)?\s*(point|address|location)?\s*[:\-–]\s*/i;
const ITEM_KEYS = /^(item|items|parcel|package|what|goods|description)\s*[:\-–]\s*/i;
const CONTACT_KEYS = /^(contact|receiver|recipient|call|phone|tel|attn|person)\s*[:\-–]\s*/i;
const TIME_KEYS = /^(time|when|pickup time|schedule[d]?|at)\s*[:\-–]\s*/i;
const NOTE_KEYS = /^(note|notes|instructions?|comment)\s*[:\-–]\s*/i;
const PIN_KEYS = /^(📍\s*)?(location|pin|map|live location)\s*[:\-–]?\s*/i;

/** Strip WhatsApp export prefixes like "[07/11/2026, 14:02] Jane:" or "07/11/2026, 14:02 - Jane:". */
export function stripChatPrefix(line) {
  return line
    .replace(/^\[\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]m)?\]\s*[^:]{1,40}:\s*/i, '')
    .replace(/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}\s*(?:[ap]m)?\s*-\s*[^:]{1,40}:\s*/i, '');
}

/** Extract coordinates from a maps link or plain "lat, lng" text. */
export function parsePin(text) {
  if (!text) return null;
  const urls = text.match(URL_RE) || [];
  for (const raw of urls) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    for (const key of ['q', 'query', 'll', 'destination', 'center', 'daddr']) {
      const v = u.searchParams.get(key);
      const m = v && v.match(COORD_RE);
      if (m) return valid(+m[1], +m[2], raw);
    }
    const at = u.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || u.pathname.match(/\/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
    if (at) return valid(+at[1], +at[2], raw);
    const bang = raw.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (bang) return valid(+bang[1], +bang[2], raw);
    if (/goo\.gl|maps\.app/i.test(u.hostname)) return { lat: null, lng: null, url: raw, unresolved: true };
  }
  const plain = text.replace(URL_RE, '').match(COORD_RE);
  if (plain) return valid(+plain[1], +plain[2], null);
  return null;
}
function valid(lat, lng, url) {
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, url };
}

function splitContact(text) {
  const phoneM = text.match(PHONE_RE);
  const phone = phoneM ? normalisePhone(phoneM[0]) : null;
  const name = text.replace(PHONE_RE, '').replace(/[,;()\-–]+/g, ' ').replace(/\s+/g, ' ').trim() || null;
  return { name, phone };
}
export function normalisePhone(p) {
  const digits = p.replace(/\D/g, '');
  if (digits.startsWith('254')) return `+${digits}`;
  if (digits.startsWith('0')) return `+254${digits.slice(1)}`;
  return p.trim();
}

const blankStop = () => ({ address: '', contactName: null, contactPhone: null, lat: null, lng: null, instructions: null });

export function parseWhatsApp(input) {
  const lines = String(input || '')
    .split(/\r?\n/)
    .map((l) => stripChatPrefix(l.trim()))
    // Strip list bullets / markdown, but keep the minus sign of negative coordinates.
    .map((l) => l.replace(/^(?:[*_~•>\s]|[-–](?=\s))+|[*_~]+$/g, '').trim())
    .filter(Boolean);

  const result = {
    title: null, pickup: blankStop(), dropoffs: [], handling: [], notes: null, scheduledText: null,
    pins: [], unmatched: [], warnings: [],
  };
  const pendingPins = [];
  let current = null; // the stop that the next contact / pin line attaches to
  const looseNotes = [];

  for (const line of lines) {
    const pin = parsePin(line);
    const isPinLine = pin && (PIN_KEYS.test(line) || line.replace(URL_RE, '').replace(COORD_RE, '').replace(PIN_KEYS, '').trim().length < 3);
    if (isPinLine) {
      result.pins.push(pin);
      const target = current && current.lat == null ? current : null;
      if (pin.unresolved) result.warnings.push('A short maps link was found; open it and paste the full link or coordinates to place the pin.');
      if (target && !pin.unresolved) { target.lat = pin.lat; target.lng = pin.lng; }
      else if (!pin.unresolved) pendingPins.push(pin);
      continue;
    }
    let m;
    if ((m = line.match(PICKUP_KEYS))) {
      current = result.pickup;
      assignAddress(current, line.slice(m[0].length));
      continue;
    }
    if ((m = line.match(DROP_KEYS))) {
      current = blankStop();
      result.dropoffs.push(current);
      assignAddress(current, line.slice(m[0].length));
      continue;
    }
    if ((m = line.match(ITEM_KEYS))) { result.title = line.slice(m[0].length).trim().slice(0, 120); continue; }
    if ((m = line.match(CONTACT_KEYS))) {
      const c = splitContact(line.slice(m[0].length));
      const target = current || result.pickup;
      if (c.name && !target.contactName) target.contactName = c.name;
      if (c.phone && !target.contactPhone) target.contactPhone = c.phone;
      continue;
    }
    if ((m = line.match(TIME_KEYS))) { result.scheduledText = line.slice(m[0].length).trim(); continue; }
    if ((m = line.match(NOTE_KEYS))) {
      const text = line.slice(m[0].length).trim();
      if (current && current !== result.pickup) current.instructions = text; else looseNotes.push(text);
      continue;
    }
    if (current && PHONE_RE.test(line) && line.replace(PHONE_RE, '').trim().length < 40) {
      const c = splitContact(line);
      if (c.phone && !current.contactPhone) current.contactPhone = c.phone;
      if (c.name && !current.contactName) current.contactName = c.name;
      continue;
    }
    result.unmatched.push(line);
    looseNotes.push(line);
  }

  // Place unattached pins in order: pickup first, then drop-offs missing coordinates.
  for (const pin of pendingPins) {
    const target = [result.pickup, ...result.dropoffs].find((s) => s.lat == null);
    if (target) { target.lat = pin.lat; target.lng = pin.lng; }
  }

  const all = lines.join(' ');
  for (const [flag, re] of HANDLING_WORDS) if (re.test(all)) result.handling.push(flag);
  if (looseNotes.length) result.notes = looseNotes.join('\n').slice(0, 2000);
  if (!result.title && result.unmatched.length) result.title = result.unmatched[0].slice(0, 120);
  if (!result.pickup.address) result.warnings.push('No pickup line found. Start a line with “Pickup:”.');
  if (!result.dropoffs.length) result.warnings.push('No drop-off found. Start each one with “Drop:” or “Deliver to:”.');
  return result;
}

function assignAddress(stop, rest) {
  const pin = parsePin(rest);
  if (pin && !pin.unresolved) { stop.lat = pin.lat; stop.lng = pin.lng; }
  let text = rest.replace(URL_RE, '').trim();
  const phoneM = text.match(PHONE_RE);
  if (phoneM) {
    stop.contactPhone = normalisePhone(phoneM[0]);
    text = text.replace(PHONE_RE, '');
  }
  // "Address (Contact Name)" or "Address, attn Name"
  const paren = text.match(/\(([^)]+)\)\s*$/);
  if (paren && !/\d/.test(paren[1])) { stop.contactName = paren[1].trim(); text = text.replace(paren[0], ''); }
  const attn = text.match(/[,;]\s*(?:attn|ask for|contact)\.?\s*([^,;]+)$/i);
  if (attn) { stop.contactName = attn[1].trim(); text = text.replace(attn[0], ''); }
  text = text.replace(COORD_RE, '').replace(/[\s,;\-–]+$/, '').trim();
  stop.address = text.slice(0, 300);
}
