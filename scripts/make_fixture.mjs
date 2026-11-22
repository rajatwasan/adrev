// Deterministic synthetic San Francisco extract for local development and tests.
// Writes public/data/city.json in the CityFile shape. No network, seeded PRNG.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellToLatLng, cellToParent, latLngToCell, polygonToCells } from 'h3-js';

const RES = 9;
const ZONE_RES = 7;
const N_PLACES = 6000;
const BBOX = [-122.5155, 37.7045, -122.355, 37.835];

// mulberry32: tiny seeded PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260101);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const r5 = (n) => Math.round(n * 1e5) / 1e5;

// ---- 1. Cells ----------------------------------------------------------------
// Rough eastern shoreline: max lng that is still land, by latitude (linear interpolation).
const SHORE = [
  [37.708, -122.357],
  [37.74, -122.37],
  [37.77, -122.385],
  [37.79, -122.388],
  [37.806, -122.405],
  [37.81, -122.41],
];
function maxLng(lat) {
  if (lat <= SHORE[0][0]) return SHORE[0][1];
  for (let i = 1; i < SHORE.length; i++) {
    if (lat <= SHORE[i][0]) {
      const [la0, ln0] = SHORE[i - 1];
      const [la1, ln1] = SHORE[i];
      return ln0 + ((lat - la0) / (la1 - la0)) * (ln1 - ln0);
    }
  }
  return SHORE[SHORE.length - 1][1];
}
const isLand = (lat, lng) =>
  lng >= -122.51 && lng >= -122.505 && lng <= maxLng(lat) && lat >= 37.708 && lat <= 37.81;

const poly = [
  [37.707, -122.511],
  [37.811, -122.511],
  [37.811, -122.356],
  [37.707, -122.356],
];
const candidates = polygonToCells(poly, RES).sort();
const cellIds = [];
const cellLat = [];
const cellLng = [];
for (const id of candidates) {
  const [lat, lng] = cellToLatLng(id);
  if (!isLand(lat, lng)) continue;
  cellIds.push(id);
  cellLat.push(r5(lat));
  cellLng.push(r5(lng));
}
const cellIndex = new Map(cellIds.map((id, i) => [id, i]));

// Parks and open land get zero addresses.
const inBox = (lat, lng, s, w, n, e) => lat >= s && lat <= n && lng >= w && lng <= e;
function isOpenSpace(lat, lng) {
  return (
    inBox(lat, lng, 37.764, -122.511, 37.772, -122.455) || // Golden Gate Park
    inBox(lat, lng, 37.79, -122.49, 37.81, -122.445) || // Presidio
    inBox(lat, lng, 37.708, -122.505, 37.728, -122.48) || // Lake Merced
    inBox(lat, lng, 37.728, -122.455, 37.742, -122.44) // Glen Canyon
  );
}
const reach = cellLat.map((lat, i) => {
  const lng = cellLng[i];
  const ne = Math.min(1, Math.max(0, ((lat - 37.708) / 0.1 + (lng + 122.51) / 0.153) / 2));
  const u = rand();
  const zeroRoll = rand();
  if (isOpenSpace(lat, lng) || zeroRoll < 0.04) return 0;
  const density = 0.12 + 0.88 * ne * ne * 1.4;
  return Math.min(450, Math.round(450 * Math.min(1, density) * (0.3 + 0.7 * Math.pow(u, 0.6))));
});

