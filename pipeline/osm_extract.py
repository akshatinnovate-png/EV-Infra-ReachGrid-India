"""Convert an osmium GeoJSON-sequence export of the India OSM extract (Geofabrik) into the Overpass-style files the
build reads (raw/osm_sites.json, raw/osm_substations.json): {"elements": [{"lat", "lon", "tags"}]}.

Applies the same selection as the Overpass queries in fetch_osm.py: hospitals, colleges and universities only when
OSM marks them government / public operated; airports only with an IATA code. Ways and relations are reduced to the
mean of their coordinates (a point inside or on the site, which is all the planner needs).

usage: python pipeline/osm_extract.py raw/osm_filtered.geojsonseq raw
"""
import json
import os
import re
import sys

GOV = re.compile(r"government|public", re.I)


def centre(geom):
    pts = []

    def walk(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            pts.append(c)
        elif isinstance(c, (list, tuple)):
            for x in c:
                walk(x)
    walk(geom.get("coordinates") or [])
    if not pts:
        return None
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)


def keep_site(t):
    a = t.get("amenity")
    if a in ("fuel", "bus_station"):
        return True
    if t.get("barrier") == "toll_booth" or t.get("railway") == "station" or t.get("office") == "government":
        return True
    if t.get("aeroway") == "aerodrome":
        return bool(t.get("iata"))
    if a in ("hospital", "university", "college"):
        return bool(GOV.search(t.get("operator:type", "")))
    return False


def main(src, out_dir):
    sites, subs = [], []
    with open(src, encoding="utf-8") as f:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = feat.get("properties") or {}
            c = centre(feat.get("geometry") or {})
            if not c:
                continue
            el = {"lat": round(c[0], 6), "lon": round(c[1], 6), "tags": t}
            if t.get("power") == "substation":
                subs.append(el)
            elif keep_site(t):
                sites.append(el)
    for name, els, minimum in (("osm_sites.json", sites, 20000), ("osm_substations.json", subs, 1000)):
        if len(els) < minimum:
            print(f"  {name}: only {len(els)} features in the extract; not written")
            continue
        tmp = os.path.join(out_dir, name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as g:
            json.dump({"elements": els, "generator": "ReachGrid osm_extract.py (Geofabrik India extract via osmium)"}, g)
        os.replace(tmp, os.path.join(out_dir, name))
        print(f"  {name}: {len(els)} features")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
