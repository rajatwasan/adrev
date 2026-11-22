#!/usr/bin/env python3
"""Extract one city from Overture Maps into public/data/city.json.

Reads the cloud hosted GeoParquet directly with DuckDB (no account, no key):
  places     -> businesses with a name, a category and a confidence score
  addresses  -> address points, the reach proxy, plus their ZIP codes
  buildings  -> fallback reach proxy if the city has no address coverage

Usage:
  pip install duckdb h3
  python scripts/extract.py                 # latest release, San Francisco
  OVERTURE_RELEASE=2026-11-18.0 python scripts/extract.py
  python scripts/extract.py --city "Oakland" --bbox -122.36,37.70,-122.11,37.89
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

import h3

STAC = "https://stac.overturemaps.org/catalog.json"
BUCKET = "s3://overturemaps-us-west-2/release"
SF_BBOX = (-122.5155, 37.7045, -122.3550, 37.8350)  # west, south, east, north
H3_RES = 9  # about 0.1 square km per cell, roughly a city block or two
MIN_CONFIDENCE = 0.4  # Overture's existence score; below this a listing is a coin flip
MIN_ADDRESSES = 20_000  # fewer than this and we treat address coverage as missing
MIN_ZIP_SHARE = 0.7  # share of cells that must resolve to a ZIP before we trust ZIP zones


def latest_release() -> str:
    if os.environ.get("OVERTURE_RELEASE"):
        return os.environ["OVERTURE_RELEASE"]
    with urllib.request.urlopen(STAC, timeout=30) as r:
        return json.load(r)["latest"]


def fetch(release: str, bbox):
    """Three bbox queries. Points use bbox.xmin/ymin as lng/lat, so no spatial extension is needed."""
    import duckdb

    w, s, e, n = bbox
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    where = f"bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}"

    def src(theme, typ):
        return f"read_parquet('{BUCKET}/{release}/theme={theme}/type={typ}/*', hive_partitioning=1)"

    places = con.execute(
        f"""
        SELECT names.primary, bbox.xmin, bbox.ymin, taxonomy.primary, taxonomy.hierarchy,
               confidence, brand.names.primary, addresses[1].freeform, addresses[1].postcode
        FROM {src('places', 'place')}
        WHERE {where}
          AND names.primary IS NOT NULL
          AND taxonomy.primary IS NOT NULL
          AND confidence >= {MIN_CONFIDENCE}
          AND coalesce(operating_status, 'open') = 'open'
        """
    ).fetchall()
    print(f"places: {len(places):,}", file=sys.stderr)

    addresses = con.execute(
        f"SELECT bbox.xmin, bbox.ymin, postcode FROM {src('addresses', 'address')} WHERE {where}"
    ).fetchall()
    print(f"addresses: {len(addresses):,}", file=sys.stderr)

    buildings = []
    if len(addresses) < MIN_ADDRESSES:
        buildings = con.execute(
            f"""SELECT (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
                FROM {src('buildings', 'building')} WHERE {where}"""
        ).fetchall()
        print(f"buildings (fallback): {len(buildings):,}", file=sys.stderr)
    return places, addresses, buildings


def zip5(value) -> str | None:
    if not value:
        return None
    digits = str(value).strip()[:5]
    return digits if len(digits) == 5 and digits.isdigit() else None


def label(cat_id: str) -> str:
    return cat_id.replace("_", " ").capitalize()


def build(city: str, bbox, release: str, places, addresses, buildings) -> dict:
    """Pure transform from query rows to the city file. Kept separate so it can be tested offline."""
    cell_of = lambda lat, lng: h3.latlng_to_cell(lat, lng, H3_RES)

    use_addresses = len(addresses) >= MIN_ADDRESSES
    reach: Counter = Counter()
    zip_votes: dict[str, Counter] = defaultdict(Counter)
    if use_addresses:
        for lng, lat, postcode in addresses:
            c = cell_of(lat, lng)
            reach[c] += 1
            z = zip5(postcode)
            if z:
                zip_votes[c][z] += 1
    else:
        for lng, lat in buildings:
            reach[cell_of(lat, lng)] += 1

    # Places: dedupe categories and brands into lookup tables.
    cats: dict[str, int] = {}
    cat_rows: list[dict] = []
    brands: dict[str, int] = {}
    cols = {k: [] for k in ("name", "lat", "lng", "cat", "conf", "brand", "addr", "cell")}
    place_cells: list[str] = []
    place_zip_votes: dict[str, Counter] = defaultdict(Counter)
    for name, lng, lat, primary, hierarchy, conf, brand, freeform, postcode in places:
        hierarchy = list(hierarchy or [primary])
        if primary not in cats:
            cats[primary] = len(cat_rows)
            cat_rows.append(
                {
                    "id": primary,
                    "label": label(primary),
                    "parent": hierarchy[-2] if len(hierarchy) > 1 else primary,
                    "group": hierarchy[0],
                    "path": hierarchy,
                }
            )
        b = -1
        if brand:
            b = brands.setdefault(brand, len(brands))
        c = cell_of(lat, lng)
        place_cells.append(c)
        z = zip5(postcode)
        if z:
            place_zip_votes[c][z] += 1
        cols["name"].append(name.strip())
        cols["lat"].append(round(lat, 5))
        cols["lng"].append(round(lng, 5))
        cols["cat"].append(cats[primary])
        cols["conf"].append(round(conf * 100))
        cols["brand"].append(b)
        cols["addr"].append((freeform or "").strip())

    # Grid = every cell that has reach or a place.
    cell_ids = sorted(set(reach) | set(place_cells))
    index = {c: i for i, c in enumerate(cell_ids)}
    cols["cell"] = [index[c] for c in place_cells]

    # Zones. Prefer ZIP codes from address points, then from places in the cell,
    # then borrow from the nearest cell that has one.
    zone_of: dict[str, str] = {}
    for c in cell_ids:
        votes = zip_votes.get(c) or place_zip_votes.get(c)
        if votes:
            zone_of[c] = votes.most_common(1)[0][0]
    zip_share = len(zone_of) / max(1, len(cell_ids))
    zone_kind = "zip" if zip_share >= MIN_ZIP_SHARE else "hex"
    if zone_kind == "zip":
        seeded = dict(zone_of)
        for c in cell_ids:
            if c in zone_of:
                continue
            for k in range(1, 8):
                near = Counter(seeded[n] for n in h3.grid_ring(c, k) if n in seeded)
                if near:
                    zone_of[c] = near.most_common(1)[0][0]
                    break
    else:
        # No usable ZIP data: fall back to coarse hexagons, about 5 square km each.
        zone_of = {c: h3.cell_to_parent(c, 7) for c in cell_ids}

    zone_ids = sorted(set(zone_of.values()))
    zone_index = {z: i for i, z in enumerate(zone_ids)}
    zones = [
        {"id": z, "label": z if zone_kind == "zip" else f"Area {i + 1}"} for i, z in enumerate(zone_ids)
    ]

    centers = [h3.cell_to_latlng(c) for c in cell_ids]
    return {
        "meta": {
            "city": city,
            "bbox": list(bbox),
            "release": release,
            "generated": dt.date.today().isoformat(),
            "zoneKind": zone_kind,
            "reachSource": "addresses" if use_addresses else "buildings",
        },
        "cats": cat_rows,
        "brands": list(brands),
        "places": cols,
        "cells": {
            "res": H3_RES,
            "id": cell_ids,
            "lat": [round(la, 5) for la, _ in centers],
            "lng": [round(lo, 5) for _, lo in centers],
            "reach": [reach.get(c, 0) for c in cell_ids],
            "zone": [zone_index[zone_of[c]] if c in zone_of else -1 for c in cell_ids],
        },
        "zones": zones,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", default="San Francisco")
    ap.add_argument("--bbox", default=",".join(map(str, SF_BBOX)), help="west,south,east,north")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "public/data/city.json"))
    args = ap.parse_args()
    bbox = tuple(float(x) for x in args.bbox.split(","))

    release = latest_release()
    print(f"Overture release {release}, bbox {bbox}", file=sys.stderr)
    data = build(args.city, bbox, release, *fetch(release, bbox))

    m = data["meta"]
    n_places, n_cells = len(data["places"]["name"]), len(data["cells"]["id"])
    total_reach = sum(data["cells"]["reach"])
    print(
        f"{n_places:,} places, {len(data['cats'])} categories, {n_cells:,} cells, "
        f"{len(data['zones'])} {m['zoneKind']} zones, reach {total_reach:,} ({m['reachSource']})",
        file=sys.stderr,
    )
    # Fail loudly instead of shipping an empty map.
    if n_places < 1000 or total_reach < 1000:
        sys.exit("Extract looks empty. Check the bbox and the release.")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
