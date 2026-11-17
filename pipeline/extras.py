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


# ---------------------------------------------------------------------------------------------
# VAHAN registrations by RTO and month (India Data Portal mirror of the VAHAN dashboard, ODC-BY)
# ---------------------------------------------------------------------------------------------
EV_FUELS = {"Electric(BOV)", "Pure EV", "Plug-in Hybrid EV"}       # plug-in vehicles; strong hybrids do not charge
ERICK_CLASSES = {"E-Rickshaw(P)", "E-Rickshaw With Cart (G)"}       # electric by definition (L3 e-rickshaw / e-cart)
# all-fuel registrations by segment (denominator for EV share of new registrations)
CLASS_SEGMENT = {
    "M-Cycle/Scooter": "e2w", "Moped": "e2w", "Motorised Cycle (CC > 25CC)": "e2w", "Motor Cycle/Scooter-Used for Hire": "e2w",
    "M-Cycle/Scooter-With Side Car": "e2w", "Motor Cycle/Scooter-Sidecar(T)": "e2w",
    "Three Wheeler (Passenger)": "e3w", "Three Wheeler (Goods)": "e3w", "Three Wheeler (Personal)": "e3w",
    "E-Rickshaw(P)": "e3w", "E-Rickshaw With Cart (G)": "e3w",
    "Motor Car": "e4w", "Motor Cab": "e4w", "Maxi Cab": "e4w", "Luxury Cab": "e4w", "Quadricycle (Commercial)": "e4w",
    "Bus": "bus", "Educational Institution Bus": "bus", "Omni Bus": "bus", "Omni Bus (Private Use)": "bus", "School Bus": "bus",
}
SEGMENTS = ("e2w", "e3w", "e4w", "bus")
# EV-only manufacturers whose segment is unambiguous. Used only to split the non-e-rickshaw EV remainder of each
# state-year between segments; mixed ICE/EV makers (TVS, Bajaj, Hero, Tata Motors, Hyundai, MG, Piaggio...) are not
# used because their EV share is not separable. e-rickshaw makers are excluded because e-rickshaws are observed directly.
MAKER_CLASS = {
    # e-2W
    "Ola Electric Technologies PVT LTD": "e2w", "Ather Energy LTD": "e2w", "Ather Energy PVT LTD": "e2w",
    "Greaves Electric Mobility LTD": "e2w", "Greaves Electric Mobility PVT LTD": "e2w", "Ampere Vehicles Private Limited": "e2w",
    "Bgauss Auto Private Limited": "e2w", "River Mobility PVT LTD": "e2w", "Revolt Intellicorp PVT LTD": "e2w",
    "Lectrix E Vehicles PVT LTD": "e2w", "Wardwizard Innovations & Mobility Limited": "e2w", "Bounce Electric 1 PVT LTD": "e2w",
    "Simpleenergy PVT LTD": "e2w", "KLB Komaki PVT LTD": "e2w", "Okinawa Autotech PVT LTD": "e2w",
    "Oben Electric Vehicles PVT LTD": "e2w", "Odysse Electric Vehicles PVT LTD": "e2w", "Ultraviolette Automotive PVT LTD": "e2w",
    "Hero Electric Vehicles PVT. LTD": "e2w", "Quantum Energy LTD.": "e2w", "Battre Electric Moblity PVT LTD": "e2w",
    "Sokudo Electric India PVT LTD": "e2w", "Jitendra New EV-Tech PVT. LTD": "e2w", "E-Sprinto Green Energy PVT LTD": "e2w",
    "Pure Energy PVT LTD": "e2w", "Okaya EV PVT LTD": "e2w",
    # e-3W (L5 autos and cargo; e-rickshaws are counted from the vehicle-class table instead)
    "Mahindra Last Mile Mobility LTD": "e3w", "Mahindra Electric Mobility Limited": "e3w", "Euler Motors PVT LTD": "e3w",
    "Omega Seiki PVT LTD": "e3w", "Altigreen Propulsion Labs PVT LTD": "e3w", "Atul Greentech Private Limited": "e3w",
    # e-4W (cars, LCV)
    "Tata Passenger Electric Mobility LTD": "e4w", "Mahindra Electric Automobile LTD": "e4w",
    "BYD India Private Limited": "e4w", "BYD Auto": "e4w",
    # e-bus / e-truck
    "Olectra Greentech LTD": "bus", "Pmi Electro Mobility Solutions Private Limited": "bus", "JBM Auto Limited": "bus",
    "Switch Mobility Automotive LTD": "bus", "Eka Mobility PVT LTD": "bus",
}
IDP_STATE_ALIAS = {"andaman-nicobar-island": "andaman-and-nicobar-islands", "ut-of-dnh-and-dd": "dadra-and-nagar-haveli-and-daman-and-diu",
                   "jammu-and-kashmir": "jammu-and-kashmir"}


