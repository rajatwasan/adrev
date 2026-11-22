import {
  AttributionControl,
  Map as GLMap,
  Marker,
  NavigationControl,
  Popup,
  type GeoJSONSource,
  type MapMouseEvent,
  type StyleSpecification,
  setWorkerUrl,
} from 'maplibre-gl';
// MapLibre 6 loads its worker from a URL next to the library. Let Vite bundle it and hand us that URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollection, Point } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { cellToBoundary, cellsToMultiPolygon } from 'h3-js';
import type { CityFile, TradeArea } from './types';

const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';
// If the basemap host is unreachable the data layers still tell the story on a plain canvas.
const PLAIN: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0ee' } }],
};

setWorkerUrl(workerUrl);

const EMPTY = { type: 'FeatureCollection' as const, features: [] };
type FC = FeatureCollection;

export interface MapHandlers {
  onZoneClick(zoneId: string): void;
  onMapClick(lat: number, lng: number): void;
}

export class AreaMap {
  private map: GLMap;
  private ready: Promise<void>;
  private subjectMarker: Marker | null = null;
  private labels: Marker[] = [];
  private popup = new Popup({ closeButton: false, closeOnClick: false, offset: 10 });
  private boundaries = new Map<number, number[][]>();
  pinMode = false;

