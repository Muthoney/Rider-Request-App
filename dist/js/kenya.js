// Kenya-only place lookup, shared by the browser and the server. Pure module, no network.
// Coordinates are approximate (roughly the centre of an area or a representative point on a
// street) and are only used when no exact pin or Google geocode is available.

/** Bounding box around Kenya. Pins outside it are rejected. */
export const KENYA_BOUNDS = { south: -4.9, north: 5.1, west: 33.8, east: 42.0 };
export const NAIROBI = { lat: -1.2864, lng: 36.8231 };

export function isInKenya(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= KENYA_BOUNDS.south && lat <= KENYA_BOUNDS.north && lng >= KENYA_BOUNDS.west && lng <= KENYA_BOUNDS.east;
}

// [name, lat, lng, kind, city, aliases]. kind: landmark > street > area > town.
const PLACES = [
  // ---- Nairobi landmarks ----
  ['KICC', -1.2884, 36.8233, 'landmark', 'Nairobi', ['kenyatta international convention centre', 'kenyatta international conference centre']],
  ['Kenyatta National Hospital', -1.3010, 36.8070, 'landmark', 'Nairobi', ['knh']],
  ['Nairobi Hospital', -1.2955, 36.8040, 'landmark', 'Nairobi', []],
  ['Aga Khan University Hospital', -1.2615, 36.8240, 'landmark', 'Nairobi', ['aga khan hospital']],
  ['MP Shah Hospital', -1.2620, 36.8150, 'landmark', 'Nairobi', ['m p shah']],
  ['University of Nairobi', -1.2795, 36.8165, 'landmark', 'Nairobi', ['uon main campus']],
  ['Strathmore University', -1.3090, 36.8130, 'landmark', 'Nairobi', ['strathmore']],
  ['Kenyatta University', -1.1800, 36.9280, 'landmark', 'Nairobi', []],
  ['USIU', -1.2190, 36.8830, 'landmark', 'Nairobi', ['united states international university']],
  ['Uhuru Park', -1.2890, 36.8170, 'landmark', 'Nairobi', []],
  ['Nairobi Railway Station', -1.2910, 36.8280, 'landmark', 'Nairobi', ['railway station', 'railways']],
  ['Machakos Country Bus Station', -1.2870, 36.8320, 'landmark', 'Nairobi', ['country bus']],
  ['Kencom', -1.2860, 36.8250, 'landmark', 'Nairobi', ['kencom house']],
  ['Times Tower', -1.2915, 36.8235, 'landmark', 'Nairobi', ['kra times tower']],
  ['Parliament Buildings', -1.2890, 36.8200, 'landmark', 'Nairobi', ['parliament']],
  ['City Market', -1.2830, 36.8200, 'landmark', 'Nairobi', []],
  ['Nation Centre', -1.2847, 36.8237, 'landmark', 'Nairobi', ['nation house']],
  ['Gikomba Market', -1.2830, 36.8370, 'landmark', 'Nairobi', ['gikomba']],
  ['Nyayo Stadium', -1.3040, 36.8250, 'landmark', 'Nairobi', ['nyayo national stadium']],
  ['Kasarani Stadium', -1.2230, 36.8930, 'landmark', 'Nairobi', ['moi international sports centre']],
  ['Sarit Centre', -1.2610, 36.8020, 'landmark', 'Nairobi', ['sarit']],
  ['Westgate Mall', -1.2570, 36.8030, 'landmark', 'Nairobi', ['westgate']],
  ['ABC Place', -1.2580, 36.7790, 'landmark', 'Nairobi', []],
  ['Yaya Centre', -1.2930, 36.7880, 'landmark', 'Nairobi', ['yaya']],
  ['Prestige Plaza', -1.3000, 36.7860, 'landmark', 'Nairobi', []],
  ['The Junction Mall', -1.2990, 36.7620, 'landmark', 'Nairobi', ['junction mall']],
  ['Village Market', -1.2300, 36.8050, 'landmark', 'Nairobi', []],
  ['Two Rivers Mall', -1.2110, 36.7950, 'landmark', 'Nairobi', ['two rivers']],
  ['Garden City Mall', -1.2320, 36.8780, 'landmark', 'Nairobi', ['garden city']],
  ['Thika Road Mall', -1.2190, 36.8880, 'landmark', 'Nairobi', ['trm']],
  ['Galleria Mall', -1.3380, 36.7690, 'landmark', 'Nairobi', ['galleria']],
  ['The Hub Karen', -1.3190, 36.7030, 'landmark', 'Nairobi', ['hub karen']],
  ['Capital Centre', -1.3180, 36.8340, 'landmark', 'Nairobi', []],
  ['T-Mall', -1.3110, 36.8150, 'landmark', 'Nairobi', ['t mall']],
  ['JKIA', -1.3192, 36.9278, 'landmark', 'Nairobi', ['jomo kenyatta international airport', 'jomo kenyatta airport']],
  ['Wilson Airport', -1.3217, 36.8148, 'landmark', 'Nairobi', []],
  ['UN Gigiri', -1.2338, 36.8155, 'landmark', 'Nairobi', ['unon', 'united nations office']],
  ['JKUAT', -1.0960, 37.0140, 'landmark', 'Juja', ['jomo kenyatta university']],

  // ---- Nairobi streets ----
  ['Moi Avenue', -1.2840, 36.8250, 'street', 'Nairobi', []],
  ['Kenyatta Avenue', -1.2860, 36.8195, 'street', 'Nairobi', []],
  ['Haile Selassie Avenue', -1.2900, 36.8260, 'street', 'Nairobi', ['haile selassie']],
  ['Uhuru Highway', -1.2900, 36.8180, 'street', 'Nairobi', []],
  ['Waiyaki Way', -1.2620, 36.7900, 'street', 'Nairobi', []],
  ['Ngong Road', -1.3000, 36.7800, 'street', 'Nairobi', []],
  ['Mombasa Road', -1.3300, 36.8600, 'street', 'Nairobi', []],
  ['Thika Road', -1.2300, 36.8800, 'street', 'Nairobi', ['thika superhighway']],
  ['Jogoo Road', -1.2960, 36.8600, 'street', 'Nairobi', []],
  ['Langata Road', -1.3300, 36.7800, 'street', 'Nairobi', []],
  ['Argwings Kodhek Road', -1.2930, 36.7870, 'street', 'Nairobi', ['argwings kodhek']],
  ['Lenana Road', -1.2960, 36.7960, 'street', 'Nairobi', []],
  ['Ring Road Kilimani', -1.2930, 36.7900, 'street', 'Nairobi', []],
  ['Ring Road Westlands', -1.2650, 36.8050, 'street', 'Nairobi', []],
  ['Enterprise Road', -1.3070, 36.8480, 'street', 'Nairobi', []],
  ['Limuru Road', -1.2450, 36.8150, 'street', 'Nairobi', []],
  ['Kiambu Road', -1.2200, 36.8350, 'street', 'Nairobi', []],
  ['Outer Ring Road', -1.2700, 36.8900, 'street', 'Nairobi', []],
  ['Lusaka Road', -1.3020, 36.8350, 'street', 'Nairobi', []],
  ['Chiromo Road', -1.2700, 36.8070, 'street', 'Nairobi', []],
  ['Riverside Drive', -1.2700, 36.7980, 'street', 'Nairobi', []],
  ['Mama Ngina Street', -1.2860, 36.8230, 'street', 'Nairobi', []],
  ['Kimathi Street', -1.2845, 36.8225, 'street', 'Nairobi', []],
  ['Tom Mboya Street', -1.2830, 36.8270, 'street', 'Nairobi', []],
  ['Ronald Ngala Street', -1.2830, 36.8290, 'street', 'Nairobi', []],
  ['Muindi Mbingu Street', -1.2830, 36.8170, 'street', 'Nairobi', []],
  ['Koinange Street', -1.2840, 36.8185, 'street', 'Nairobi', []],
  ['University Way', -1.2800, 36.8170, 'street', 'Nairobi', []],
  ['Harambee Avenue', -1.2890, 36.8240, 'street', 'Nairobi', []],
  ['Parliament Road', -1.2880, 36.8215, 'street', 'Nairobi', []],
  ['City Hall Way', -1.2880, 36.8210, 'street', 'Nairobi', []],
  ['Wabera Street', -1.2850, 36.8200, 'street', 'Nairobi', []],
  ['Kaunda Street', -1.2860, 36.8210, 'street', 'Nairobi', []],
  ['Standard Street', -1.2850, 36.8220, 'street', 'Nairobi', []],
  ['Loita Street', -1.2860, 36.8175, 'street', 'Nairobi', []],
  ['Biashara Street', -1.2820, 36.8210, 'street', 'Nairobi', []],
  ['Moktar Daddah Street', -1.2820, 36.8200, 'street', 'Nairobi', []],
  ['River Road', -1.2830, 36.8290, 'street', 'Nairobi', []],
  ['Accra Road', -1.2820, 36.8280, 'street', 'Nairobi', []],
  ['Muranga Road', -1.2750, 36.8280, 'street', 'Nairobi', ["murang'a road"]],
  ['Hospital Road', -1.3000, 36.8070, 'street', 'Nairobi', []],
  ['Ralph Bunche Road', -1.2970, 36.8050, 'street', 'Nairobi', []],
  ['Upper Hill Road', -1.2980, 36.8130, 'street', 'Nairobi', []],
  ['Valley Road', -1.2930, 36.8050, 'street', 'Nairobi', []],
  ['Mbagathi Way', -1.3080, 36.8000, 'street', 'Nairobi', []],
  ['Wood Avenue', -1.2970, 36.7880, 'street', 'Nairobi', []],
  ['Dennis Pritt Road', -1.2870, 36.7960, 'street', 'Nairobi', []],
  ['Woodvale Grove', -1.2650, 36.8050, 'street', 'Nairobi', []],
  ['Muthithi Road', -1.2660, 36.8080, 'street', 'Nairobi', []],
  ['Mpaka Road', -1.2630, 36.8090, 'street', 'Nairobi', []],
  ['Rhapta Road', -1.2690, 36.8010, 'street', 'Nairobi', []],
  ['Peponi Road', -1.2450, 36.7970, 'street', 'Nairobi', []],
  ['James Gichuru Road', -1.2650, 36.7680, 'street', 'Nairobi', []],
  ['Kangundo Road', -1.2700, 36.9300, 'street', 'Nairobi', []],
  ['Magadi Road', -1.3900, 36.7700, 'street', 'Nairobi', []],

  // ---- Nairobi & metro areas ----
  ['Nairobi CBD', -1.2864, 36.8231, 'area', 'Nairobi', ['cbd', 'city centre', 'town centre', 'downtown']],
  ['Westlands', -1.2676, 36.8108, 'area', 'Nairobi', []],
  ['Kilimani', -1.2900, 36.7850, 'area', 'Nairobi', []],
  ['Upper Hill', -1.2990, 36.8150, 'area', 'Nairobi', ['upperhill']],
  ['Kileleshwa', -1.2810, 36.7830, 'area', 'Nairobi', []],
  ['Lavington', -1.2780, 36.7690, 'area', 'Nairobi', []],
  ['Parklands', -1.2600, 36.8180, 'area', 'Nairobi', []],
  ['Gigiri', -1.2330, 36.8050, 'area', 'Nairobi', []],
  ['Karen', -1.3197, 36.7073, 'area', 'Nairobi', []],
  ['Langata', -1.3600, 36.7450, 'area', 'Nairobi', ["lang'ata"]],
  ['Industrial Area', -1.3065, 36.8530, 'area', 'Nairobi', []],
  ['South B', -1.3100, 36.8330, 'area', 'Nairobi', []],
  ['South C', -1.3200, 36.8250, 'area', 'Nairobi', []],
  ['Nairobi West', -1.3080, 36.8240, 'area', 'Nairobi', []],
  ['Madaraka', -1.3080, 36.8180, 'area', 'Nairobi', []],
  ['Eastleigh', -1.2740, 36.8510, 'area', 'Nairobi', []],
  ['Pangani', -1.2700, 36.8370, 'area', 'Nairobi', []],
  ['Ngara', -1.2740, 36.8230, 'area', 'Nairobi', []],
  ['Kasarani', -1.2210, 36.8970, 'area', 'Nairobi', []],
  ['Roysambu', -1.2180, 36.8860, 'area', 'Nairobi', []],
  ['Zimmerman', -1.2130, 36.8960, 'area', 'Nairobi', []],
  ['Githurai', -1.2000, 36.9150, 'area', 'Nairobi', []],
  ['Kahawa', -1.1860, 36.9230, 'area', 'Nairobi', []],
  ['Embakasi', -1.3180, 36.9000, 'area', 'Nairobi', []],
  ['Utawala', -1.2900, 36.9650, 'area', 'Nairobi', []],
  ['Donholm', -1.2960, 36.8920, 'area', 'Nairobi', []],
  ['Buruburu', -1.2860, 36.8760, 'area', 'Nairobi', []],
  ['Hurlingham', -1.2960, 36.7960, 'area', 'Nairobi', []],
  ['Riverside', -1.2700, 36.8000, 'area', 'Nairobi', []],
  ['Spring Valley', -1.2440, 36.7930, 'area', 'Nairobi', []],
  ['Highridge', -1.2580, 36.8070, 'area', 'Nairobi', []],
  ['Runda', -1.2180, 36.8100, 'area', 'Nairobi', []],
  ['Muthaiga', -1.2490, 36.8330, 'area', 'Nairobi', []],
  ['Loresho', -1.2540, 36.7550, 'area', 'Nairobi', []],
  ['Kangemi', -1.2650, 36.7470, 'area', 'Nairobi', []],
  ['Kawangware', -1.2850, 36.7480, 'area', 'Nairobi', []],
  ['Dagoretti', -1.3010, 36.7330, 'area', 'Nairobi', []],
  ['Kibera', -1.3130, 36.7880, 'area', 'Nairobi', []],
  ['Mathare', -1.2600, 36.8590, 'area', 'Nairobi', []],
  ['Ruaka', -1.2100, 36.7780, 'area', 'Kiambu', []],
  ['Syokimau', -1.3600, 36.9330, 'area', 'Machakos', []],
  ['Mlolongo', -1.3900, 36.9400, 'area', 'Machakos', []],
  ['Athi River', -1.4560, 36.9780, 'area', 'Machakos', ['mavoko']],
  ['Kitengela', -1.4730, 36.9600, 'area', 'Kajiado', []],
  ['Rongai', -1.3960, 36.7600, 'area', 'Kajiado', ['ongata rongai']],
  ['Ngong', -1.3600, 36.6560, 'area', 'Kajiado', ['ngong town']],
  ['Kikuyu', -1.2460, 36.6630, 'area', 'Kiambu', []],
  ['Ruiru', -1.1460, 36.9600, 'area', 'Kiambu', []],
  ['Juja', -1.1020, 37.0140, 'area', 'Kiambu', []],
  ['Limuru', -1.1140, 36.6420, 'area', 'Kiambu', []],

  // ---- Mombasa ----
  ['Fort Jesus', -4.0628, 39.6795, 'landmark', 'Mombasa', []],
  ['Moi International Airport', -4.0348, 39.5942, 'landmark', 'Mombasa', ['mombasa airport']],
  ['City Mall Nyali', -4.0200, 39.7200, 'landmark', 'Mombasa', ['nyali city mall']],
  ['Nyali', -4.0300, 39.7100, 'area', 'Mombasa', []],
  ['Bamburi', -3.9900, 39.7300, 'area', 'Mombasa', []],
  ['Likoni', -4.0800, 39.6600, 'area', 'Mombasa', []],
  ['Kizingo', -4.0700, 39.6700, 'area', 'Mombasa', []],
  ['Changamwe', -4.0200, 39.6300, 'area', 'Mombasa', []],
  ['Mtwapa', -3.9400, 39.7500, 'area', 'Kilifi', []],
  // ---- other landmarks ----
  ['Kisumu Airport', -0.0861, 34.7289, 'landmark', 'Kisumu', []],
  ['Eldoret Airport', 0.4045, 35.2389, 'landmark', 'Eldoret', []],

  // ---- towns ----
  ['Nairobi', -1.2864, 36.8231, 'town', 'Nairobi', []],
  ['Mombasa', -4.0435, 39.6682, 'town', 'Mombasa', []],
  ['Kisumu', -0.0917, 34.7680, 'town', 'Kisumu', []],
  ['Nakuru', -0.3031, 36.0800, 'town', 'Nakuru', []],
  ['Eldoret', 0.5143, 35.2698, 'town', 'Eldoret', []],
  ['Thika', -1.0333, 37.0693, 'town', 'Thika', []],
  ['Kiambu', -1.1714, 36.8356, 'town', 'Kiambu', ['kiambu town']],
  ['Machakos', -1.5177, 37.2634, 'town', 'Machakos', []],
  ['Kajiado', -1.8520, 36.7760, 'town', 'Kajiado', []],
  ['Nyeri', -0.4201, 36.9476, 'town', 'Nyeri', []],
  ['Meru', 0.0463, 37.6559, 'town', 'Meru', []],
  ['Embu', -0.5310, 37.4500, 'town', 'Embu', []],
  ['Muranga', -0.7210, 37.1520, 'town', 'Muranga', ["murang'a"]],
  ['Kerugoya', -0.4980, 37.2800, 'town', 'Kerugoya', []],
  ['Nanyuki', 0.0167, 37.0727, 'town', 'Nanyuki', []],
  ['Isiolo', 0.3546, 37.5822, 'town', 'Isiolo', []],
  ['Naivasha', -0.7167, 36.4333, 'town', 'Naivasha', []],
  ['Nyahururu', 0.0380, 36.3630, 'town', 'Nyahururu', []],
  ['Narok', -1.0780, 35.8600, 'town', 'Narok', []],
  ['Kericho', -0.3689, 35.2863, 'town', 'Kericho', []],
  ['Bomet', -0.7813, 35.3416, 'town', 'Bomet', []],
  ['Kisii', -0.6817, 34.7667, 'town', 'Kisii', []],
  ['Homa Bay', -0.5273, 34.4571, 'town', 'Homa Bay', []],
  ['Migori', -1.0634, 34.4731, 'town', 'Migori', []],
  ['Kakamega', 0.2827, 34.7519, 'town', 'Kakamega', []],
  ['Bungoma', 0.5635, 34.5606, 'town', 'Bungoma', []],
  ['Busia', 0.4608, 34.1115, 'town', 'Busia', []],
  ['Kapsabet', 0.2041, 35.1050, 'town', 'Kapsabet', []],
  ['Kitale', 1.0157, 35.0062, 'town', 'Kitale', []],
  ['Lodwar', 3.1191, 35.5973, 'town', 'Lodwar', []],
  ['Kitui', -1.3667, 38.0167, 'town', 'Kitui', []],
  ['Wote', -1.7800, 37.6300, 'town', 'Wote', ['makueni']],
  ['Voi', -3.3961, 38.5561, 'town', 'Voi', []],
  ['Malindi', -3.2192, 40.1169, 'town', 'Malindi', []],
  ['Kilifi', -3.6305, 39.8499, 'town', 'Kilifi', []],
  ['Diani', -4.2800, 39.5800, 'town', 'Diani', ['ukunda']],
  ['Lamu', -2.2717, 40.9020, 'town', 'Lamu', []],
  ['Garissa', -0.4532, 39.6461, 'town', 'Garissa', []],
  ['Marsabit', 2.3340, 37.9900, 'town', 'Marsabit', []],
  ['Wajir', 1.7471, 40.0573, 'town', 'Wajir', []],
  ['Mandera', 3.9373, 41.8569, 'town', 'Mandera', []],
  ['Moyale', 3.5270, 39.0560, 'town', 'Moyale', []],
].map(([name, lat, lng, kind, city, aliases]) => ({
  name, lat, lng, kind, city, keys: [name, ...aliases].map(normalise),
}));