def idp_state_id(name: str) -> str:
    s = _slug(name)
    return IDP_STATE_ALIAS.get(s, STATE_ALIAS.get(s, s))


def _num(v):
    try:
        return int(float(v or 0))
    except ValueError:
        return 0


def idp_rto_series(idp_dir: str):
    """{(state_id, rto, rto_code): {"YYYY-MM": [ev, erick, all_2w, all_3w, all_4w, all_bus]}} from the fuel-type and
    vehicle-class tables (all_* = registrations of every fuel, by segment)."""
    seg_i = {"e2w": 2, "e3w": 3, "e4w": 4, "bus": 5}
    out = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0, 0, 0, 0]))
    for r in csv.DictReader(open(os.path.join(idp_dir, "fuel.csv"), encoding="utf-8")):
        if r["registration_type"] in EV_FUELS:
            out[(idp_state_id(r["state_name"]), r["rto"].strip(), r["rto_code"])][r["date"][:7]][0] += _num(r["registrations"])
    for r in csv.DictReader(open(os.path.join(idp_dir, "vclass.csv"), encoding="utf-8")):
        k = (idp_state_id(r["state_name"]), r["rto"].strip(), r["rto_code"]); mo = r["date"][:7]; n = _num(r["registrations"])
        if r["registration_type"] in ERICK_CLASSES:
            out[k][mo][1] += n
        sg = CLASS_SEGMENT.get(r["registration_type"])
        if sg:
            out[k][mo][seg_i[sg]] += n
    return out


def idp_maker_shares(idp_dir: str):
    """{(state_id, year): Counter(segment -> registrations by EV-only makers)}"""
    sh = collections.defaultdict(collections.Counter)
    for r in csv.DictReader(open(os.path.join(idp_dir, "maker.csv"), encoding="utf-8")):
        c = MAKER_CLASS.get(r["registration_type"])
        if c:
            sh[(idp_state_id(r["state_name"]), r["date"][:4])][c] += _num(r["registrations"])
    return sh


_RTO_DROP = re.compile(r"\b(rto|dto|arto|srto|rta|rla|uo|sdm|mvi|office|unit|regional|district|transport|authority|deputy|dy|"
                       r"additional|addl|asst|assistant|licensing|registering|registration|sub|first|second|third|urban|rural|new|old|city|"
                       r"hp-\d+|state|[a-z]{2}-?\d+)\b")


