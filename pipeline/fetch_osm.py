"""Fetch OpenStreetMap layers for India from Overpass in tiles, so no single request hits the server's time or
memory limit. A response carrying an Overpass error remark (a timed-out or truncated result) counts as a failure:
the tile is retried, then tried on the next server; if any tile still fails the whole layer is rejected and the
previous file (or the fallback source) stays in use. Partial national layers are never written.

usage: python pipeline/fetch_osm.py sites raw/osm_sites.json
       python pipeline/fetch_osm.py substations raw/osm_substations.json
"""
import json
import sys
import time
import urllib.parse
import urllib.request

ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
# India's bounding box split into tiles (lat 6-37.5, lon 68-97.5); small tiles where OSM is dense
LATS = [6.0, 12.0, 16.0, 20.0, 24.0, 28.0, 32.0, 37.5]
LONS = [68.0, 74.0, 78.0, 82.0, 86.0, 90.0, 97.5]

BODY = {
    "sites": '''node["amenity"="fuel"]({b});way["amenity"="fuel"]({b});
node["barrier"="toll_booth"]({b});way["barrier"="toll_booth"]({b});
node["railway"="station"]({b});
node["amenity"="bus_station"]({b});way["amenity"="bus_station"]({b});
node["aeroway"="aerodrome"]["iata"]({b});way["aeroway"="aerodrome"]["iata"]({b});
node["office"="government"]({b});way["office"="government"]({b});
way["amenity"="hospital"]["operator:type"~"government|public"]({b});node["amenity"="hospital"]["operator:type"~"government|public"]({b});
way["amenity"~"university|college"]["operator:type"~"government|public"]({b});''',
    "substations": '''node["power"="substation"]({b});way["power"="substation"]({b});''',
}
MIN_TOTAL = {"sites": 20000, "substations": 1000}


def query(q, timeout=400):
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for ep in ENDPOINTS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(ep, data=data, headers={"User-Agent": "ReachGrid-India-pipeline (+https://github.com/akshatinnovate-png/EV-Infra-ReachGrid-India)"})
                with urllib.request.urlopen(req, timeout=timeout + 60) as r:
                    j = json.loads(r.read().decode("utf-8"))
                remark = j.get("remark") or ""
                if "error" in remark.lower() or "timed out" in remark.lower() or "out of memory" in remark.lower():
                    raise RuntimeError("overpass remark: " + remark[:160])
                return j.get("elements", [])
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"    {ep.split('/')[2]} attempt {attempt + 1}: {e}", flush=True)
                time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"all endpoints failed: {last}")


def main(layer, out):
    body = BODY[layer]
    seen, elements = set(), []
    tiles = [(la0, lo0, la1, lo1) for la0, la1 in zip(LATS, LATS[1:]) for lo0, lo1 in zip(LONS, LONS[1:])]
    for k, (la0, lo0, la1, lo1) in enumerate(tiles, 1):
        b = f"{la0},{lo0},{la1},{lo1}"
        q = f"[out:json][timeout:360][maxsize:536870912];({body.format(b=b)});out center tags;"
        els = query(q)
        new = 0
        for e in els:
            key = (e.get("type"), e.get("id"))
            if key not in seen:
                seen.add(key); elements.append(e); new += 1
        print(f"  tile {k}/{len(tiles)} [{b}]: {new} elements", flush=True)
    if len(elements) < MIN_TOTAL[layer]:
        raise RuntimeError(f"only {len(elements)} elements for {layer}; not writing a partial layer")
    with open(out + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"elements": elements, "generator": "ReachGrid fetch_osm.py (tiled Overpass)", "fetched": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime())}, f)
    import os
    os.replace(out + ".tmp", out)
    print(f"  {layer}: {len(elements)} elements written to {out}")


if __name__ == "__main__":
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception as e:  # noqa: BLE001
        print(f"  {sys.argv[1]} not updated: {e}")
        sys.exit(0)   # the build falls back (power plants / previous layer); never fail the whole refresh
