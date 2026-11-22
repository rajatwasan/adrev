# Adrev

**Pick a local business and Adrev tells you which ZIP codes around it deserve the ad budget, and why.**

Live app: _add the deployed URL here_

## Why this

Anyone running a local campaign has to answer one question before spending a dollar: where do I aim it?
The usual answer is a radius drawn by eye on a map. That wastes money in two ways. It pays to reach blocks
where three competitors already sit, and it treats a park and an apartment district as equal.

Overture has the three things needed to do better, all open and all in one schema:

| Signal | Overture theme | Used for |
|---|---|---|
| Who competes | `places` (taxonomy, confidence, operating status) | Competitors per ZIP |
| Who can be reached | `addresses` (points and postcodes) | Address counts as a household proxy, and the ZIP zones |
| What pulls customers | `places` again | Anchors, such as schools near a dentist |

I picked it because the output is a decision, not a map. The last screen is a list you paste into
location targeting in Meta Ads or Google Ads.

## How it works

1. Search for a business by name, or pick a business type and drop a pin for a location you are considering.
2. Adrev draws the reach radius and ranks every ZIP code inside it.
3. Each ZIP shows its score, the four parts behind it, and one plain sentence of evidence.
4. Tick the ZIPs you want. Copy the list or download the CSV.

The score is a weighted sum of four parts, each scaled 0 to 1 across the ZIPs in range:

| Part | Meaning | Balanced weight |
|---|---|---|
| Reach | Address points inside the radius | 35% |
| Open ground | Fewer competitors per 1,000 addresses | 30% |
| Anchors | Complementary places nearby | 15% |
| Proximity | Closer to the business | 20% |

The priority switch moves weight toward reach or toward open ground. The whole model is one table in
[`src/score.ts`](src/score.ts). There is no machine learning here on purpose: a media buyer has to defend
the plan to a client, so every number needs to be traceable.

The banner above the list compares competitor density in the radius with the citywide rate, which tells
you whether to chase gaps or chase reach.

## The data, as extracted

San Francisco from Overture release 2026-11-18.0: 65,382 open places with a name and a category,
383,651 address points, 1,196 hexagon cells, 35 ZIP zones. One JSON file, about 1.2 MB over the wire.

## Stack

- Vite, TypeScript, MapLibre GL, h3-js. No framework and no backend.
- `scripts/extract.py` reads Overture GeoParquet on S3 with DuckDB and writes one JSON file for the city.
- A GitHub Actions workflow runs the extract and the tests, then commits `public/data/city.json`.
  A monthly cron picks up each new Overture release. Netlify builds and deploys on every push.

```
scripts/extract.py        Overture -> public/data/city.json
scripts/make_fixture.mjs  synthetic city file for offline development
src/score.ts              scoring, pure functions
src/search.ts             name search
src/map.ts                map layers
src/main.ts               UI
tests/score.test.ts       unit tests for the scoring
```

## Run it

```bash
npm install

npm run dev      # uses the committed extract in public/data/city.json
npm test

# refresh the extract yourself (needs network access to Overture's public bucket)
pip install -r scripts/requirements.txt
python scripts/extract.py

# or a synthetic city for offline work; the app shows a banner when it runs on this.
# It overwrites city.json, so do not commit the result.
npm run fixture
```

Another city: `python scripts/extract.py --city Oakland --bbox -122.36,37.70,-122.11,37.89`

## Tradeoffs and cuts

- **One city, extracted ahead of time.** A static file loads in one request and cannot go down. The cost
  is that adding a city means running the script again. The script takes a bounding box, so that is one
  command.
- **ZIP codes as the unit.** They are what ad platforms accept, so the output is usable as is. They are
  coarse. ZIP shapes are approximated by assigning each H3 hexagon to the most common postcode among its
  address points, so the edges are rough. If a city has no postcode coverage the extract falls back to
  hexagon zones and the export switches to pin and radius.
- **Addresses stand in for households.** No census join. A tower and a single house can each be one
  address point or many, depending on the source. If a city has no address coverage the extract falls back
  to building counts and the UI says so.
- **Straight line radius, not drive time.** Overture's transportation theme could support isochrones.
  That needs a routing engine and a backend, which did not earn its place in a first version.
- **Anchors are a small hand written table.** Six rules keyed on taxonomy ids, with a general default.
  Easy to read, easy to be wrong about a niche category.
- **Competitors follow Overture's taxonomy, which is uneven.** Rivals are a subtree: a general dentistry
  practice competes with everything filed under dental clinic. But in the San Francisco extract about
  1,600 listings carry only the top level `health_care` label, and some of those are dentists. They are
  invisible as competitors. The switch between the narrow and the wider subtree is the manual override.
- **Listings under 50% confidence are ignored.** Overture's confidence score filters places that may not
  exist. A missing competitor still means "none on record", and the copy says exactly that.
- **Cut:** saved plans and share links, budget split across ZIPs, demographic overlays, multi location
  brands, direct push to ad platform APIs.

## Data and attribution

Places, addresses and buildings © Overture Maps Foundation, [overturemaps.org](https://overturemaps.org).
Basemap by OpenFreeMap, © OpenMapTiles, data from OpenStreetMap.
