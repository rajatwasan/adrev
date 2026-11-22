import type { CityFile } from './types';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim();

export interface Searcher {
  find(query: string, limit?: number): number[];
}

// 40k names fit comfortably in a linear scan, so there is no index to maintain.
// Ranking: name starts with the query, then a word starts with it, then any match.
// Ties go to the listing Overture is more confident in.
export function makeSearcher(city: CityFile): Searcher {
  const names = city.places.name.map(norm);
  const cats = city.cats.map((c) => norm(c.label));
  return {
    find(query, limit = 8) {
      const q = norm(query);
      if (q.length < 2) return [];
      const hits: { i: number; rank: number }[] = [];
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        const at = n.indexOf(q);
        let rank = -1;
        if (at === 0) rank = 0;
        else if (at > 0 && n[at - 1] === ' ') rank = 1;
        else if (at > 0) rank = 2;
        else if (q.length >= 4 && cats[city.places.cat[i]].startsWith(q)) rank = 3;
        if (rank >= 0) hits.push({ i, rank });
      }
      hits.sort((a, b) => a.rank - b.rank || city.places.conf[b.i] - city.places.conf[a.i]);
      return hits.slice(0, limit).map((h) => h.i);
    },
  };
}
