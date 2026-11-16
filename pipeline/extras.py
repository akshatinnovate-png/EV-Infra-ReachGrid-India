"""Additional data layers for ReachGrid: VAHAN EV registrations, charger power tiers, grid proximity.

Kept separate from build.py so each ingestion adapter can change without touching the engine
(proposal §14.1, "keep ingestion adapters separate from analytical logic").
"""
from __future__ import annotations

import collections
import csv
import json
import os
import re

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
STATE_ALIAS = {  # VAHAN state labels -> ReachGrid state ids
    "andaman-nicobar-island": "andaman-and-nicobar-islands", "andaman-and-nicobar-island": "andaman-and-nicobar-islands",
    "dadra-and-nagar-haveli-and-daman-and-diu": "dadra-and-nagar-haveli-and-daman-and-diu", "uts-of-dnh-and-dd": "dadra-and-nagar-haveli-and-daman-and-diu",
    "dnh-and-dd": "dadra-and-nagar-haveli-and-daman-and-diu", "ut-of-dnh-and-dd": "dadra-and-nagar-haveli-and-daman-and-diu", "nct-of-delhi": "delhi", "jammu-kashmir": "jammu-and-kashmir",
    "uttarakhand": "uttarakhand", "uttaranchal": "uttarakhand", "orissa": "odisha", "pondicherry": "puducherry",
}


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _read_vahan(path: str):
    """VAHAN dashboard export: a title line, then 'State,YYYY-Mon,...,Total' and one row per state."""
    text = open(path, encoding="utf-8").read().replace("\\n", "\n")
    lines = [l for l in text.splitlines() if l.strip()]
    hi = next(i for i, l in enumerate(lines) if l.startswith("State,"))
    head = next(csv.reader([lines[hi]]))
    months = head[1:-1]
    out = {}
    for row in csv.reader(lines[hi + 1:]):
        if not row or row[0].strip().lower() == "total":
            continue
        out[row[0].strip()] = {m: float(v or 0) for m, v in zip(months, row[1:-1])}
    return out


def vahan_series(vdir: str, state_ids: set):
    """Monthly electric and total two-wheeler registrations per state, 2020-01 .. 2024-12.
    Files overlap by a year; the newest export wins for any month present in several files."""
    if not os.path.isdir(vdir):
        return None
    ev, tot = collections.defaultdict(dict), collections.defaultdict(dict)
    files = sorted(f for f in os.listdir(vdir) if f.endswith(".csv"))
    for f in files:  # sorted, so later (newer) files overwrite earlier months
        target = ev if f.endswith("ev.csv") else tot
        for st, ms in _read_vahan(os.path.join(vdir, f)).items():
            sid = _slug(st); sid = STATE_ALIAS.get(sid, sid)
            target[sid].update(ms)
    states, unmatched = {}, []
    for sid in set(ev) | set(tot):
        if sid not in state_ids:
            unmatched.append(sid); continue
        years = {}
        for y in range(2020, 2025):
            e = sum(ev[sid].get(f"{y}-{m}", 0) for m in MONTHS)
            t = sum(tot[sid].get(f"{y}-{m}", 0) for m in MONTHS)
            years[str(y)] = {"e2w": round(e), "all2w": round(t), "share": round(e / t, 5) if t else None}
        e21, e24 = years["2021"]["e2w"], years["2024"]["e2w"]
        cagr = (e24 / e21) ** (1 / 3) - 1 if e21 > 0 and e24 > 0 else None
        states[sid] = {"years": years, "stock_2020_2024": round(sum(v["e2w"] for v in years.values())),
                       "cagr_2021_2024": round(cagr, 4) if cagr is not None else None,
                       "monthly_2024": [round(ev[sid].get(f"2024-{m}", 0)) for m in MONTHS]}
    nat = {str(y): {"e2w": sum(s["years"][str(y)]["e2w"] for s in states.values()),
                    "all2w": sum(s["years"][str(y)]["all2w"] for s in states.values())} for y in range(2020, 2025)}
    for v in nat.values():
        v["share"] = round(v["e2w"] / v["all2w"], 5) if v["all2w"] else None
    return {"states": states, "national": nat, "unmatched": sorted(unmatched), "files": files}


TIERS = ("ac_slow", "ac_fast", "dc_fast", "dc_ultra", "unknown")
CONNECTORS = (("CCS2", r"ccs"), ("Type 2", r"type\s*2"), ("Bharat AC-001", r"ac-?001|bharat\s*ac"), ("Bharat DC-001", r"dc-?001|bharat\s*dc"),
              ("3-pin / 15A", r"3-?pin|15a"), ("CHAdeMO", r"chademo"), ("GB/T", r"gb/?t"), ("Type 6 / LEV", r"type\s*6|lev"))


def tier_of(kw, ac, dc):
    if kw:
        return "ac_slow" if kw <= 7.4 else "ac_fast" if kw <= 22 and not dc else "dc_fast" if kw <= 60 else "dc_ultra"
    if dc:
        return "dc_fast"
    if ac:
        return "ac_slow"
    return "unknown"


def charger_inventory(ch):
    """Power tiers, connector counts and charge-point (gun) totals for a list of charger records."""
    tiers = collections.Counter(tier_of(x[4], x[5], x[6]) for x in ch)
    conn = collections.Counter()
    for x in ch:
        s = (x[12] or "").lower()
        for name, pat in CONNECTORS:
            if re.search(pat, s):
                conn[name] += 1
    known = [x for x in ch if x[5] is not None or x[6] is not None]
    ac = sum(x[5] or 0 for x in known); dc = sum(x[6] or 0 for x in known)
    per_site = (ac + dc) / len(known) if known else None
    return {"tiers": {t: tiers.get(t, 0) for t in TIERS}, "connectors": dict(conn.most_common()),
            "ac_points": ac, "dc_points": dc, "points_known_sites": len(known),
            "points_per_site": round(per_site, 2) if per_site else None}


def grid_points(raw_dir: str):
    """Electricity-infrastructure proxy. Prefers OpenStreetMap power substations (fetched by the refresh
    workflow), falls back to WRI Global Power Plant Database plants in India."""
    osm = os.path.join(raw_dir, "osm_substations.json")
    if os.path.exists(osm):
        try:
            j = json.load(open(osm))
            pts = []
            for e in j.get("elements", []):
                lat = e.get("lat") or (e.get("center") or {}).get("lat"); lon = e.get("lon") or (e.get("center") or {}).get("lon")
                if lat is None or lon is None:
                    continue
                v = str((e.get("tags") or {}).get("voltage", "")).split(";")[0]
                kv = round(int(v) / 1000) if v.isdigit() else 0
                pts.append([round(lat, 4), round(lon, 4), kv])
            if len(pts) > 1000:
                return {"kind": "substation", "points": pts, "source": "osm"}
        except Exception:
            pass
    path = os.path.join(raw_dir, "gppd.csv")
    if not os.path.exists(path):
        return None
    pts = []
    for r in csv.DictReader(open(path, encoding="utf-8")):
        if r["country"] != "IND":
            continue
        try:
            pts.append([round(float(r["latitude"]), 4), round(float(r["longitude"]), 4), round(float(r["capacity_mw"] or 0))])
        except ValueError:
            continue
    return {"kind": "power_plant", "points": pts, "source": "wri"}