const KIND_WEIGHT = { landmark: 4, street: 3, area: 2, town: 1 };
const METRO = new Set(['Nairobi', 'Kiambu', 'Machakos', 'Kajiado', 'Juja']);

/** Lower-case, expand common abbreviations, strip punctuation. */
export function normalise(text) {
  return ` ${String(text || '').toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\brd\b/g, 'road').replace(/\bave?\b/g, 'avenue').replace(/\bst\b/g, 'street')
    .replace(/\bhwy\b/g, 'highway').replace(/\bdr\b/g, 'drive').replace(/\bnbi\b/g, 'nairobi')
    .replace(/\bmsa\b/g, 'mombasa').replace(/\bctr\b|\bcenter\b/g, 'centre')
    .replace(/\s+/g, ' ').trim()} `;
}

function matches(text) {
  const t = normalise(text);
  const found = [];
  for (const p of PLACES) {
    const key = p.keys.find((k) => t.includes(k));
    if (key) found.push({ place: p, len: key.length });
  }
  return found;
}

/**
 * Best Kenyan landmark, street, area or town mentioned in an address, or null.
 * If the address names a town outside Nairobi, Nairobi streets are ignored (e.g. "Moi Avenue, Mombasa").
 */
export function lookupPlace(address) {
  const found = matches(address);
  if (!found.length) return null;
  const towns = found.filter((f) => f.place.kind === 'town' && f.place.city !== 'Nairobi').map((f) => f.place.city);
  const pool = towns.length
    ? found.filter((f) => towns.includes(f.place.city) || (f.place.kind !== 'street' && !METRO.has(f.place.city)))
    : found;
  const best = (pool.length ? pool : found)
    .sort((a, b) => KIND_WEIGHT[b.place.kind] - KIND_WEIGHT[a.place.kind] || b.len - a.len)[0].place;
  return { name: best.name, lat: best.lat, lng: best.lng, kind: best.kind, city: best.city };
}

/** Up to `limit` places whose name or alias contains every word of the query. */
export function searchPlaces(query, limit = 6) {
  const words = normalise(query).trim().split(' ').filter((w) => w.length > 1);
  if (!words.length) return [];
  const direct = lookupPlace(query);
  const hits = PLACES.filter((p) => p.keys.some((k) => words.every((w) => k.includes(` ${w}`) || k.includes(w))));
  const list = direct ? [PLACES.find((p) => p.name === direct.name), ...hits.filter((p) => p.name !== direct.name)] : hits;
  return list.slice(0, limit).map((p) => ({
    label: p.name, address: p.city && p.city !== p.name ? `${p.name}, ${p.city}` : `${p.name}, Kenya`,
    lat: p.lat, lng: p.lng, kind: p.kind, source: 'gazetteer', approximate: true,
  }));
}