  constructor(container: HTMLElement, private city: CityFile, private handlers: MapHandlers) {
    const [w, s, e, n] = city.meta.bbox;
    this.map = new GLMap({
      container,
      style: BASEMAP,
      bounds: [w, s, e, n],
      fitBoundsOptions: { padding: 20 },
      attributionControl: false,
      minZoom: 9,
      maxZoom: 17,
    });
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(
      new AttributionControl({
        compact: true,
        customAttribution:
          'Data © <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps Foundation</a>',
      }),
      'bottom-right',
    );

    this.ready = new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.addLayers();
        resolve();
      };
      const fallback = () => {
        if (settled) return;
        this.map.setStyle(PLAIN);
        this.map.once('styledata', done);
      };
      this.map.once('load', done);
      this.map.once('error', fallback);
      setTimeout(fallback, 6000);
    });
  }

  private boundary(cellIndex: number): number[][] {
    let b = this.boundaries.get(cellIndex);
    if (!b) {
      b = cellToBoundary(this.city.cells.id[cellIndex], true);
      this.boundaries.set(cellIndex, b);
    }
    return b;
  }

  private addLayers(): void {
    const m = this.map;
    for (const id of ['cells', 'zones', 'radius', 'anchors', 'competitors']) {
      m.addSource(id, { type: 'geojson', data: EMPTY });
    }
    m.addLayer({
      id: 'cells-fill',
      type: 'fill',
      source: 'cells',
      paint: {
        'fill-color': ['case', ['get', 'sel'], '#0f766e', '#64748b'],
        // Opacity carries address density, color carries the decision.
        'fill-opacity': ['interpolate', ['linear'], ['get', 'dens'], 0, 0.04, 1, ['case', ['get', 'sel'], 0.62, 0.3]],
      },
    });
    m.addLayer({
      id: 'zones-line',
      type: 'line',
      source: 'zones',
      paint: {
        'line-color': ['case', ['get', 'sel'], '#0f766e', '#475569'],
        'line-width': ['case', ['get', 'hover'], 3.5, ['get', 'sel'], 2.2, 1],
        'line-opacity': ['case', ['get', 'sel'], 1, 0.55],
      },
    });
    m.addLayer({
      id: 'radius-line',
      type: 'line',
      source: 'radius',
      paint: { 'line-color': '#0f172a', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.7 },
    });
    m.addLayer({
      id: 'anchors-dot',
      type: 'circle',
      source: 'anchors',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 15, 4.5],
        'circle-color': '#2563eb',
        'circle-opacity': 0.75,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 0.6,
      },
    });
    m.addLayer({
      id: 'competitors-dot',
      type: 'circle',
      source: 'competitors',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 15, 7],
        'circle-color': '#dc2626',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1.2,
      },
    });

    for (const layer of ['competitors-dot', 'anchors-dot']) {
      m.on('mousemove', layer, (e: MapMouseEvent & { features?: any[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        m.getCanvas().style.cursor = 'pointer';
        const p = f.properties as { name: string; cat: string; kind: string };
        const el = document.createElement('div');
        el.className = 'pop';
        const strong = document.createElement('strong');
        strong.textContent = p.name;
        const span = document.createElement('span');
        span.textContent = `${p.kind} · ${p.cat}`;
        el.append(strong, span);
        this.popup.setLngLat((f.geometry as Point).coordinates as [number, number]).setDOMContent(el).addTo(m);
      });
      m.on('mouseleave', layer, () => {
        m.getCanvas().style.cursor = this.pinMode ? 'crosshair' : '';
        this.popup.remove();
      });
    }
    m.on('click', (e: MapMouseEvent) => {
      if (this.pinMode) return this.handlers.onMapClick(e.lngLat.lat, e.lngLat.lng);
      const hit = m.queryRenderedFeatures(e.point, { layers: ['cells-fill'] })[0];
      if (hit?.properties.zone) this.handlers.onZoneClick(String(hit.properties.zone));
    });
  }

  // Swap the city under the map: new grid, new bounds.
  setCity(city: CityFile): void {
    this.city = city;
    this.boundaries.clear();
  }

  setPinMode(on: boolean): void {
    this.pinMode = on;
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  }

  // Start screen: the whole city shaded by address density, so the map says something before a search.
  async showCity(): Promise<void> {
    await this.ready;
    const { cells } = this.city;
    const max = Math.max(1, ...cells.reach);
    for (const id of ['zones', 'radius', 'anchors', 'competitors']) this.set(id, EMPTY);
    this.set('cells', {
      type: 'FeatureCollection',
      features: cells.id.map((_, c) => ({
        type: 'Feature' as const,
        properties: { zone: '', sel: false, dens: Math.sqrt(cells.reach[c] / max) },
        geometry: { type: 'Polygon' as const, coordinates: [this.boundary(c)] },
      })),
    });
    this.subjectMarker?.remove();
    this.subjectMarker = null;
    this.clearLabels();
    const [w, s, e, n] = this.city.meta.bbox;
    this.map.fitBounds([w, s, e, n], { padding: 20, duration: 0 });
  }

  private set(id: string, data: FC): void {
    (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
  }

  private clearLabels(): void {
    this.labels.forEach((l) => l.remove());
    this.labels = [];
  }

  async render(area: TradeArea, selected: Set<string>, hoverId: string | null, refit: boolean): Promise<void> {
    await this.ready;
    const { cells, places, cats } = this.city;
    const maxReach = Math.max(1, ...area.zones.flatMap((z) => z.cells.map((c) => cells.reach[c])));

    this.set('cells', {
      type: 'FeatureCollection',
      features: area.zones.flatMap((z) =>
        z.cells.map((c) => ({
          type: 'Feature' as const,
          properties: { zone: z.id, sel: selected.has(z.id), dens: Math.sqrt(cells.reach[c] / maxReach) },
          geometry: { type: 'Polygon' as const, coordinates: [this.boundary(c)] },
        })),
      ),
    });
    this.set('zones', {
      type: 'FeatureCollection',
      features: area.zones.map((z) => ({
        type: 'Feature' as const,
        properties: { zone: z.id, sel: selected.has(z.id), hover: z.id === hoverId },
        geometry: {
          type: 'MultiPolygon' as const,
          coordinates: cellsToMultiPolygon(z.cells.map((c) => cells.id[c]), true),
        },
      })),
    });
    this.set('radius', circle(area.subject.lat, area.subject.lng, area.options.radiusMi));

    const dots = (idx: number[], kind: string): FC => ({
      type: 'FeatureCollection',
      features: idx.map((p) => ({
        type: 'Feature' as const,
        properties: { name: places.name[p], cat: cats[places.cat[p]].label, kind },
        geometry: { type: 'Point' as const, coordinates: [places.lng[p], places.lat[p]] },
      })),
    });
    this.set('competitors', dots(area.competitorIdx, 'Competitor'));
    this.set('anchors', dots(area.anchorIdx, 'Anchor'));

    this.clearLabels();
    area.zones.forEach((z, rank) => {
      const el = document.createElement('button');
      el.className = `zone-label${selected.has(z.id) ? ' sel' : ''}${z.id === hoverId ? ' hover' : ''}`;
      el.textContent = z.label;
      el.title = `Rank ${rank + 1}. Click to ${selected.has(z.id) ? 'remove' : 'add'}.`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.handlers.onZoneClick(z.id);
      });
      this.labels.push(new Marker({ element: el }).setLngLat([z.lng, z.lat]).addTo(this.map));
    });

    if (!this.subjectMarker) {
      const el = document.createElement('div');
      el.className = 'subject-pin';
      this.subjectMarker = new Marker({ element: el }).setLngLat([area.subject.lng, area.subject.lat]).addTo(this.map);
    }
    this.subjectMarker.setLngLat([area.subject.lng, area.subject.lat]);

    if (refit) {
      const dLat = area.options.radiusMi / 69.0;
      const dLng = dLat / Math.cos((area.subject.lat * Math.PI) / 180);
      const wide = window.matchMedia('(min-width: 861px)').matches;
      this.map.fitBounds(
        [area.subject.lng - dLng, area.subject.lat - dLat, area.subject.lng + dLng, area.subject.lat + dLat],
        { padding: wide ? 50 : 24, duration: 600 },
      );
    }
  }

  resize(): void {
    this.map.resize();
  }
}

function circle(lat: number, lng: number, radiusMi: number): FC {
  const pts: number[][] = [];
  const dLat = radiusMi / 69.0;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i <= 72; i++) {
    const t = (i / 72) * 2 * Math.PI;
    pts.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } }],
  };
}
