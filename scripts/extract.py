#!/usr/bin/env python3
"""Extract cities from Overture Maps into public/data/<slug>.json plus an index.json.

Reads the cloud hosted GeoParquet directly with DuckDB (no account, no key):
  places     -> businesses with a name, a category and a confidence score
  addresses  -> address points, the reach proxy, plus their postal codes
  buildings  -> fallback reach proxy where a city has no address coverage

Usage:
  pip install -r scripts/requirements.txt
  python scripts/extract.py --all                    # every city in scripts/cities.json
  python scripts/extract.py --only san-francisco     # one of them
  OVERTURE_RELEASE=2026-11-18.0 python scripts/extract.py --all
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from collections import Counter, defaultdict
from pathlib import Path

import h3

STAC = "https://stac.overturemaps.org/catalog.json"
BUCKET = "s3://overturemaps-us-west-2/release"
HERE = Path(__file__).resolve().parent
CITIES = json.loads((HERE / "cities.json").read_text())
MILES = {"US", "GB"}  # everyone else reads distances in km
H3_RES = 9  # about 0.1 square km per cell, roughly a city block or two
MIN_CONFIDENCE = 0.5  # Overture's existence score; below this a listing is a coin flip
MIN_ADDRESSES = 20_000  # fewer than this and we treat address coverage as missing
MIN_ZIP_SHARE = 0.7  # share of cells that must resolve to a postal code before we trust postal zones
MAX_ZONES = 120  # more than this and the codes are too fine to be a targeting unit


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

    addresses = con.execute(
        f"SELECT bbox.xmin, bbox.ymin, postcode FROM {src('addresses', 'address')} WHERE {where}"
    ).fetchall()

    buildings = []
    if len(addresses) < MIN_ADDRESSES:
        buildings = con.execute(
            f"""SELECT (bbox.xmin + bbox.xmax) / 2, (bbox.ymin + bbox.ymax) / 2
                FROM {src('buildings', 'building')} WHERE {where}"""
        ).fetchall()
    return places, addresses, buildings


def postal(value, country: str) -> str | None:
    """Reduce a postal code to the unit an ad platform targets. Returns None when it does not parse."""
    if not value:
        return None
    raw = str(value).strip().upper()
    digits = re.sub(r"\D", "", raw)
    if country == "US":
        return digits[:5] if len(digits) >= 5 else None
    if country == "GB":  # outward code: "SW1A 1AA" -> "SW1A"
        out = raw.split()[0] if " " in raw else raw[:-3]
        return out if re.fullmatch(r"[A-Z]{1,2}\d[A-Z\d]?", out) else None
    if country == "CA":  # forward sortation area: "M5V 2T6" -> "M5V"
        out = raw.replace(" ", "")[:3]
        return out if re.fullmatch(r"[A-Z]\d[A-Z]", out) else None
    if country == "IE":  # routing key: "D02 X285" -> "D02"
        out = raw.replace(" ", "")[:3]
        return out if re.fullmatch(r"[A-Z][\dW]{2}", out) else None
    trim = {"NL": 4, "PT": 4, "JP": 3, "KR": 3, "BR": 5, "SG": 2, "PL": 3}.get(country)
    if trim:
        return digits[:trim] if len(digits) >= trim else None
    compact = re.sub(r"[^A-Z0-9]", "", raw)
    return compact if 3 <= len(compact) <= 7 else None


def label(cat_id: str) -> str:
    return cat_id.replace("_", " ").capitalize()


def build(city: str, bbox, release: str, places, addresses, buildings, country: str = "US", slug: str = "") -> dict:
    """Pure transform from query rows to the city file. Kept separate so it can be tested offline."""
    cell_of = lambda lat, lng: h3.latlng_to_cell(lat, lng, H3_RES)

    use_addresses = len(addresses) >= MIN_ADDRESSES
    reach: Counter = Counter()
    zip_votes: dict[str, Counter] = defaultdict(Counter)
    if use_addresses:
        for lng, lat, postcode in addresses:
            c = cell_of(lat, lng)
            reach[c] += 1
            z = postal(postcode, country)
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
        z = postal(postcode, country)
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
    zone_kind = "zip" if zip_share >= MIN_ZIP_SHARE and 2 <= len(set(zone_of.values())) <= MAX_ZONES else "hex"
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
            "slug": slug,
            "city": city,
            "country": country,
            "units": "mi" if country in MILES else "km",
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


def run_city(release: str, spec: dict, out_dir: Path) -> dict | None:
    """Extract one city. Returns its index entry, or None when the data is too thin to ship."""
    bbox = tuple(spec["bbox"])
    try:
        rows = fetch(release, bbox)
        data = build(spec["name"], bbox, release, *rows, country=spec["country"], slug=spec["slug"])
    except Exception as err:  # one bad city must not sink the rest
        print(f"[{spec['slug']}] FAILED: {err}", file=sys.stderr)
        return None
    m = data["meta"]
    n_places, total_reach = len(data["places"]["name"]), sum(data["cells"]["reach"])
    summary = (
        f"[{spec['slug']}] {n_places:,} places, {len(data['cats'])} categories, {len(data['cells']['id']):,} cells, "
        f"{len(data['zones'])} {m['zoneKind']} zones, reach {total_reach:,} ({m['reachSource']})"
    )
    if n_places < 500 or total_reach < 1000:
        print(summary + " -> SKIPPED, too thin", file=sys.stderr)
        return None
    path = out_dir / f"{spec['slug']}.json"
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    print(summary + f", {path.stat().st_size / 1e6:.1f} MB", file=sys.stderr)
    return {
        "slug": spec["slug"],
        "city": spec["name"],
        "country": spec["country"],
        "places": n_places,
        "reach": total_reach,
        "reachSource": m["reachSource"],
        "zoneKind": m["zoneKind"],
        "zones": len(data["zones"]),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="every city in scripts/cities.json")
    ap.add_argument("--only", default="", help="comma separated slugs")
    ap.add_argument("--out", default=str(HERE.parent / "public/data"))
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    wanted = set(filter(None, args.only.split(",")))
    specs = [c for c in CITIES if args.all or c["slug"] in wanted]
    if not specs:
        sys.exit("Nothing to do. Pass --all or --only <slug>.")

    release = latest_release()
    print(f"Overture release {release}, {len(specs)} cities", file=sys.stderr)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        entries = list(pool.map(lambda spec: run_city(release, spec, out), specs))
    done = [e for e in entries if e]
    print(f"{len(done)} of {len(specs)} cities shipped", file=sys.stderr)
    # Fail loudly instead of deploying a hollow site.
    if len(done) < max(1, len(specs) // 2):
        sys.exit("Too many cities failed.")
    index = {"release": release, "generated": dt.date.today().isoformat(), "cities": done}
    (out / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
