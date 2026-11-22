import type { CityFile, Options, Priority, Subject, TradeArea, ZoneResult } from './types';

const EARTH_MI = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Every score is a weighted sum of four 0..1 parts. The weights are the whole model,
// kept here in one table so they are easy to read and argue with.
export const WEIGHTS: Record<Priority, { reach: number; gap: number; anchors: number; proximity: number }> = {
  balanced: { reach: 0.35, gap: 0.3, anchors: 0.15, proximity: 0.2 },
  reach: { reach: 0.55, gap: 0.15, anchors: 0.1, proximity: 0.2 },
  gap: { reach: 0.2, gap: 0.5, anchors: 0.1, proximity: 0.2 },
};

// A zone needs this many address points inside the radius to be worth a line item.
export const MIN_ZONE_REACH = 150;

// Complementary places: where the subject's customers already go.
// Matched against Overture category ids, so the rules stay readable.
const ANCHOR_RULES: { when: RegExp; anchors: RegExp; label: string }[] = [
  // First match wins, so the narrow rules sit above the broad ones.
  {
    when: /veterinar|animal_|pet_|dog_/,
    anchors: /^park$|dog_park|pet_store|pet_supplies|grocery_store|supermarket/,
    label: 'parks, pet stores and grocery stores',
  },
  {
    when: /dental|dentist|orthodon|pediatric|doctor|clinic|optometr|vision|chiropract|urgent_care|physical_therapy/,
    anchors: /school|kindergarten|child_care|day_care|pharmacy|grocery_store|supermarket/,
    label: 'schools, childcare, pharmacies and grocery stores',
  },
  {
    when: /^gym$|fitness|yoga|pilates|martial_art|climbing|sports_club/,
    anchors: /^cafe$|coffee_shop|juice|health_food|grocery_store|supermarket|sporting_goods/,
    label: 'coffee shops, juice bars, grocery and sporting goods stores',
  },
  {
    when: /child_care|day_care|preschool|tutor|kindergarten|school/,
    anchors: /playground|^park$|library|pediatric|grocery_store|supermarket/,
    label: 'playgrounds, parks, libraries and grocery stores',
  },
  {
    when: /salon|barber|^spa$|day_spa|beauty|nail|cosmetic|tattoo/,
    anchors: /^gym$|fitness_studio|^cafe$|coffee_shop|clothing|boutique|grocery_store|supermarket/,
    label: 'gyms, coffee shops, clothing and grocery stores',
  },
  {
    when: /restaurant|eatery|^cafe$|coffee|bakery|^bar$|_bar$|^pub$|pizz|dessert|tea_|_tea$|brewery|food_truck|steakhouse/,
    anchors: /^gym$|fitness_studio|theat|cinema|museum|hotel|college|university|^park$|coworking/,
    label: 'gyms, theaters, museums, hotels and campuses',
  },
];
const DEFAULT_ANCHORS = {
  anchors: /grocery_store|supermarket|school|^gym$|fitness_studio|^cafe$|coffee_shop|pharmacy/,
  label: 'grocery stores, schools, gyms, coffee shops and pharmacies',
};

export function anchorRule(catId: string): { anchors: RegExp; label: string } {
  return ANCHOR_RULES.find((r) => r.when.test(catId)) ?? DEFAULT_ANCHORS;
}

