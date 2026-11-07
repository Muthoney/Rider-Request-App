// Fuel consumption and delivery quote maths, shared by the browser and the server. Pure module.

/**
 * Defaults for a 125–150cc delivery motorcycle in Nairobi traffic. Every value can be changed on the
 * Fuel & quotes page. Fuel price: EPRA maximum pump price for Super Petrol in Nairobi, 15 Oct – 14 Nov 2026.
 */
export const FUEL_DEFAULTS = {
  fuelType: 'petrol',
  fuelPrice: 226.96, // KES per litre
  fuelPriceUpdatedAt: '2026-10-15',
  kmPerLitre: 35,
  timeRatePerHour: 200, // KES per hour of rider time
  baseFee: 100, // KES per trip
  roadFactor: 1.3, // straight-line → road distance
};
export const AVG_SPEED_KMH = 22; // motorcycle average in city traffic
export const MINUTES_PER_STOP = 5;

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Estimated road distance along stops in order (straight lines × road factor). */
export function routeKm(points, roadFactor = FUEL_DEFAULTS.roadFactor) {
  const pts = points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversineKm(pts[i - 1], pts[i]);
  return km * roadFactor;
}

export const estimateMinutes = (km, stops = 1) => (km / AVG_SPEED_KMH) * 60 + stops * MINUTES_PER_STOP;

/**
 * Distance along a GPS track in km. Drops fixes with poor accuracy (> 100 m), ignores jitter under
 * 15 m, skips jumps that imply more than 120 km/h, and does not bridge gaps longer than 30 minutes
 * (for example overnight, or between shifts).
 */
export function trackKm(points) {
  let km = 0;
  let last = null;
  for (const p of points) {
    if (p.accuracy != null && p.accuracy > 100) continue;
    if (!last) { last = p; continue; }
    const d = haversineKm(last, p);
    const hours = (new Date(p.recordedAt) - new Date(last.recordedAt)) / 3600e3;
    if (hours > 0.5) { last = p; continue; }
    if (hours > 0 && d / hours > 120) continue;
    if (d < 0.015) continue;
    km += d;
    last = p;
  }
  return km;
}

const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Quote for a trip: base fee + fuel (distance ÷ efficiency × price) + rider time. */
export function quote({ km, minutes }, settings = FUEL_DEFAULTS) {
  const s = { ...FUEL_DEFAULTS, ...settings };
  const distance = Math.max(0, Number(km) || 0);
  const mins = Math.max(0, Number(minutes) || 0);
  const litres = distance / s.kmPerLitre;
  const fuelCost = litres * s.fuelPrice;
  const timeCost = (mins / 60) * s.timeRatePerHour;
  const subtotal = s.baseFee + fuelCost + timeCost;
  return {
    km: round(distance, 1), minutes: Math.round(mins), litres: round(litres, 2),
    fuelPrice: s.fuelPrice, fuelCost: round(fuelCost), timeCost: round(timeCost), baseFee: round(s.baseFee),
    total: Math.ceil(subtotal / 10) * 10, // rounded up to the next KES 10
  };
}

export const kes = (n) => `KES ${Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
