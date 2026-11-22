// Shape of public/data/city.json, produced by scripts/extract.py.
// Columnar arrays keep the file small and fast to parse.

export interface CityFile {
  meta: {
    city: string;
    bbox: [number, number, number, number]; // west, south, east, north
    release: string; // Overture release the extract came from
    generated: string; // ISO date
    zoneKind: 'zip' | 'hex';
    reachSource: 'addresses' | 'buildings';
    synthetic?: boolean; // true only for the local dev fixture
  };
  // id is taxonomy.primary, parent is the next level up, group is the top level
  cats: { id: string; label: string; parent: string; group: string }[];
  brands: string[];
  places: {
    name: string[];
    lat: number[];
    lng: number[];
    cat: number[]; // index into cats
    conf: number[]; // 0..100
    brand: number[]; // index into brands, -1 when none
    addr: string[];
    cell: number[]; // index into cells.id, -1 when outside the grid
  };
  cells: {
    res: number;
    id: string[]; // H3 cell ids
    lat: number[];
    lng: number[];
    reach: number[]; // address points (or buildings) in the cell
    zone: number[]; // index into zones
  };
  zones: { id: string; label: string }[];
}

export interface Subject {
  name: string;
  lat: number;
  lng: number;
  cat: number;
  placeIndex: number; // -1 for a dropped pin
}

export type Priority = 'balanced' | 'reach' | 'gap';
export type Scope = 'same' | 'group';

export interface Options {
  radiusMi: number;
  priority: Priority;
  scope: Scope;
  minConf: number; // 0..100
}

export interface ZoneResult {
  zone: number; // index into zones
  id: string;
  label: string;
  reach: number;
  competitors: number;
  competitorsPer1k: number;
  anchors: number;
  distanceMi: number;
  lat: number;
  lng: number;
  cells: number[]; // cell indexes inside the radius
  parts: { reach: number; gap: number; anchors: number; proximity: number }; // each 0..1
  score: number; // 0..100
  reason: string;
}

export interface TradeArea {
  subject: Subject;
  options: Options;
  zones: ZoneResult[]; // ranked, best first
  totalReach: number;
  competitorIdx: number[]; // place indexes inside the radius
  anchorIdx: number[];
  anchorLabel: string;
  competitorLabel: string;
  saturation: { areaPer10k: number; cityPer10k: number; ratio: number } | null;
}
