import { describe, expect, it } from 'vitest';
import { channelsFor, transitInPlan, type PlanContext } from '../src/channels';
import { CHANNELS } from '../src/channelData';
import { buildTradeArea } from '../src/score';
import type { CityFile } from '../src/types';

function city(slug: string, country: string): CityFile {
  return {
    meta: { slug, city: slug, country, units: 'mi', bbox: [0, 0, 1, 1], release: 't', generated: 't', zoneKind: 'zip', reachSource: 'addresses' },
    cats: [
      { id: 'dental_clinic', label: 'Dental clinic', parent: 'outpatient_care_facility', group: 'health_care' },
      { id: 'train_station', label: 'Train station', parent: 'rail_facility_or_service', group: 'travel_and_transportation' },
      { id: 'bus_station', label: 'Bus station', parent: 'public_transit_facility_or_service', group: 'travel_and_transportation' },
    ],
    brands: [],
    places: {
      name: ['Me', 'Near Station', 'Far Station', 'Stop A', 'Shaky Station', 'Near Station'],
      lat: [37.77, 37.771, 37.9, 37.77, 37.77, 37.771],
      lng: [-122.42, -122.42, -122.42, -122.42, -122.42, -122.42],
      cat: [0, 1, 1, 2, 1, 1],
      conf: [90, 90, 90, 90, 10, 90],
      brand: [-1, -1, -1, -1, -1, -1],
      addr: ['', '', '', '', '', ''],
      cell: [0, 0, 1, 0, 0, 0],
    },
    cells: { res: 9, id: ['a', 'b'], lat: [37.77, 37.9], lng: [-122.42, -122.42], reach: [1000, 1000], zone: [0, 1] },
    zones: [{ id: '94103', label: '94103' }, { id: '94999', label: '94999' }],
  } as CityFile;
}

describe('transitInPlan', () => {
  const c = city('san-francisco', 'US');
  const area = buildTradeArea(c, { name: 'Me', lat: 37.77, lng: -122.42, cat: 0, placeIndex: 0 }, { radiusMi: 1, priority: 'balanced', scope: 'same', minConf: 50 });

  it('counts only confident stops inside the selected zones and dedupes names', () => {
    const t = transitInPlan(c, area, new Set(['94103']));
    expect(t).toEqual({ rail: 2, bus: 1, nearest: ['Near Station'], railNames: ['Near Station'] });
  });
  it('counts nothing when no zone is selected', () => {
    expect(transitInPlan(c, area, new Set())).toEqual({ rail: 0, bus: 0, nearest: [], railNames: [] });
  });
});

describe('channelsFor', () => {
  it('puts city specific sellers first, then country, then worldwide', () => {
    const ids = channelsFor(city('san-francisco', 'US')).map((x) => x.id);
    expect(ids[0]).toMatch(/^sf-/);
    expect(ids).toContain('us-eddm');
    expect(ids.indexOf('us-eddm')).toBeLessThan(ids.indexOf('meta'));
  });
  it('shows no US only or other city channels abroad', () => {
    const ids = channelsFor(city('tokyo', 'JP')).map((x) => x.id);
    expect(ids).toEqual(['meta', 'google']);
  });
});

describe('channel data', () => {
  it('only names a BART station when Overture labels it BART', () => {
    const bart = CHANNELS.find((x) => x.id === 'sf-bart')!;
    const base = { city: city('san-francisco', 'US'), catId: 'gym', zoneIds: ['94103'], reach: 1 };
    const muniOnly = { rail: 2, bus: 0, nearest: ['Ulloa and 15th Avenue station'], railNames: ['Ulloa and 15th Avenue station'] };
    expect(bart.forPlan!({ ...base, transit: muniOnly })).toBeNull();
    const withBart = { rail: 1, bus: 0, nearest: ['16th St. Mission BART Station'], railNames: ['16th St. Mission BART Station'] };
    expect(bart.forPlan!({ ...base, transit: withBart })).toContain('16th St. Mission BART Station');
  });
  it('gives every channel a seller, an https contact and a source', () => {
    for (const ch of CHANNELS) {
      expect(ch.seller.length, ch.id).toBeGreaterThan(0);
      expect(ch.contactUrl, ch.id).toMatch(/^https:\/\//);
      expect(ch.sources.length, ch.id).toBeGreaterThan(0);
    }
  });
  it('prices a mail drop from the plan at the published postage', () => {
    const eddm = CHANNELS.find((x) => x.id === 'us-eddm')!;
    const ctx: PlanContext = { city: city('san-francisco', 'US'), catId: 'dental_clinic', zoneIds: ['94103'], reach: 10000, transit: { rail: 0, bus: 0, nearest: [], railNames: [] } };
    expect(eddm.forPlan!(ctx)).toContain('$2,600');
  });
});