# renamed cities and metro sub-RTOs -> a district or town name present in the boundary / GeoNames data
RTO_ALIAS = {
    "kataka": "cuttack", "ahilyanagar": "ahmednagar", "chhatrapati sambhajinagar": "aurangabad", "sambhajinagar": "aurangabad",
    "amrawati": "amravati", "baleshwar": "balasore", "raibareilly": "rae bareli", "raebareli": "rae bareli", "purnea": "purnia",
    "motihari": "east champaran", "bettiah": "west champaran", "bhubaneswar": "khordha", "hosur": "krishnagiri", "barasat": "north 24 parganas", "ambikapur": "surguja", "yawatmal": "yavatmal", "chapara": "saran", "chhapra": "saran", "srirampur": "ahmednagar", "malegaon": "nashik", "baramati": "pune", "trivandrum": "thiruvananthapuram", "tumkur": "tumakuru", "badaun": "budaun",
    "dharashiv": "osmanabad", "mysuru": "mysore",
    "belagavi": "belgaum", "kalaburagi": "gulbarga", "vijayapura": "bijapur", "shivamogga": "shimoga", "ballari": "bellary",
    "hanumakonda": "hanumakonda", "kochi": "ernakulam", "cochin": "ernakulam", "calicut": "kozhikode", "pondicherry": "puducherry",
    "electronic city": "bengaluru urban", "krishnarajapuram": "bengaluru urban", "yalahanka": "bengaluru urban", "yelahanka": "bengaluru urban",
    "jnanabharathi": "bengaluru urban", "jayanagar": "bengaluru urban", "rajajinagar": "bengaluru urban", "indiranagar": "bengaluru urban",
    "kengeri": "bengaluru urban", "devanahalli": "bengaluru rural", "chandapura": "bengaluru urban", "jnana bharathi": "bengaluru urban",
    "hyderabad cz": "hyderabad", "hyderabad nz": "hyderabad", "hyderabad sz": "hyderabad", "hyderabad ez": "hyderabad", "hyderabad wz": "hyderabad",
    "uppal": "medchal malkajgiri", "ibrahimpatnam": "ranga reddy", "kondapur": "ranga reddy", "attapur": "ranga reddy", "medchal": "medchal malkajgiri",
    "borivali": "mumbai", "andheri": "mumbai", "wadala": "mumbai", "tardeo": "mumbai", "mumbai central": "mumbai",
    "pimpri chinchwad": "pune", "vasai": "palghar", "kalyan": "thane", "panvel": "raigad", "jhansirto": "jhansi", "jpnagar": "amroha", "tamluk": "purba medinipur", "mapusa": "north goa", "sholinganallur": "chennai", "paschim burdwan": "paschim bardhaman", "west tripura": "west tripura", "akluj": "solapur", "kukatpally": "medchal malkajgiri", "marthandam": "kanniyakumari", "alipore": "kolkata",
}


def _rto_keys(name: str):
    n = re.sub(r"\b([a-z])\.\s*(?=[a-z]\b\.?)", r"\1", name.lower())   # R.T.O. -> rto
    n = re.sub(r"\br\.?t\.?o\.?", " rto ", n)
    raw = re.sub(r"[^a-z ]+", " ", n)
    pre = [b for a, b in RTO_ALIAS.items() if re.search(r"\b" + a + r"\b", raw)]
    paren = re.findall(r"\(([^)]*)\)", n)
    base = re.sub(r"\([^)]*\)", " ", n)
    keys = []
    for s in [base] + paren:
        s = re.sub(r"[^a-z ]+", " ", _RTO_DROP.sub(" ", s.replace("/", " ")))
        s = re.sub(r"\s+", " ", s).strip()
        s = re.sub(r"(rto|arto|dto)$", "", s).strip()
        if s:
            keys.append(s)
            nd = re.sub(r"\b(north|south|east|west|central)\b", " ", s); nd = re.sub(r"\s+", " ", nd).strip()
            if nd and nd != s:
                keys.append(nd)
    return keys + pre   # the RTO's own name first, then known renames / metro sub-RTOs