// ---- 2. Zones ----------------------------------------------------------------
const parentOf = cellIds.map((id) => cellToParent(id, ZONE_RES));
// Merge sparse parents (open space, slivers at the coast) into the nearest dense parent.
const parentReach = new Map();
parentOf.forEach((p, i) => parentReach.set(p, (parentReach.get(p) ?? 0) + reach[i]));
const centers = new Map([...parentReach.keys()].map((p) => [p, cellToLatLng(p)]));
const dense = [...parentReach.keys()].filter((p) => parentReach.get(p) >= 1000);
const mergedInto = new Map();
for (const p of parentReach.keys()) {
  if (dense.includes(p)) {
    mergedInto.set(p, p);
    continue;
  }
  let best = dense[0];
  let bd = Infinity;
  for (const q of dense) {
    const d = (centers.get(p)[0] - centers.get(q)[0]) ** 2 + (centers.get(p)[1] - centers.get(q)[1]) ** 2;
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  mergedInto.set(p, best);
}
const finalParentOf = parentOf.map((p) => mergedInto.get(p));
const parents = dense.map((p) => ({ p, lat: centers.get(p)[0], lng: centers.get(p)[1] }));
// north to south, then west to east, so ZIP style ids climb in a stable order
parents.sort((a, b) => b.lat - a.lat || a.lng - b.lng);
const ZIPS = [
  94102, 94103, 94104, 94105, 94107, 94108, 94109, 94110, 94111, 94112, 94114, 94115, 94116, 94117,
  94118, 94121, 94122, 94123, 94124, 94127, 94129, 94130, 94131, 94132, 94133, 94134, 94158,
];
const zoneOfParent = new Map();
const zones = parents.map((pp, i) => {
  const code = String(i < ZIPS.length ? ZIPS[i] : 94200 + (i - ZIPS.length));
  zoneOfParent.set(pp.p, i);
  return { id: code, label: code };
});
const cellZone = finalParentOf.map((p) => zoneOfParent.get(p));

// ---- 3. Categories -----------------------------------------------------------
// [id, label, parent, group, weight, name suffixes]
const CATS = [
  ['dental_clinic', 'Dental Clinic', 'outpatient_care_facility', 'health_care', 2.2, ['Dental Care', 'Family Dentistry', 'Dental Studio', 'Smiles']],
  ['pediatric_clinic', 'Pediatric Clinic', 'outpatient_care_facility', 'health_care', 0.7, ['Pediatrics', 'Children’s Clinic', 'Kids Health']],
  ['doctors_office', 'Doctor’s Office', 'outpatient_care_facility', 'health_care', 2.4, ['Medical Group', 'Family Medicine', 'Primary Care']],
  ['urgent_care_clinic', 'Urgent Care Clinic', 'outpatient_care_facility', 'health_care', 0.5, ['Urgent Care', 'Walk In Clinic']],
  ['optometrist', 'Optometrist', 'outpatient_care_facility', 'health_care', 0.8, ['Eye Care', 'Vision Center', 'Optometry']],
  ['gym', 'Gym', 'sport_or_fitness_facility', 'sports_and_recreation', 1.8, ['Fitness', 'Athletic Club', 'Gym', 'Strength Lab']],
  ['fitness_studio', 'Fitness Studio', 'sport_or_fitness_facility', 'sports_and_recreation', 1.6, ['Fit Studio', 'Cycle Club', 'Boot Camp']],
  ['yoga_studio', 'Yoga Studio', 'sport_or_fitness_facility', 'sports_and_recreation', 1.4, ['Yoga', 'Yoga Collective', 'Flow Studio']],
  ['pilates_studio', 'Pilates Studio', 'sport_or_fitness_facility', 'sports_and_recreation', 0.7, ['Pilates', 'Reformer Studio']],
  ['coffee_shop', 'Coffee Shop', 'non_alcoholic_beverage_venue', 'food_and_drink', 11, ['Coffee', 'Coffee Roasters', 'Espresso Bar', 'Coffee Co']],
  ['cafe', 'Cafe', 'casual_eatery', 'food_and_drink', 6, ['Cafe', 'Corner Cafe', 'Kitchen Cafe']],
  ['bakery', 'Bakery', 'casual_eatery', 'food_and_drink', 3, ['Bakery', 'Bread Co', 'Pastry House']],
  ['restaurant', 'Restaurant', 'restaurant_venue', 'food_and_drink', 20, ['Kitchen', 'Bistro', 'Grill', 'Taqueria', 'Noodle House', 'Trattoria', 'Dumpling House', 'Thai Kitchen']],
  ['pizza_restaurant', 'Pizza Restaurant', 'restaurant_venue', 'food_and_drink', 3, ['Pizzeria', 'Pizza Co', 'Slice House']],
  ['bar', 'Bar', 'alcoholic_beverage_venue', 'food_and_drink', 6, ['Tavern', 'Taproom', 'Social Club', 'Pub', 'Bar']],
  ['grocery_store', 'Grocery Store', 'food_and_beverage_store', 'shopping', 2.6, ['Market', 'Grocery', 'Fresh Foods', 'Produce Market']],
  ['convenience_store', 'Convenience Store', 'food_and_beverage_store', 'shopping', 3, ['Corner Store', 'Mini Mart', 'Quick Stop']],
  ['pharmacy', 'Pharmacy', 'drugstore', 'shopping', 1.5, ['Pharmacy', 'Drug', 'Rx']],
  ['school', 'School', 'educational_institution', 'education', 1.2, ['School', 'Academy', 'Prep']],
  ['elementary_school', 'Elementary School', 'educational_institution', 'education', 1.4, ['Elementary School', 'Elementary']],
  ['preschool', 'Preschool', 'educational_institution', 'education', 1.0, ['Preschool', 'Early Learning', 'Montessori']],
  ['child_care_and_day_care', 'Child Care and Day Care', 'childcare_service', 'education', 1.2, ['Day Care', 'Child Care', 'Little Ones']],
  ['hair_salon', 'Hair Salon', 'beauty_salon', 'beauty_and_spa', 4.5, ['Hair Studio', 'Salon', 'Hair Co', 'Cuts and Color']],
  ['barber', 'Barber', 'beauty_salon', 'beauty_and_spa', 2.5, ['Barbershop', 'Barber Co', 'Cuts']],
  ['nail_salon', 'Nail Salon', 'beauty_salon', 'beauty_and_spa', 2.2, ['Nails', 'Nail Spa', 'Nail Bar']],
  ['day_spa', 'Day Spa', 'beauty_salon', 'beauty_and_spa', 1.0, ['Day Spa', 'Spa', 'Wellness Spa']],
  ['veterinarian', 'Veterinarian', 'animal_care', 'pets', 1.0, ['Veterinary', 'Animal Hospital', 'Pet Clinic']],
  ['pet_store', 'Pet Store', 'pet_retail', 'shopping', 1.2, ['Pet Supply', 'Pet Shop', 'Paws']],
  ['park', 'Park', 'outdoor_recreation_facility', 'sports_and_recreation', 1.0, ['Park', 'Square', 'Commons', 'Gardens']],
  ['playground', 'Playground', 'outdoor_recreation_facility', 'sports_and_recreation', 0.6, ['Playground', 'Play Area']],
  ['dog_park', 'Dog Park', 'outdoor_recreation_facility', 'sports_and_recreation', 0.3, ['Dog Park', 'Dog Run']],
  ['library', 'Library', 'public_service', 'education', 0.3, ['Library', 'Branch Library']],
  ['hotel', 'Hotel', 'accommodation', 'travel_and_lodging', 1.0, ['Hotel', 'Inn', 'Suites', 'Lodge']],
  ['museum', 'Museum', 'cultural_venue', 'arts_and_entertainment', 0.4, ['Museum', 'Gallery', 'Heritage Center']],
  ['bank', 'Bank', 'financial_service', 'financial_service', 1.5, ['Bank', 'Savings', 'Credit Union']],
  ['automotive_repair', 'Automotive Repair', 'automotive_service', 'automotive', 2.0, ['Auto Repair', 'Garage', 'Motors', 'Tire and Brake']],
  ['clothing_store', 'Clothing Store', 'fashion_retail', 'shopping', 2.8, ['Apparel', 'Boutique', 'Threads', 'Outfitters']],
  ['bookstore', 'Bookstore', 'specialty_retail', 'shopping', 0.5, ['Books', 'Bookshop']],
  ['hardware_store', 'Hardware Store', 'specialty_retail', 'shopping', 0.6, ['Hardware', 'Tool and Supply']],
  ['florist', 'Florist', 'specialty_retail', 'shopping', 0.6, ['Florals', 'Flower Shop']],
  ['movie_theater', 'Movie Theater', 'entertainment_venue', 'arts_and_entertainment', 0.2, ['Cinema', 'Theater', 'Picture House']],
];
const cats = CATS.map(([id, label, parent, group]) => ({ id, label, parent, group }));

// Invented chains, keyed by category id.
const CHAINS = {
  coffee_shop: ['Bayline Coffee', 'Sunrise Roasters'],
  gym: ['Foghorn Fitness'],
  fitness_studio: ['Foghorn Fitness'],
  grocery_store: ['Fresh Basket Market'],
  pharmacy: ['Goldengate Rx'],
  bank: ['Embarcadero Savings'],
  hair_salon: ['Clip and Co'],
  restaurant: ['Plate House'],
};
const brands = [...new Set(Object.values(CHAINS).flat())];

const HOODS = [
  'Mission', 'Fog City', 'Sunset', 'Noe', 'Haight', 'Marina', 'Richmond', 'Bernal', 'Potrero', 'Castro',
  'Embarcadero', 'Twin Peaks', 'Cable Car', 'Presidio', 'Dogpatch', 'SoMa', 'Nob Hill', 'Golden Gate',
  'Bayview', 'Excelsior', 'Alamo', 'Lakeshore', 'Hayes', 'Fillmore', 'Telegraph', 'Russian Hill',
  'Ocean Beach', 'Cole Valley', 'Glen Park', 'Portola', 'Pacific', 'Union', 'Divisadero', 'Mariposa',
];
const STREETS = [
  'Valencia St', 'Mission St', 'Market St', 'Geary Blvd', 'Irving St', 'Judah St', 'Divisadero St',
  'Fillmore St', 'Polk St', 'Columbus Ave', 'Van Ness Ave', 'Haight St', 'Clement St', 'Noriega St',
  '24th St', '16th St', 'Folsom St', 'Howard St', 'Bryant St', 'Guerrero St', 'Castro St',
  'Union St', 'Chestnut St', 'Lombard St', 'Taraval St', 'Ocean Ave', 'Church St', 'Dolores St',
  'Octavia St', 'Hayes St', 'Fulton St', 'Balboa St', 'Cabrillo St', 'Lincoln Way', 'Bay St',
];

// ---- 4. Places ---------------------------------------------------------------
// Pick cells in proportion to reach (plus a small floor so parks and open land get a few places).
const weights = reach.map((r) => r + 8);
const cum = [];
let acc = 0;
for (const w of weights) cum.push((acc += w));
function pickCell() {
  const x = rand() * acc;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const catCum = [];
let catAcc = 0;
for (const c of CATS) catCum.push((catAcc += c[4]));
function pickCat() {
  const x = rand() * catAcc;
  for (let i = 0; i < catCum.length; i++) if (x <= catCum[i]) return i;
  return catCum.length - 1;
}
const PARKISH = new Set(['park', 'playground', 'dog_park']);
const catPos = new Map(CATS.map((c, i) => [c[0], i]));

const P = { name: [], lat: [], lng: [], cat: [], conf: [], brand: [], addr: [], cell: [] };
for (let n = 0; n < N_PLACES; n++) {
  const ci = pickCat();
  const [id, , , , , suffixes] = CATS[ci];
  // parks prefer open space cells
  let cell = pickCell();
  if (PARKISH.has(id)) {
    for (let t = 0; t < 12 && reach[cell] > 0; t++) cell = pickCell();
  }
  let lat = cellLat[cell];
  let lng = cellLng[cell];
  let cellIdx = cell;
  for (let t = 0; t < 8; t++) {
    const la = r5(cellLat[cell] + (rand() - 0.5) * 0.0026);
    const ln = r5(cellLng[cell] + (rand() - 0.5) * 0.0032);
    const k = cellIndex.get(latLngToCell(la, ln, RES));
    if (k !== undefined) {
      lat = la;
      lng = ln;
      cellIdx = k;
      break;
    }
  }
  // consistency: the stored cell is always the one containing the stored point
  const k = cellIndex.get(latLngToCell(lat, lng, RES));
  cellIdx = k === undefined ? -1 : k;

  let brand = -1;
  let name;
  if (CHAINS[id] && rand() < 0.16) {
    const b = pick(CHAINS[id]);
    brand = brands.indexOf(b);
    name = b;
  } else {
    name = `${pick(HOODS)} ${pick(suffixes)}`;
  }
  const u = rand();
  P.name.push(name);
  P.lat.push(lat);
  P.lng.push(lng);
  P.cat.push(ci);
  P.conf.push(Math.min(100, 40 + Math.floor(61 * (1 - u * u))));
  P.brand.push(brand);
  P.addr.push(`${1 + Math.floor(rand() * 3200)} ${pick(STREETS)}, San Francisco, CA`);
  P.cell.push(cellIdx);
}
void catPos;

// ---- 5. Write ----------------------------------------------------------------
const city = {
  meta: {
    city: 'San Francisco',
    bbox: BBOX,
    release: 'fixture',
    generated: '2026-01-01',
    zoneKind: 'zip',
    reachSource: 'addresses',
    synthetic: true,
  },
  cats,
  brands,
  places: P,
  cells: { res: RES, id: cellIds, lat: cellLat, lng: cellLng, reach, zone: cellZone },
  zones,
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'city.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(city) + '\n');
const totalReach = reach.reduce((s, r) => s + r, 0);
console.log(
  `fixture: ${cellIds.length} cells, ${zones.length} zones, ${P.name.length} places, ${totalReach} total reach`,
);
