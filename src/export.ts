import type { CityFile, TradeArea, ZoneResult } from './types';

// Rough radius that covers a hex zone, used only when the city has no ZIP data.
const HEX_ZONE_RADIUS_MI = 1;

function chosen(area: TradeArea, selected: Set<string>): ZoneResult[] {
  return area.zones.filter((z) => selected.has(z.id));
}

// What a media buyer pastes into a location targeting box: one ZIP per line,
// or pin drops (lat, lng, radius) when the city has no ZIP zones.
export function targetingList(city: CityFile, area: TradeArea, selected: Set<string>): string {
  const zones = chosen(area, selected);
  if (city.meta.zoneKind === 'zip') return zones.map((z) => z.id).join('\n');
  return zones.map((z) => `${z.lat.toFixed(5)}, ${z.lng.toFixed(5)}, ${HEX_ZONE_RADIUS_MI} mi`).join('\n');
}

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(city: CityFile, area: TradeArea, selected: Set<string>): string {
  const head = [
    'zone',
    'selected',
    'score',
    'addresses',
    'competitors',
    'competitors_per_1k_addresses',
    'anchors',
    'distance_mi',
    'center_lat',
    'center_lng',
    'why',
  ];
  const rows = area.zones.map((z) => [
    z.label,
    selected.has(z.id) ? 'yes' : 'no',
    z.score.toFixed(0),
    z.reach,
    z.competitors,
    z.competitorsPer1k.toFixed(2),
    z.anchors,
    z.distanceMi.toFixed(2),
    z.lat.toFixed(5),
    z.lng.toFixed(5),
    z.reason,
  ]);
  const note = [
    `# Adrev plan for ${area.subject.name}`,
    `# ${area.options.radiusMi} mi radius, priority ${area.options.priority}, Overture release ${city.meta.release}`,
  ];
  return [...note, head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';
}

export function download(filename: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be blocked (insecure origin, permissions). Fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