def rto_matcher(districts):
    """Returns match(state_id, rto_name) -> (district index | None, how). Exact district name, then GeoNames town in
    the state (largest population wins), then close spelling (difflib >= 0.88) against both."""
    import difflib
    norm = lambda s: re.sub(r"[^a-z ]+", " ", s.lower()).strip()
    by_state = collections.defaultdict(dict); towns = collections.defaultdict(dict)
    for i, d in enumerate(districts):
        by_state[d["sid"]][re.sub(r"\s+", " ", norm(d["name"]))] = i
        for pl in d.get("places", []):
            k = re.sub(r"\s+", " ", norm(pl["n"]))
            if k and (k not in towns[d["sid"]] or pl["p"] > towns[d["sid"]][k][1]):
                towns[d["sid"]][k] = (i, pl["p"])

    def match(sid, rto):
        dn, tn = by_state.get(sid, {}), towns.get(sid, {})
        keys = _rto_keys(rto)
        for k in keys:
            if k in dn: return dn[k], "district"
        for k in keys:
            if k in tn: return tn[k][0], "town"
        for k in keys:
            m = difflib.get_close_matches(k, list(dn), n=1, cutoff=0.88)
            if m: return dn[m[0]], "district~"
            m = difflib.get_close_matches(k, list(tn), n=1, cutoff=0.9)
            if m: return tn[m[0]][0], "town~"
        # single words (>= 4 letters) against district names, then towns (largest population)
        for k in keys:
            for w in sorted(k.split(), key=len, reverse=True):
                if len(w) >= 4 and w in dn: return dn[w], "word"
            best = max(((tn[w][1], tn[w][0]) for w in k.split() if len(w) >= 4 and w in tn), default=None)
            if best: return best[1], "word"
        if len(dn) == 1:
            return next(iter(dn.values())), "single-district"
        return None, "unmatched"
    return match


# Published national monthly VAHAN figures used to calibrate the e-4W and e-bus split (EVReporter monthly
# "India's Electric Vehicle sales trend", VAHAN data excluding Telangana). Month -> {segment: registrations}.
SEGMENT_ANCHORS = {
    "2024-12": {"e4w": 9116, "bus": 176}, "2025-01": {"e4w": 11766, "bus": 360}, "2025-02": {"e4w": 8962, "bus": 307},
    "2025-04": {"e4w": 13119, "bus": 284}, "2025-05": {"e4w": 12212, "bus": 338}, "2025-09": {"bus": 343},
    "2025-10": {"bus": 290}, "2025-11": {"bus": 369},
}
ANCHOR_SOURCE = "EVReporter, India's Electric Vehicle sales trend (monthly reports, Dec 2024 - Nov 2025; VAHAN, excl. Telangana)"


