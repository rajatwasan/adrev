import type { CityFile, TradeArea } from './types';
import { distanceMi } from './score';
import { CHANNELS, type Channel } from './channelData';

// What a channel card needs to know about the plan on screen.
export interface PlanContext {
  city: CityFile;
  catId: string; // the subject's Overture category
  zoneIds: string[]; // selected zones
  reach: number; // address points (or buildings) in the selected zones
  // rail and bus stops inside the selected zones; nearest = closest rail stops, railNames = all of them
  transit: { rail: number; bus: number; nearest: string[]; railNames: string[] };
}

const RAIL = /^(train_station|light_rail_and_subway_station|metro_station|subway_station|tram_stop)$/;
const BUS = /^(bus_station|bus_stop)$/;

// Transit stops inside the selected zones, straight from Overture places.
// This is what makes a transit buy concrete: which stations sit in the area you are paying to reach.
export function transitInPlan(city: CityFile, area: TradeArea, selected: Set<string>) {
  const { places, cats } = city;
  const cellsInPlan = new Set<number>();
  for (const z of area.zones) if (selected.has(z.id)) for (const c of z.cells) cellsInPlan.add(c);
  const kind = cats.map((c) => (RAIL.test(c.id) || c.parent === 'rail_facility_or_service' ? 1 : BUS.test(c.id) ? 2 : 0));
  let rail = 0;
  let bus = 0;
  const railStops: { name: string; d: number }[] = [];
  for (let p = 0; p < places.cat.length; p++) {
    const k = kind[places.cat[p]];
    if (!k || places.conf[p] < area.options.minConf || !cellsInPlan.has(places.cell[p])) continue;
    if (k === 2) {
      bus++;
      continue;
    }
    rail++;
    railStops.push({
      name: places.name[p],
      d: distanceMi(area.subject.lat, area.subject.lng, places.lat[p], places.lng[p]),
    });
  }
  railStops.sort((a, b) => a.d - b.d);
  const railNames = [...new Set(railStops.map((s) => s.name))];
  return { rail, bus, nearest: railNames.slice(0, 3), railNames };
}

// Channels that apply to this city: worldwide ones, country ones, then city specific ones.
export function channelsFor(city: CityFile): Channel[] {
  const slug = city.meta.slug ?? '';
  const country = city.meta.country ?? 'US';
  const rank = (c: Channel) => (c.regions.includes(slug) ? 0 : c.regions.includes(country) ? 1 : 2);
  return CHANNELS.filter((c) => c.regions.includes('*') || c.regions.includes(country) || c.regions.includes(slug)).sort(
    (a, b) => rank(a) - rank(b),
  );
}

export const usd = (n: number) =>
  n >= 1000 ? `$${Math.round(n / 100) / 10}k`.replace('.0k', 'k') : `$${Math.round(n).toLocaleString('en-US')}`;
