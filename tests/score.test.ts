import { describe, expect, it } from 'vitest';
import {
  MIN_ZONE_REACH,
  anchorRule,
  buildTradeArea,
  defaultSelection,
  distanceMi,
  summarize,
} from '../src/score';
import type { CityFile, Options, Subject, TradeArea, ZoneResult } from '../src/types';

// ---- tiny fixture builders ---------------------------------------------------

const LAT = 37.77;
const LNG = -122.42;
const DEG = 0.01; // 0.01 degree of latitude is about 0.69 mi

// cat indexes
const DENTAL = 0;
const PEDIATRIC = 1; // same parent as dental
const SCHOOL = 2; // anchor for dental
const BAR = 3; // neither competitor nor anchor

interface CellSpec {
  dLat: number; // offset from subject in degrees
  dLng?: number;
  reach: number;
  zone: number;
}
interface PlaceSpec {
  cell: number;
  cat: number;
  conf?: number;
}

function makeCity(cellSpecs: CellSpec[], placeSpecs: PlaceSpec[], nZones: number): CityFile {
  return {
    meta: {
      city: 'Testville',
      bbox: [-123, 37, -122, 38],
      release: 'test',
      generated: '2026-01-01',
      zoneKind: 'zip',
      reachSource: 'addresses',
      synthetic: true,
    },
    cats: [
      { id: 'dental_clinic', label: 'Dental Clinic', parent: 'outpatient_care_facility', group: 'health_care' },
      { id: 'pediatric_clinic', label: 'Pediatric Clinic', parent: 'outpatient_care_facility', group: 'health_care' },
      { id: 'elementary_school', label: 'Elementary School', parent: 'educational_institution', group: 'education' },
      { id: 'bar', label: 'Bar', parent: 'alcoholic_beverage_venue', group: 'food_and_drink' },
    ],
    brands: [],
    places: {
      name: placeSpecs.map((_, i) => `P${i}`),
      lat: placeSpecs.map((p) => LAT + cellSpecs[p.cell].dLat),
      lng: placeSpecs.map((p) => LNG + (cellSpecs[p.cell].dLng ?? 0)),
      cat: placeSpecs.map((p) => p.cat),
      conf: placeSpecs.map((p) => p.conf ?? 90),
      brand: placeSpecs.map(() => -1),
      addr: placeSpecs.map(() => '1 Test St, Testville'),
      cell: placeSpecs.map((p) => p.cell),
    },
    cells: {
      res: 9,
      id: cellSpecs.map((_, i) => `cell${i}`),
      lat: cellSpecs.map((c) => LAT + c.dLat),
      lng: cellSpecs.map((c) => LNG + (c.dLng ?? 0)),
      reach: cellSpecs.map((c) => c.reach),
      zone: cellSpecs.map((c) => c.zone),
    },
    zones: Array.from({ length: nZones }, (_, i) => ({ id: `9400${i}`, label: `9400${i}` })),
  };
}

const subject: Subject = { name: 'Subject Dental', lat: LAT, lng: LNG, cat: DENTAL, placeIndex: -1 };
const opts = (o: Partial<Options> = {}): Options => ({
  radiusMi: 2,
  priority: 'balanced',
  scope: 'same',
  minConf: 0,
  ...o,
});

// Zone 0 sits 0.01 deg north, zone 1 sits 0.01 deg south: identical distance from the subject.
const NORTH = { dLat: DEG };
const SOUTH = { dLat: -DEG };
// 0.1 deg of latitude is about 6.9 mi, well outside a 2 mi radius.
const FAR = { dLat: 0.1 };

// ---- distanceMi --------------------------------------------------------------

describe('distanceMi', () => {
  it('is zero for identical points', () => {
    expect(distanceMi(37.77, -122.42, 37.77, -122.42)).toBe(0);
  });

  it('measures one degree of latitude as about 69.1 miles (within 0.5%)', () => {
    const d = distanceMi(37, -122, 38, -122);
    expect(Math.abs(d - 69.1) / 69.1).toBeLessThan(0.005);
  });

  it('is symmetric', () => {
    const a = distanceMi(37.7, -122.5, 37.8, -122.4);
    const b = distanceMi(37.8, -122.4, 37.7, -122.5);
    expect(a).toBeCloseTo(b, 10);
  });

  it('shrinks east to west distance by cos(latitude)', () => {
    const d = distanceMi(60, 0, 60, 1);
    expect(d).toBeCloseTo(69.09 * 0.5, 1);
  });
});