def vahan_rto(idp_dir: str, districts, state_e2w_obs=None, district_weight=None, anchors=SEGMENT_ANCHORS):
    """District-level EV registrations by month, year and segment from RTO data.

    districts: list of {"id","sid","name","places"}; state_e2w_obs: {sid: {"2022": n, ...}} observed state e-2W
    (calibration and raking); district_weight: {index: weight} fallback allocation of unmatched RTOs;
    anchors: national monthly e-4W / e-bus counts for segment calibration. Returns (per_district, meta)."""
    ser = idp_rto_series(idp_dir)
    # 1. data quality: drop aggregate rows mislabelled as an RTO (monthly EVs > 40% of all other RTOs)
    month_tot = collections.Counter()
    for m in ser.values():
        for mo, v in m.items():
            month_tot[mo] += v[0]
    aggregates = []
    for k, m in list(ser.items()):
        if any(v[0] > 1000 and v[0] > 0.4 * (month_tot[mo] - v[0]) for mo, v in m.items()):
            aggregates.append({"state": k[0], "rto": k[1], "code": k[2], "ev": sum(v[0] for v in m.values())})
            del ser[k]
    months = sorted({mo for m in ser.values() for mo in m})
    latest = months[-1]; ly = latest[:4]
    years = sorted({mo[:4] for mo in months})
    # 2. RTO -> district; unmatched RTOs pooled by state
    match = rto_matcher(districts)
    sids = {d["sid"] for d in districts}
    dm = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0] * 6))   # i -> month -> [ev, erick, all2w, all3w, all4w, allbus]
    pool = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0] * 6))
    how = collections.Counter(); how_ev = collections.Counter(); unmatched = []
    for (sid, rto, code), m in ser.items():
        ev = sum(v[0] for v in m.values())
        i, h = match(sid, rto) if sid in sids else (None, "state-unknown")
        how[h] += 1; how_ev[h] += ev
        tgt = dm[i] if i is not None else pool[sid]
        for mo, v in m.items():
            tgt[mo][0] += v[0]; tgt[mo][1] += min(v[1], v[0])   # e-rickshaws are a subset of EV registrations
            for j in range(2, 6):
                tgt[mo][j] += v[j]
        if i is None:
            unmatched.append((ev, sid, rto))
    by_state = collections.defaultdict(list)
    for i, d in enumerate(districts):
        by_state[d["sid"]].append(i)
    for sid, ms in pool.items():
        idx = by_state.get(sid, [])
        if not idx:
            continue
        w = {i: sum(v[0] for v in dm[i].values()) for i in idx}
        if sum(w.values()) == 0:
            w = {i: (district_weight or {}).get(i, 1) for i in idx}
        tw = sum(w.values()) or 1
        for i in idx:
            f = w[i] / tw
            for mo, v in ms.items():
                for j in range(6):
                    dm[i][mo][j] += v[j] * f
    # 3. segment split of the non-e-rickshaw remainder by EV-only maker shares (state-year, else national-year)
    shares = idp_maker_shares(idp_dir)
    nat = collections.defaultdict(collections.Counter)
    for (sid, y), c in shares.items():
        nat[y].update(c)

    def share(sid, y):
        c = shares.get((sid, y))
        if not c or sum(c.values()) < 200:
            c = nat[y]
        t = sum(c.values()) or 1
        return {s: c.get(s, 0) / t for s in ("e2w", "e3w", "e4w", "bus")}

    est = {i: {} for i in dm}   # i -> month -> segment estimates
    for i, ms in dm.items():
        sid = districts[i]["sid"]
        for mo, vv in ms.items():
            e, r = vv[0], vv[1]
            rem = max(0.0, e - r); sh = share(sid, mo[:4])
            est[i][mo] = {"ev": e, "erick": r, "rem": rem, "all": {"e2w": vv[2], "e3w": vv[3], "e4w": vv[4], "bus": vv[5]}, "e2w": rem * sh["e2w"], "l5": rem * sh["e3w"], "e4w": rem * sh["e4w"], "bus": rem * sh["bus"]}
    # 4. e-2W calibration against the observed state series: fit on early years, test on the last observed year
    calib = None
    st_y = collections.defaultdict(collections.Counter)
    for i, ms in est.items():
        for mo, v in ms.items():
            st_y[districts[i]["sid"]][mo[:4]] += v["e2w"]
    k_all = 1.0
    if state_e2w_obs:
        obs_years = sorted({y for v in state_e2w_obs.values() for y in v if y in years})
        pairs = [(sid, y, st_y[sid][y], state_e2w_obs[sid][y]) for sid in state_e2w_obs for y in obs_years if state_e2w_obs[sid].get(y)]
        if len(obs_years) >= 2:
            fit_y, test_y = obs_years[:-1], obs_years[-1]
            k_fit = sum(o for s, y, e, o in pairs if y in fit_y) / (sum(e for s, y, e, o in pairs if y in fit_y) or 1)
            test = [(e * k_fit, o) for s, y, e, o in pairs if y == test_y and o >= 1000]
            k_all = sum(o for *_, o in pairs) / (sum(e for s, y, e, o in pairs) or 1)
            calib = {"e2w": {"method": "state e-2W raked to the observed VAHAN state series where available; otherwise maker-share model x k",
                             "k_fit": round(k_fit, 3), "fit_years": fit_y, "test_year": test_y, "test_states": len(test),
                             "test_state_mape": round(sum(abs(p - o) / o for p, o in test) / max(1, len(test)), 3),
                             "test_national_error": round((sum(p for p, o in test) - sum(o for p, o in test)) / max(1, sum(o for p, o in test)), 3),
                             "k": round(k_all, 3)}}
    for i, ms in est.items():
        sid = districts[i]["sid"]
        for mo, v in ms.items():
            o = (state_e2w_obs or {}).get(sid, {}).get(mo[:4]); se = st_y[sid][mo[:4]]
            v["e2w"] = min(v["rem"], v["e2w"] * (o / se if o and se > 0 else k_all))
    # 5. e-4W and e-bus calibration against published national monthly figures (fit on alternate anchor months, test on the rest)
    excl = {"telangana"}
    natm = collections.defaultdict(collections.Counter)
    for i, ms in est.items():
        if districts[i]["sid"] in excl:
            continue
        for mo, v in ms.items():
            natm[mo]["e4w"] += v["e4w"]; natm[mo]["bus"] += v["bus"]
    seg_k = {}; seg_cal = {}
    for seg in ("e4w", "bus"):
        am = sorted(mo for mo in anchors if seg in anchors[mo] and natm[mo][seg] > 0)
        if len(am) < 2:
            continue
        fit_m, test_m = am[0::2], am[1::2]
        k_fit = sum(anchors[mo][seg] for mo in fit_m) / sum(natm[mo][seg] for mo in fit_m)
        errs = [(natm[mo][seg] * k_fit - anchors[mo][seg]) / anchors[mo][seg] for mo in test_m]
        seg_k[seg] = sum(anchors[mo][seg] for mo in am) / sum(natm[mo][seg] for mo in am)
        seg_cal[seg] = {"k_fit": round(k_fit, 3), "fit_months": fit_m, "test_months": test_m,
                        "test_mape": round(sum(abs(e) for e in errs) / len(errs), 3), "k": round(seg_k[seg], 3)}
    if calib is not None:
        calib.update(seg_cal); calib["anchor_source"] = ANCHOR_SOURCE
    for ms in est.values():
        for v in ms.values():
            left = max(0.0, v["rem"] - v["e2w"])
            v["e4w"] = min(left, v["e4w"] * seg_k.get("e4w", 1)); left -= v["e4w"]
            v["bus"] = min(left, v["bus"] * seg_k.get("bus", 1)); left -= v["bus"]
            v["l5"] = left   # e-3W autos/cargo (L5) and anything not otherwise attributed
    # 6. output
    out = {}
    last24 = months[-24:]
    for i, ms in est.items():
        yrs = {}
        for y in years:
            vs = [v for mo, v in ms.items() if mo.startswith(y)]
            if not vs:
                continue
            S = lambda k: sum(v[k] for v in vs)
            yrs[y] = {"ev": round(S("ev")), "e2w": round(S("e2w")), "e3w": round(S("erick") + S("l5")), "erick": round(S("erick")),
                      "e4w": round(S("e4w")), "bus": round(S("bus")), "n": len(vs),
                      "all": {g: round(sum(v["all"][g] for v in vs)) for g in ("e2w", "e3w", "e4w", "bus")}}
        stock = {s: sum(yrs[y][s] for y in yrs) for s in ("ev", "e2w", "e3w", "e4w", "bus")}
        out[i] = {"years": yrs, "stock": stock, "monthly": [round(ms[mo]["ev"]) if mo in ms else 0 for mo in last24]}
    tot = sum(how_ev.values()) or 1
    meta = {"first": months[0], "latest": latest, "months_latest_year": sum(1 for mo in months if mo.startswith(ly)), "rtos": len(ser),
            "aggregates_removed": aggregates,
            "match": {h: {"rtos": how[h], "ev_share": round(how_ev[h] / tot, 4)} for h in how},
            "unmatched_top": [{"ev": round(e), "state": s, "rto": r} for e, s, r in sorted(unmatched, reverse=True)[:25]],
            "calibration": calib, "monthly_labels": last24}
    return out, meta


