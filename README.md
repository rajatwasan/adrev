# Adrev

**Pick a local business in any of 43 cities and Adrev tells you which postal codes around it deserve the ad budget, and why.**

Live app: https://adrev.netlify.app

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
5. Switch to **How to buy it** for the channels that can reach those ZIPs: who sells each one, an
   indicative price, where to ask, and what your plan means for that channel.

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

## From where to how

A ZIP list is only useful if you can buy against it, so the second tab turns the plan into channels:

| Channel | What Adrev adds from the plan |
|---|---|
| Every Door Direct Mail (US) | Postage to mail every address in the selected ZIPs, at the published USPS rate |
| Facebook, Instagram, Google (anywhere) | The ZIP or pin list ready to paste, plus a click cost benchmark for the business type |
| Muni, shelters, BART, Caltrain, billboards (San Francisco) | Rail and bus stops on record inside the selected ZIPs, from Overture places |
| MTA, LA Metro, CTA, TfL | Seller and where to ask |

The seller, price and contact table in [`src/channelData.ts`](src/channelData.ts) is curated by hand and
is **not** Overture data. Every row carries its sources and a basis label: published rate, third party
estimate, or no public rate. Most outdoor and transit sellers publish no rate card, so those prices are
market ranges from third parties and the UI says so. Contact buttons go to the seller's or the transit
agency's official advertising page, not to named sales reps, because people change jobs faster than
pages do.

## The data, as extracted

43 cities on six continents from Overture release 2026-11-18.0, each a fixed box around the urban core.
San Francisco, for scale: 63,828 open places with a name and a category, 383,651 address points,
1,194 hexagon cells, 35 ZIP zones, 5.2 MB of JSON (about 1.2 MB over the wire).

Overture is not equally rich everywhere, and the extract adapts per city instead of pretending it is:

| What the city has | Reach proxy | Zones | Export | Example |
|---|---|---|---|---|
| Addresses with postcodes | Address points | Postal codes | Postal code list | San Francisco, Paris, Sydney |
| No open addresses, places carry postcodes | Building footprints | Postal codes | Postal code list | London, Tokyo, Delhi |
| No usable postcodes | Addresses or buildings | Hexagon areas | Pin, radius | Lagos, Dubai, São Paulo |

Postal codes are cut to the unit ad platforms target: 5 digits in the US, the outward code in the UK
(`SW6`), the forward sortation area in Canada (`M5V`), and so on. Distances read in miles in the US and
UK, kilometres elsewhere. The UI states which reach proxy and which zone type a city is using.

## Stack

- Vite, TypeScript, MapLibre GL, h3-js. No framework and no backend.
- `scripts/extract.py` reads Overture GeoParquet on S3 with DuckDB and writes one JSON file for the city.
- A GitHub Actions workflow extracts all 43 cities in about two minutes, runs the tests, and force pushes
  the files to an orphan `data` branch, so the repo does not grow by 230 MB a month. Netlify pulls that
  branch at build time. A monthly cron picks up each new Overture release.

```
scripts/cities.json       the 43 cities and their bounding boxes
scripts/extract.py        Overture -> public/data/<city>.json + index.json
scripts/make_fixture.mjs  synthetic city file for offline development
src/score.ts              scoring, pure functions
src/search.ts             name search
src/map.ts                map layers
src/channels.ts           transit stops in the plan, channel selection per city
src/channelData.ts        curated sellers, prices, contacts and sources
src/main.ts               UI
tests/score.test.ts       unit tests for the scoring
```

## Run it

```bash
npm install
npm run data     # pulls the current extract from the data branch into public/data
npm run dev
npm test

# refresh the extract yourself (needs network access to Overture's public bucket)
pip install -r scripts/requirements.txt
python scripts/extract.py --all            # or: --only san-francisco,tokyo

# or a synthetic city for offline work; the app shows a banner when it runs on this
npm run fixture
```

Adding a city is one line in `scripts/cities.json`.

## Tradeoffs and cuts

- **A fixed list of cities, not the whole planet on demand.** Overture has 90 million places; a static
  site cannot ship them and a browser cannot query them. Each city is one file that loads in a request
  and cannot go down. True anywhere coverage needs a query service in front of the GeoParquet, which is
  the first thing I would build next. Until then a new city is one line of config.
- **City boxes clip.** A business near the edge of its city's box gets a trade area cut off at the edge.
- **Big cities are heavy.** New York, Paris and London are 16 to 17 MB of JSON each before compression.
  Dropping street addresses from the file or splitting by tile would fix it.
- **Postal codes as the unit.** They are what ad platforms accept, so the output is usable as is. They
  are coarse, and their shapes are approximated by giving each H3 hexagon the most common postcode among
  its points, so edges are rough. Where a city has no usable postcodes the zones are plain hexagon areas
  with numbered labels, which is honest but not pretty; neighbourhood names from Overture's divisions
  theme would be the fix.
- **Addresses stand in for households.** No census join. A tower and a single house can each be one
  address point or many, depending on the source, so reach compares zones within a city and should not be
  compared across cities. Where a city has no address coverage the extract uses building counts and the
  UI says so.
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
- **Channel prices are a snapshot.** Gathered in November 2026, in US dollars, mostly third party ranges.
  Local sellers are curated for San Francisco in depth and four other cities by name only; everywhere
  else shows the channels that work anywhere. A real product would need a maintained rate source.
- **Transit stops are counted, not attributed.** Overture does not record which agency runs a stop, and
  station names are noisy, so the BART and Caltrain cards only name a station when its label says so.
- **Cut:** saved plans and share links, budget split across ZIPs, demographic overlays, multi location
  brands, direct push to ad platform APIs.

## Data and attribution

Places, addresses and buildings © Overture Maps Foundation, [overturemaps.org](https://overturemaps.org).
Basemap by OpenFreeMap, © OpenMapTiles, data from OpenStreetMap.