// ---- buildTradeArea ----------------------------------------------------------

describe('buildTradeArea', () => {
  it('excludes cells outside the radius, along with their places', () => {
    const city = makeCity(
      [
        { ...NORTH, reach: 200, zone: 0 },
        { ...FAR, reach: 800, zone: 1 },
      ],
      [
        { cell: 0, cat: DENTAL },
        { cell: 1, cat: DENTAL },
      ],
      2,
    );
    const area = buildTradeArea(city, subject, opts());
    expect(area.zones.map((z) => z.zone)).toEqual([0]);
    expect(area.totalReach).toBe(200);
    expect(area.competitorIdx).toEqual([0]);
  });

  it('drops zones under MIN_ZONE_REACH and keeps zones exactly at it', () => {
    const city = makeCity(
      [
        { ...NORTH, reach: MIN_ZONE_REACH - 1, zone: 0 },
        { ...SOUTH, reach: MIN_ZONE_REACH, zone: 1 },
      ],
      [],
      2,
    );
    const area = buildTradeArea(city, subject, opts());
    expect(area.zones.map((z) => z.zone)).toEqual([1]);
    expect(area.totalReach).toBe(MIN_ZONE_REACH);
  });

  it('sums reach across the cells of one zone', () => {
    const city = makeCity(
      [
        { ...NORTH, reach: 100, zone: 0 },
        { ...SOUTH, reach: 120, zone: 0 },
      ],
      [],
      1,
    );
    const area = buildTradeArea(city, subject, opts());
    expect(area.zones).toHaveLength(1);
    expect(area.zones[0].reach).toBe(220);
    expect(area.zones[0].cells).toEqual([0, 1]);
  });

  describe('competitor counting', () => {
    // zone 0 (reach 200): two dental (idx 0,1), one pediatric (2), the subject's own record (3),
    // one low confidence dental (4), one bar (5)
    const specs: PlaceSpec[] = [
      { cell: 0, cat: DENTAL, conf: 90 },
      { cell: 0, cat: DENTAL, conf: 80 },
      { cell: 0, cat: PEDIATRIC, conf: 90 },
      { cell: 0, cat: DENTAL, conf: 95 }, // the subject itself
      { cell: 0, cat: DENTAL, conf: 30 },
      { cell: 0, cat: BAR, conf: 90 },
    ];
    const city = makeCity([{ ...NORTH, reach: 200, zone: 0 }], specs, 1);
    const own: Subject = { ...subject, placeIndex: 3 };

    it("scope 'same' counts only the same category, excluding the subject's own record", () => {
      const area = buildTradeArea(city, own, opts({ scope: 'same' }));
      expect(area.competitorIdx.sort()).toEqual([0, 1, 4]);
      expect(area.zones[0].competitors).toBe(3);
    });

    it("scope 'group' counts every category sharing the parent", () => {
      const area = buildTradeArea(city, own, opts({ scope: 'group' }));
      expect(area.competitorIdx.sort()).toEqual([0, 1, 2, 4]);
      expect(area.zones[0].competitors).toBe(4);
    });

    it('does not exclude anything when placeIndex is -1', () => {
      const area = buildTradeArea(city, subject, opts({ scope: 'same' }));
      expect(area.zones[0].competitors).toBe(4);
    });

    it('respects minConf', () => {
      const area = buildTradeArea(city, own, opts({ scope: 'same', minConf: 50 }));
      expect(area.competitorIdx.sort()).toEqual([0, 1]);
      expect(area.zones[0].competitors).toBe(2);
    });

    it('computes competitorsPer1k as competitors / reach * 1000', () => {
      const area = buildTradeArea(city, own, opts({ scope: 'same', minConf: 50 }));
      expect(area.zones[0].competitorsPer1k).toBeCloseTo((2 / 200) * 1000, 10);
      expect(area.zones[0].competitorsPer1k).toBeCloseTo(10, 10);
    });

    it('does not count bars as competitors', () => {
      const area = buildTradeArea(city, own, opts({ scope: 'group' }));
      expect(area.competitorIdx).not.toContain(5);
    });
  });

  it('counts anchors by rule and reports them per zone', () => {
    const city = makeCity(
      [{ ...NORTH, reach: 200, zone: 0 }],
      [
        { cell: 0, cat: SCHOOL },
        { cell: 0, cat: SCHOOL },
        { cell: 0, cat: BAR },
      ],
      1,
    );
    const area = buildTradeArea(city, subject, opts());
    expect(area.zones[0].anchors).toBe(2);
    expect(area.anchorIdx).toEqual([0, 1]);
    expect(area.anchorLabel).toContain('schools');
  });

  it('ranks zones best first with scores in 0..100', () => {
    const city = makeCity(
      [
        { ...NORTH, reach: 300, zone: 0 },
        { ...SOUTH, reach: 200, zone: 1 },
        { dLat: 0.02, reach: 400, zone: 2 },
        { dLat: -0.02, reach: 160, zone: 3 },
      ],
      [
        { cell: 0, cat: DENTAL },
        { cell: 1, cat: DENTAL },
        { cell: 1, cat: DENTAL },
        { cell: 2, cat: SCHOOL },
        { cell: 3, cat: DENTAL },
      ],
      4,
    );
    for (const priority of ['balanced', 'reach', 'gap'] as const) {
      const area = buildTradeArea(city, subject, opts({ priority }));
      expect(area.zones).toHaveLength(4);
      for (let i = 1; i < area.zones.length; i++) {
        expect(area.zones[i - 1].score).toBeGreaterThanOrEqual(area.zones[i].score);
      }
      for (const z of area.zones) {
        expect(z.score).toBeGreaterThanOrEqual(0);
        expect(z.score).toBeLessThanOrEqual(100);
        for (const v of Object.values(z.parts)) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("with 'gap' priority, fewer competitors per address outranks an otherwise equal zone", () => {
    // equal reach, equal distance, no anchors; zone 1 has two competitors, zone 0 has none
    const city = makeCity(
      [
        { ...NORTH, reach: 200, zone: 0 },
        { ...SOUTH, reach: 200, zone: 1 },
      ],
      [
        { cell: 1, cat: DENTAL },
        { cell: 1, cat: DENTAL },
      ],
      2,
    );
    const area = buildTradeArea(city, subject, opts({ priority: 'gap' }));
    expect(area.zones.map((z) => z.zone)).toEqual([0, 1]);
    expect(area.zones[0].score).toBeGreaterThan(area.zones[1].score);
    expect(area.zones[0].parts.gap).toBe(1);
    expect(area.zones[1].parts.gap).toBe(0);
  });

  it("with 'reach' priority, more addresses outranks an otherwise equal zone", () => {
    // no competitors, no anchors, equal distance; zone 1 has the larger reach
    const city = makeCity(
      [
        { ...NORTH, reach: 200, zone: 0 },
        { ...SOUTH, reach: 300, zone: 1 },
      ],
      [],
      2,
    );
    const area = buildTradeArea(city, subject, opts({ priority: 'reach' }));
    expect(area.zones.map((z) => z.zone)).toEqual([1, 0]);
    expect(area.zones[0].score).toBeGreaterThan(area.zones[1].score);
  });

  it('computes saturation.ratio as area rate over city rate', () => {
    // area: zone 0 (200) + zone 1 (200) = 400 reach, 2 competitors -> 50 per 10k
    // city: plus a far cell with 600 reach and 8 competitors -> 10 competitors / 1000 reach = 100 per 10k
    const city = makeCity(
      [
        { ...NORTH, reach: 200, zone: 0 },
        { ...SOUTH, reach: 200, zone: 1 },
        { ...FAR, reach: 600, zone: 2 },
      ],
      [
        { cell: 0, cat: DENTAL },
        { cell: 0, cat: DENTAL },
        ...Array.from({ length: 8 }, () => ({ cell: 2, cat: DENTAL })),
      ],
      3,
    );
    const area = buildTradeArea(city, subject, opts());
    expect(area.totalReach).toBe(400);
    expect(area.saturation).not.toBeNull();
    expect(area.saturation!.areaPer10k).toBeCloseTo(50, 10);
    expect(area.saturation!.cityPer10k).toBeCloseTo(100, 10);
    expect(area.saturation!.ratio).toBeCloseTo(0.5, 10);
  });

  it('returns null saturation when the city has no competitors', () => {
    const city = makeCity([{ ...NORTH, reach: 200, zone: 0 }], [{ cell: 0, cat: BAR }], 1);
    expect(buildTradeArea(city, subject, opts()).saturation).toBeNull();
  });

  it('does not produce NaN with a single candidate zone', () => {
    const city = makeCity([{ ...NORTH, reach: 200, zone: 0 }], [{ cell: 0, cat: DENTAL }], 1);
    const area = buildTradeArea(city, subject, opts());
    expect(area.zones).toHaveLength(1);
    const z = area.zones[0];
    expect(Number.isFinite(z.score)).toBe(true);
    expect(z.score).toBeGreaterThanOrEqual(0);
    expect(z.score).toBeLessThanOrEqual(100);
    for (const v of Object.values(z.parts)) expect(Number.isNaN(v)).toBe(false);
    expect(z.reason).not.toContain('NaN');
  });

  it('handles an empty trade area without NaN', () => {
    const city = makeCity([{ ...FAR, reach: 500, zone: 0 }], [], 1);
    const area = buildTradeArea(city, subject, opts());
    expect(area.zones).toEqual([]);
    expect(area.totalReach).toBe(0);
    expect(area.saturation).toBeNull();
  });

  // Suspected bug: competitors in zones that were dropped for low reach still feed
  // competitorIdx, so the saturation numerator includes them while the denominator
  // (totalReach) only covers the kept zones. Expected behavior here: 2 competitors over 200 reach.
  it('computes saturation over every address in the circle, thin zones included', () => {
    const city = makeCity(
      [
        { ...NORTH, reach: 200, zone: 0 },
        { ...SOUTH, reach: 10, zone: 1 }, // dropped: under MIN_ZONE_REACH
        { ...FAR, reach: 790, zone: 2 },
      ],
      [
        { cell: 0, cat: DENTAL },
        { cell: 0, cat: DENTAL },
        { cell: 1, cat: DENTAL },
        { cell: 1, cat: DENTAL },
        { cell: 1, cat: DENTAL },
        { cell: 2, cat: DENTAL },
      ],
      3,
    );
    const area = buildTradeArea(city, subject, opts());
    expect(area.totalReach).toBe(200);
    // 5 competitors and 210 addresses sit inside the radius; the 10 address zone is unranked but still counted.
    expect(area.saturation!.areaPer10k).toBeCloseTo((5 / 210) * 10000, 10);
  });
});

// ---- anchorRule --------------------------------------------------------------

describe('anchorRule', () => {
  it('gives dental_clinic the schools and childcare rule', () => {
    const rule = anchorRule('dental_clinic');
    expect(rule.label).toContain('schools, childcare');
    expect(rule.anchors.test('elementary_school')).toBe(true);
    expect(rule.anchors.test('pharmacy')).toBe(true);
    expect(rule.anchors.test('bar')).toBe(false);
  });

  it('gives an unknown category the default rule', () => {
    const rule = anchorRule('locksmith');
    expect(rule.label).toBe('grocery stores, schools, gyms, coffee shops and pharmacies');
    expect(rule.anchors.test('coffee_shop')).toBe(true);
    expect(rule.anchors.test('bar')).toBe(false);
  });

  it('picks different rules for different industries', () => {
    expect(anchorRule('gym').label).toContain('coffee shops');
    expect(anchorRule('restaurant').label).toContain('gyms, theaters');
    expect(anchorRule('veterinarian').label).toContain('parks, pet stores');
  });
});

// ---- defaultSelection and summarize -------------------------------------------

function fakeArea(reaches: number[], competitors: number[] = []): TradeArea {
  const zones = reaches.map(
    (reach, i) =>
      ({
        zone: i,
        id: `z${i}`,
        label: `z${i}`,
        reach,
        competitors: competitors[i] ?? 0,
      }) as ZoneResult,
  );
  return {
    subject,
    options: opts(),
    zones,
    totalReach: reaches.reduce((s, r) => s + r, 0),
    competitorIdx: [],
    anchorIdx: [],
    anchorLabel: '',
    competitorLabel: '',
    saturation: null,
  };
}

describe('defaultSelection', () => {
  it('picks at least 2 zones even when the first already covers half', () => {
    const sel = defaultSelection(fakeArea([900, 50, 50]));
    expect([...sel]).toEqual(['z0', 'z1']);
  });

  it('picks all zones when fewer than 2 exist', () => {
    expect(defaultSelection(fakeArea([500])).size).toBe(1);
    expect(defaultSelection(fakeArea([])).size).toBe(0);
  });

  it('picks at most 5 zones', () => {
    const sel = defaultSelection(fakeArea(Array(20).fill(100)));
    expect(sel.size).toBe(5);
  });

  it('stops once half of total reach is covered', () => {
    // 200 each, total 1000: 2 zones cover 400 (<500), the third reaches 600, then stop
    const sel = defaultSelection(fakeArea([200, 200, 200, 200, 200]));
    expect([...sel]).toEqual(['z0', 'z1', 'z2']);
  });

  it('stops right at half when the second zone lands exactly on 50%', () => {
    const sel = defaultSelection(fakeArea([300, 200, 250, 250]));
    expect([...sel]).toEqual(['z0', 'z1']);
  });
});

describe('summarize', () => {
  const area = fakeArea([400, 300, 200, 100], [4, 3, 2, 1]);

  it('totals count, reach, share and competitors for the selection', () => {
    const s = summarize(area, new Set(['z0', 'z2']));
    expect(s.count).toBe(2);
    expect(s.reach).toBe(600);
    expect(s.share).toBeCloseTo(0.6, 10);
    expect(s.competitors).toBe(6);
  });

  it('returns zeros for an empty selection', () => {
    expect(summarize(area, new Set())).toEqual({ count: 0, reach: 0, share: 0, competitors: 0 });
  });

  it('ignores selected ids that are not in the area', () => {
    expect(summarize(area, new Set(['nope'])).count).toBe(0);
  });

  it('reports share 0 when total reach is 0', () => {
    expect(summarize(fakeArea([]), new Set(['z0'])).share).toBe(0);
  });
});

describe('anchorRule ordering', () => {
  it('sends veterinary categories to the pet rule, not the clinic rule', () => {
    expect(anchorRule('veterinary_clinic').label).toContain('pet stores');
    expect(anchorRule('veterinarian').label).toContain('pet stores');
  });
  it('does not mistake student housing for a dentist or a steakhouse for tea', () => {
    expect(anchorRule('student_housing').label).toContain('grocery stores, schools');
    expect(anchorRule('steakhouse').label).toContain('gyms, theaters');
  });
});

describe('similar scope on real taxonomy shapes', () => {
  it('treats parent, sibling and child categories as competitors', () => {
    const cats = [
      { id: 'restaurant', label: 'Restaurant', parent: 'food_and_drink', group: 'food_and_drink' },
      { id: 'sushi_restaurant', label: 'Sushi restaurant', parent: 'restaurant', group: 'food_and_drink' },
      { id: 'italian_restaurant', label: 'Italian restaurant', parent: 'restaurant', group: 'food_and_drink' },
      { id: 'bank', label: 'Bank', parent: 'bank_or_credit_union', group: 'services_and_business' },
    ];
    const city = {
      meta: { city: 't', bbox: [0, 0, 1, 1], release: 't', generated: 't', zoneKind: 'zip', reachSource: 'addresses' },
      cats,
      brands: [],
      places: {
        name: ['me', 'plain', 'italian', 'bank'],
        lat: [37.77, 37.77, 37.77, 37.77],
        lng: [-122.42, -122.42, -122.42, -122.42],
        cat: [1, 0, 2, 3],
        conf: [90, 90, 90, 90],
        brand: [-1, -1, -1, -1],
        addr: ['', '', '', ''],
        cell: [0, 0, 0, 0],
      },
      cells: { res: 9, id: ['x'], lat: [37.77], lng: [-122.42], reach: [1000], zone: [0] },
      zones: [{ id: '94103', label: '94103' }],
    } as unknown as CityFile;
    const subject = { name: 'me', lat: 37.77, lng: -122.42, cat: 1, placeIndex: 0 };
    const base = { radiusMi: 1, priority: 'balanced' as const, minConf: 50 };
    expect(buildTradeArea(city, subject, { ...base, scope: 'same' }).competitorIdx).toEqual([]);
    expect(buildTradeArea(city, subject, { ...base, scope: 'group' }).competitorIdx).toEqual([1, 2]);
    const generic = { ...subject, cat: 0, placeIndex: 1 };
    expect(buildTradeArea(city, generic, { ...base, scope: 'group' }).competitorIdx).toEqual([0, 2]);
  });
});
