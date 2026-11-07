// Server-provided integration settings (Google Maps key, which providers are connected).
import { api } from './api.js';

let cached = null;
const FALLBACK = { maps: { browserKey: null, mapId: null }, geocoder: 'gazetteer', routing: 'estimate', notifications: { whatsapp: false, sms: false } };

export function getConfig() {
  if (!cached) cached = api.get('/api/config').catch(() => { cached = null; return FALLBACK; });
  return cached;
}
export const resetConfig = () => { cached = null; };
