import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhatsApp, parsePin, stripChatPrefix, normalisePhone } from '../dist/js/whatsapp.js';

test('parses Google Maps links in their common shapes', () => {
  assert.deepEqual(parsePin('https://maps.google.com/?q=-1.2649,36.8028'), { lat: -1.2649, lng: 36.8028, url: 'https://maps.google.com/?q=-1.2649,36.8028' });
  assert.equal(parsePin('https://www.google.com/maps/@-1.2905,36.7840,17z').lat, -1.2905);
  assert.equal(parsePin('https://www.google.com/maps/place/X/data=!3d-1.30!4d36.85').lng, 36.85);
  assert.equal(parsePin('https://www.google.com/maps/search/?api=1&query=-1.2833,36.8236').lat, -1.2833);
  assert.deepEqual(parsePin('-1.2864, 36.8232'), { lat: -1.2864, lng: 36.8232, url: null });
  assert.equal(parsePin('https://maps.app.goo.gl/abc123').unresolved, true);
  assert.equal(parsePin('no pin here'), null);
  assert.equal(parsePin('99.1234, 36.8232'), null);
});

test('strips WhatsApp export prefixes', () => {
  assert.equal(stripChatPrefix('[07/11/2026, 09:14] Joy (Studio): Pickup: HQ'), 'Pickup: HQ');
  assert.equal(stripChatPrefix('07/11/2026, 09:14 - Joy: Drop: Bank'), 'Drop: Bank');
});

test('normalises Kenyan phone numbers', () => {
  assert.equal(normalisePhone('0711 000 202'), '+254711000202');
  assert.equal(normalisePhone('+254 711-000-202'), '+254711000202');
});

test('extracts pickup, multiple drop-offs, contacts, pins and handling from a message', () => {
  const p = parseWhatsApp(`[07/11/2026, 09:14] Joy: Hi dispatch
Item: Campaign proofs
Pickup: Example Media HQ, Westlands (Reception)
📍 Location: https://maps.google.com/?q=-1.2649,36.8028
Drop 1: Triangle Agency, Kilimani
Contact: Joseph Kip 0711 000 202
https://www.google.com/maps/@-1.2905,36.7840,17z
Drop 2: Print House, Industrial Area
Contact: Print desk 0711 000 203
Note: fragile, keep upright, signature needed`);
  assert.equal(p.title, 'Campaign proofs');
  assert.equal(p.pickup.address, 'Example Media HQ, Westlands');
  assert.equal(p.pickup.contactName, 'Reception');
  assert.equal(p.pickup.lat, -1.2649);
  assert.equal(p.dropoffs.length, 2);
  assert.equal(p.dropoffs[0].contactName, 'Joseph Kip');
  assert.equal(p.dropoffs[0].contactPhone, '+254711000202');
  assert.equal(p.dropoffs[0].lat, -1.2905);
  assert.equal(p.dropoffs[1].lat, null);
  assert.equal(p.dropoffs[1].instructions, 'fragile, keep upright, signature needed');
  for (const h of ['fragile', 'keep_upright', 'signature']) assert.ok(p.handling.includes(h), h);
  assert.deepEqual(p.warnings, []);
});

test('places loose pins in stop order and warns about missing parts', () => {
  const p = parseWhatsApp('Collect from: Bank\nDeliver to: Auditor\n-1.26, 36.81\n-1.30, 36.82');
  assert.equal(p.pickup.address, 'Bank');
  assert.equal(p.dropoffs[0].address, 'Auditor');
  assert.equal(p.dropoffs[0].lat, -1.26);
  assert.equal(p.pickup.lat, -1.30);
  const empty = parseWhatsApp('hello there');
  assert.equal(empty.warnings.length, 2);
  assert.equal(empty.title, 'hello there');
});