# ---------------------------------------------------------------------------------------------
# PM E-DRIVE location types from OpenStreetMap (Operational Guidelines 26 Sep 2025, Table 2 and FAQ 1)
# ---------------------------------------------------------------------------------------------
PSU_OMC = re.compile(r"indian\s*oil|\biocl?\b|\bioc\b|bharat\s*petroleum|\bbpcl?\b|hindustan\s*petroleum|\bhpcl?\b|\bhp\s*(petrol|pump|fuel)|^hp$|indianoil", re.I)
AAI = re.compile(r"airports?\s+authority\s+of\s+india|\baai\b", re.I)
SITE_TYPES = ("omc", "fuel", "toll", "rail", "bus", "airport", "gov_office", "gov_hospital", "gov_education")
SITE_CATEGORY = {"omc": "B", "fuel": "C", "toll": "B", "rail": "B", "bus": "B", "airport": "B", "gov_office": "A", "gov_hospital": "A", "gov_education": "A"}


def osm_site_type(tags: dict):
    """(type, category, note) for one OSM element, or None."""
    t = tags or {}
    txt = " ".join(str(t.get(k, "")) for k in ("brand", "operator", "name", "brand:en", "operator:en"))
    if t.get("amenity") == "fuel":
        psu = PSU_OMC.search(txt) or any(str(t.get(k, "")).strip().upper() in ("HP", "IOC", "BPCL", "HPCL", "IOCL") for k in ("brand", "operator"))
        return ("omc", "B", "") if psu else ("fuel", "C", "")
    if t.get("barrier") == "toll_booth":
        return ("toll", "B", "verify NHAI / state control")
    if t.get("railway") == "station":
        return ("rail", "B", "")
    if t.get("amenity") == "bus_station":
        return ("bus", "B", "verify STU-operated")
    if t.get("aeroway") == "aerodrome":
        return ("airport", "B", "") if AAI.search(txt) else ("airport", "C", "not AAI-operated per OSM; Category B applies only to AAI airports")
    if t.get("office") == "government":
        return ("gov_office", "A", "free public access required")
    if t.get("amenity") == "hospital":
        return ("gov_hospital", "A", "free public access required")
    if t.get("amenity") in ("university", "college"):
        return ("gov_education", "A", "free public access required")
    return None