function minMax(values: number[]): (v: number) => number {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (!isFinite(lo) || hi === lo) return () => 0.5; // no spread, no signal
  return (v) => (v - lo) / (hi - lo);
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function buildTradeArea(city: CityFile, subject: Subject, options: Options): TradeArea {
  const { cells, places, cats, zones } = city;
  const subjectCat = cats[subject.cat];
  const isCompetitorCat = (c: number) =>
    options.scope === 'same' ? c === subject.cat : cats[c].parent === subjectCat.parent;
  const rule = anchorRule(subjectCat.id);
  const anchorCat = cats.map((c, i) => i !== subject.cat && rule.anchors.test(c.id));

  // 1. Cells inside the radius, grouped by zone.
  const inRadius = new Uint8Array(cells.id.length);
  let radiusReach = 0; // every address in the circle, including zones too thin to rank
  const byZone = new Map<number, { cells: number[]; reach: number; distSum: number; latSum: number; lngSum: number }>();
  for (let i = 0; i < cells.id.length; i++) {
    const d = distanceMi(subject.lat, subject.lng, cells.lat[i], cells.lng[i]);
    if (d > options.radiusMi) continue;
    inRadius[i] = 1;
    radiusReach += cells.reach[i];
    const z = cells.zone[i];
    if (z < 0) continue;
    let agg = byZone.get(z);
    if (!agg) byZone.set(z, (agg = { cells: [], reach: 0, distSum: 0, latSum: 0, lngSum: 0 }));
    const r = cells.reach[i];
    agg.cells.push(i);
    agg.reach += r;
    agg.distSum += d * r;
    agg.latSum += cells.lat[i] * r;
    agg.lngSum += cells.lng[i] * r;
  }

  // 2. Competitors and anchors per zone, plus the citywide base rate.
  const comp = new Map<number, number>();
  const anch = new Map<number, number>();
  const competitorIdx: number[] = [];
  const anchorIdx: number[] = [];
  let cityCompetitors = 0;
  for (let p = 0; p < places.cat.length; p++) {
    if (places.conf[p] < options.minConf || p === subject.placeIndex) continue;
    const c = places.cat[p];
    const isComp = isCompetitorCat(c);
    if (isComp) cityCompetitors++;
    if (!isComp && !anchorCat[c]) continue;
    const cell = places.cell[p];
    if (cell < 0 || !inRadius[cell]) continue;
    const z = cells.zone[cell];
    if (z < 0) continue;
    if (isComp) {
      competitorIdx.push(p);
      comp.set(z, (comp.get(z) ?? 0) + 1);
    } else {
      anchorIdx.push(p);
      anch.set(z, (anch.get(z) ?? 0) + 1);
    }
  }

  // 3. Raw metrics per zone.
  const raw = [...byZone.entries()]
    .filter(([, a]) => a.reach >= MIN_ZONE_REACH)
    .map(([z, a]) => {
      const competitors = comp.get(z) ?? 0;
      return {
        zone: z,
        cells: a.cells,
        reach: a.reach,
        competitors,
        competitorsPer1k: (competitors / a.reach) * 1000,
        anchors: anch.get(z) ?? 0,
        distanceMi: a.distSum / a.reach,
        lat: a.latSum / a.reach,
        lng: a.lngSum / a.reach,
      };
    });

  // 4. Normalize across the candidate zones and combine.
  const w = WEIGHTS[options.priority];
  const nReach = minMax(raw.map((r) => r.reach));
  const nComp = minMax(raw.map((r) => r.competitorsPer1k));
  const nAnch = minMax(raw.map((r) => r.anchors));
  const noun = options.scope === 'same' ? subjectCat.label.toLowerCase() : subjectCat.parent.replace(/_/g, ' ');

  const results: ZoneResult[] = raw.map((r) => {
    const parts = {
      reach: nReach(r.reach),
      gap: 1 - nComp(r.competitorsPer1k),
      anchors: nAnch(r.anchors),
      proximity: Math.max(0, 1 - r.distanceMi / options.radiusMi),
    };
    const score =
      100 * (w.reach * parts.reach + w.gap * parts.gap + w.anchors * parts.anchors + w.proximity * parts.proximity);
    const compText =
      r.competitors === 0
        ? `no competing ${noun} on record`
        : `${r.competitors} competing ${r.competitors === 1 ? noun : pluralize(noun)} (${r.competitorsPer1k.toFixed(1)} per 1,000 addresses)`;
    const reason = `${fmt(r.reach)} addresses, ${compText}, ${r.anchors} nearby anchor${r.anchors === 1 ? '' : 's'}, ${r.distanceMi.toFixed(1)} mi away`;
    return { ...r, id: zones[r.zone].id, label: zones[r.zone].label, parts, score, reason };
  });
  results.sort((a, b) => b.score - a.score || b.reach - a.reach);

  // 5. Is this area crowded compared with the city as a whole?
  const totalReach = results.reduce((s, r) => s + r.reach, 0);
  const cityReach = cells.reach.reduce((s, r) => s + r, 0);
  let saturation: TradeArea['saturation'] = null;
  // Numerator and denominator both cover the whole circle, so thin zones cannot skew the rate.
  if (radiusReach > 0 && cityReach > 0 && cityCompetitors > 0) {
    const areaPer10k = (competitorIdx.length / radiusReach) * 10000;
    const cityPer10k = (cityCompetitors / cityReach) * 10000;
    saturation = { areaPer10k, cityPer10k, ratio: areaPer10k / cityPer10k };
  }

  return {
    subject,
    options,
    zones: results,
    totalReach,
    competitorIdx,
    anchorIdx,
    anchorLabel: rule.label,
    competitorLabel: noun,
    saturation,
  };
}

// Suffix only; callers append it. "facility" is handled by pluralize below.
export function plural(noun: string): string {
  return /(s|x|ch|sh)$/.test(noun) ? 'es' : 's';
}

export function pluralize(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) return noun.slice(0, -1) + 'ies';
  return noun + plural(noun);
}

// Default pick: the best zones until they cover half the reachable addresses, between 2 and 5 zones.
export function defaultSelection(area: TradeArea): Set<string> {
  const picked = new Set<string>();
  let covered = 0;
  for (const z of area.zones) {
    if (picked.size >= 5) break;
    if (picked.size >= 2 && covered >= area.totalReach * 0.5) break;
    picked.add(z.id);
    covered += z.reach;
  }
  return picked;
}

export function summarize(area: TradeArea, selected: Set<string>) {
  const chosen = area.zones.filter((z) => selected.has(z.id));
  const reach = chosen.reduce((s, z) => s + z.reach, 0);
  const competitors = chosen.reduce((s, z) => s + z.competitors, 0);
  return {
    count: chosen.length,
    reach,
    share: area.totalReach ? reach / area.totalReach : 0,
    competitors,
  };
}