def osm_sites(raw_dir: str):
    """Parse raw/osm_sites.json (Overpass, fetch step 9) into [lat, lon, type, category, name]."""
    path = os.path.join(raw_dir, "osm_sites.json")
    if not os.path.exists(path):
        return None
    out, seen = [], set()
    for e in json.load(open(path, encoding="utf-8")).get("elements", []):
        lat = e.get("lat") or (e.get("center") or {}).get("lat"); lon = e.get("lon") or (e.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        r = osm_site_type(e.get("tags"))
        if not r:
            continue
        key = (r[0], round(lat, 3), round(lon, 3))
        if key in seen:
            continue
        seen.add(key)
        tg = e.get("tags") or {}
        name = (tg.get("name:en") or tg.get("name") or tg.get("brand") or "")[:60]
        out.append([round(lat, 5), round(lon, 5), r[0], r[1], name, r[2]])
    return out


def substation_voltage_class(kv: int):
    """Grid-proxy class used for upstream cost hints: HV (>=66 kV), 33 kV, 11 kV / distribution, unknown."""
    if not kv:
        return "unknown"
    return "hv" if kv >= 66 else "33kv" if kv >= 33 else "11kv"


def add_ev_year(acc, v):
    """Sum two EV year records ({ev, e2w, ..., n, all:{...}}); n (months) is kept, not summed."""
    if acc is None:
        return {**{k: x for k, x in v.items() if k != "all"}, "all": dict(v.get("all", {}))}
    for k, x in v.items():
        if k == "all":
            for g, y in x.items():
                acc["all"][g] = acc["all"].get(g, 0) + y
        elif k == "n":
            acc["n"] = max(acc.get("n", 0), x)
        else:
            acc[k] = acc.get(k, 0) + x
    return acc
