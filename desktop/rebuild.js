/* In-app rebuild of the time-varying data layers, without Python: the same formulas as pipeline/build.py, applied to
 * fresh downloads on top of the current data build. Static layers (Census crosswalk, boundaries, demand cells,
 * GeoNames places, road graph) do not change between builds and are reused.
 *   chargers  reclaimchennai/india-ev-charging-dataset CSV -> districts, statistics, coverage, inventory, charger index
 *   vahan     India Data Portal VAHAN tables (fuel type, vehicle class) by RTO -> districts via the pipeline's RTO map,
 *             segment split with the pipeline's calibrated state-year fractions
 *   osm       OpenStreetMap (Overpass) PM E-DRIVE location types and power substations
 * Output is written to the data overlay (the same place data updates go), so "Revert to bundled data" undoes it. */
"use strict";
const crypto = require("crypto");

const CHARGERS_URL = "https://raw.githubusercontent.com/reclaimchennai/india-ev-charging-dataset/main/data/charging_stations.csv";
const IDP = "https://ckandev.indiadataportal.com/dataset/36ea3632-6ec7-43e6-8579-e8c80f7df640/resource";
const IDP_FUEL = `${IDP}/c9d109c7-8190-4a67-8166-0be1487db419/download/vehicle-registrations-by-fuel-type.csv`;
const IDP_CLASS = `${IDP}/cc32d3e2-7ea3-4b6b-94ab-85e57f6a0a3a/download/registrations-by-vehicle-class.csv`;
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const THRESHOLDS = [5, 10, 25];

/* ---------------- helpers ---------------- */
function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; } else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const num = (x) => { const v = parseFloat(x); return isFinite(v) ? v : null; };
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function hav(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* same rules as pipeline/extras.py */
const TIERS = ["ac_slow", "ac_fast", "dc_fast", "dc_ultra", "unknown"];
const CONNECTORS = [["CCS2", /ccs/i], ["Type 2", /type\s*2/i], ["Bharat AC-001", /ac-?001|bharat\s*ac/i], ["Bharat DC-001", /dc-?001|bharat\s*dc/i], ["3-pin / 15A", /3-?pin|15a/i], ["CHAdeMO", /chademo/i], ["GB/T", /gb\/?t/i], ["Type 6 / LEV", /type\s*6|lev/i]];
function tierOf(kw, ac, dc) { if (kw) return kw <= 7.4 ? "ac_slow" : kw <= 22 && !dc ? "ac_fast" : kw <= 60 ? "dc_fast" : "dc_ultra"; if (dc) return "dc_fast"; if (ac) return "ac_slow"; return "unknown"; }
function chargerInventory(ch) {
  const tiers = Object.fromEntries(TIERS.map(t => [t, 0])), conn = {};
  for (const x of ch) { tiers[tierOf(x[4], x[5], x[6])]++; for (const [n, re] of CONNECTORS) if (re.test(x[12] || "")) conn[n] = (conn[n] || 0) + 1; }
  const known = ch.filter(x => x[5] != null || x[6] != null);
  const ac = known.reduce((s, x) => s + (x[5] || 0), 0), dc = known.reduce((s, x) => s + (x[6] || 0), 0);
  const per = known.length ? (ac + dc) / known.length : null;
  return { tiers, connectors: Object.fromEntries(Object.entries(conn).sort((a, b) => b[1] - a[1])), ac_points: ac, dc_points: dc, points_known_sites: known.length, points_per_site: per ? Math.round(per * 100) / 100 : null };
}
const PRICE = /(\d+(?:\.\d+)?)\s*\/\s*kwh/;
const PSU = /indian\s*oil|\biocl?\b|\bioc\b|bharat\s*petroleum|\bbpcl?\b|hindustan\s*petroleum|\bhpcl?\b|\bhp\s*(petrol|pump|fuel)|indianoil/i;
function siteType(t) {
  t = t || {}; const txt = ["brand", "operator", "name", "brand:en", "operator:en"].map(k => t[k] || "").join(" ");
  if (t.amenity === "fuel") return PSU.test(txt) || ["brand", "operator"].some(k => ["HP", "IOC", "BPCL", "HPCL", "IOCL"].includes(String(t[k] || "").trim().toUpperCase())) ? ["omc", "B", ""] : ["fuel", "C", ""];
  if (t.barrier === "toll_booth") return ["toll", "B", "verify NHAI / state control"];
  if (t.railway === "station") return ["rail", "B", ""];
  if (t.amenity === "bus_station") return ["bus", "B", "verify STU-operated"];
  if (t.aeroway === "aerodrome") return /airports?\s+authority\s+of\s+india|\baai\b/i.test(txt) ? ["airport", "B", ""] : ["airport", "C", "not AAI-operated per OSM; Category B applies only to AAI airports"];
  if (t.office === "government") return ["gov_office", "A", "free public access required"];
  if (t.amenity === "hospital") return ["gov_hospital", "A", "free public access required"];
  if (t.amenity === "university" || t.amenity === "college") return ["gov_education", "A", "free public access required"];
  return null;
}

/* ---------------- district locator ---------------- */
function makeLocator(E, stateFiles) {
  const ds = [];
  for (const st of Object.values(stateFiles)) for (const d of st.districts) ds.push({ id: d.id, sid: st.id, geom: d.geom, bb: E.bbox(d.geom) });
  return function locate(lng, lat, maxDeg = 0.12) {
    let best = null, bd = Infinity;
    for (const d of ds) {
      const [x0, y0, x1, y1] = d.bb;
      if (lng >= x0 && lng <= x1 && lat >= y0 && lat <= y1 && E.pointInGeom(lng, lat, d.geom)) return d;
      const dx = Math.max(x0 - lng, 0, lng - x1), dy = Math.max(y0 - lat, 0, lat - y1), dd = Math.hypot(dx, dy);
      if (dd < bd) { bd = dd; best = d; }
    }
    return bd <= maxDeg ? best : null;
  };
}

/* ---------------- parts ---------------- */
async function rebuildChargers(ctx) {
  const { india, stateFiles, E, fetchText, progress } = ctx;
  progress("chargers", "downloading the charger dataset");
  const csv = await fetchText(CHARGERS_URL, 120000);
  const sha = crypto.createHash("sha256").update(csv).digest("hex");
  const rows = parseCSV(csv);
  progress("chargers", `assigning ${rows.length.toLocaleString("en-IN")} chargers to districts`);
  const locate = makeLocator(E, stateFiles), byD = new Map(), q = { invalid_coords: 0, outside_boundaries: 0, assigned: 0 };
  for (const r of rows) {
    const lat = num(r.lat), lng = num(r.lng);
    if (lat == null || lng == null || !(lat >= 6 && lat <= 37.5 && lng >= 68 && lng <= 98)) { q.invalid_coords++; continue; }
    const d = locate(lng, lat); if (!d) { q.outside_boundaries++; continue; }
    const ac = num(r.ac_points), dc = num(r.dc_points);
    const rec = [r4(lat), r4(lng), String(r.name || "").trim().slice(0, 80), String(r.operator || "").trim().slice(0, 40), num(r.max_power_kw), ac != null ? Math.trunc(ac) : null, dc != null ? Math.trunc(dc) : null,
      String(r.pricing || "").trim().slice(0, 24), Math.trunc(num(r.n_sources) || 1), String(r.last_updated || "").slice(0, 10), String(r.city || "").trim().slice(0, 40),
      String(r.address || "").trim().slice(0, 140), String(r.connectors || "").trim().slice(0, 120), String(r.network || "").trim().slice(0, 30), String(r.sources || "").trim().slice(0, 90)];
    (byD.get(d.id) || byD.set(d.id, []).get(d.id)).push(rec); q.assigned++;
  }
  if (q.assigned < 1000) throw new Error(`only ${q.assigned} chargers could be placed; the source looks wrong, nothing changed`);
  // national index for distances (as the pipeline: every charger counts, including neighbouring districts)
  const pts = []; for (const list of byD.values()) for (const x of list) pts.push({ lat: x[0], lng: x[1] });
  const idx = new E.GridIndex(pts, 0.1);
  progress("chargers", "recomputing coverage for 737 districts");
  const statById = new Map(india.districts.map(d => [d.id, d]));
  for (const st of Object.values(stateFiles)) for (const d of st.districts) {
    const ch = byD.get(d.id) || []; d.chargers = ch;
    const D = statById.get(d.id); if (!D) continue; const s = D.stats;
    let tot = 0, wsum = 0; const cov = Object.fromEntries(THRESHOLDS.map(t => [t, 0]));
    for (const [lon, lat, w] of d.cells) { const n = idx.nearest(lat, lon, 2000); const km = n ? hav(lat, lon, pts[n.i].lat, pts[n.i].lng) : 2000; tot += w; wsum += w * km; for (const t of THRESHOLDS) if (km <= t) cov[t] += w; }
    s.coverage = Object.fromEntries(THRESHOLDS.map(t => [String(t), tot ? Math.round(cov[t] / tot * 1e4) / 1e4 : 0])); s.mean_dist = tot ? Math.round(wsum / tot * 100) / 100 : 0;
    const kws = ch.filter(x => x[4]).map(x => x[4]), prices = ch.map(x => (String(x[7]).toLowerCase().match(PRICE) || [])[1]).filter(Boolean).map(Number);
    const n = ch.length, ops = {}; for (const x of ch) ops[x[3] || "Unknown"] = (ops[x[3] || "Unknown"] || 0) + 1;
    Object.assign(s, {
      chargers: n, dc_sites: ch.filter(x => (x[4] || 0) >= 15 || (x[6] || 0) > 0).length,
      verified: n ? Math.round(ch.filter(x => x[8] >= 2).length / n * 1000) / 1000 : null, power_known: n ? Math.round(kws.length / n * 1000) / 1000 : null,
      median_kw: median(kws), median_price: median(prices), per_lakh: s.pop ? Math.round(n / s.pop * 1e5 * 1000) / 1000 : null,
      per_1k_vehicle_hh: s.vehicle_idx ? Math.round(n / s.vehicle_idx * 1000 * 1000) / 1000 : null, km2_per_charger: n ? Math.round(s.area / n * 10) / 10 : null,
      operators: Object.entries(ops).sort((a, b) => b[1] - a[1]).slice(0, 6), inventory: chargerInventory(ch),
    });
  }
  // state and national roll-ups (as agg() in build.py)
  const agg = (ids) => {
    const D = ids.map(id => statById.get(id)).filter(Boolean), sum = (k) => D.reduce((a, d) => a + (d.stats[k] || 0), 0);
    const ch = ids.flatMap(id => byD.get(id) || []), pops = sum("pop") || 1, kws = ch.filter(x => x[4]).map(x => x[4]);
    const prices = ch.map(x => (String(x[7]).toLowerCase().match(PRICE) || [])[1]).filter(Boolean).map(Number), ops = {};
    for (const x of ch) ops[x[3] || "Unknown"] = (ops[x[3] || "Unknown"] || 0) + 1;
    const c = sum("chargers"), v = sum("vehicle_idx");
    return { chargers: c, dc_sites: sum("dc_sites"), per_lakh: sum("pop") ? Math.round(c / sum("pop") * 1e5 * 1000) / 1000 : null, per_1k_vehicle_hh: v ? Math.round(c / v * 1000 * 1000) / 1000 : null,
      km2_per_charger: c ? Math.round(sum("area") / c * 10) / 10 : null, verified: ch.length ? Math.round(ch.filter(x => x[8] >= 2).length / ch.length * 1000) / 1000 : null,
      median_kw: median(kws), median_price: median(prices), operators: Object.entries(ops).sort((a, b) => b[1] - a[1]).slice(0, 8),
      coverage: Object.fromEntries(THRESHOLDS.map(t => [String(t), Math.round(D.reduce((a, d) => a + d.stats.coverage[String(t)] * d.stats.pop, 0) / pops * 1e4) / 1e4])),
      mean_dist: Math.round(D.reduce((a, d) => a + d.stats.mean_dist * d.stats.pop, 0) / pops * 100) / 100, inventory: chargerInventory(ch) };
  };
  for (const st of india.states) Object.assign(st.stats, agg(india.districts.filter(d => d.sid === st.id).map(d => d.id)));
  Object.assign(india.totals, agg(india.districts.map(d => d.id)));
  const ci = []; for (const list of byD.values()) for (const x of list) ci.push(Math.round(x[0] * 1e4), Math.round(x[1] * 1e4), ((x[4] || 0) >= 15 || (x[6] || 0) > 0 ? 1 : 0) | (x[8] >= 2 ? 2 : 0));
  india.charger_index = ci;
  const src = india.sources.find(s => s.id === "chargers"); if (src) { src.sha256 = sha; src.retrieved = new Date().toISOString().slice(0, 10); }
  return { chargers: q.assigned, ...q, sha };
}

async function rebuildVahan(ctx) {
  const { india, fetchText, progress } = ctx, V = india.vahan_rto;
  if (!V || !V.rto_map || !V.split) throw new Error("this data build has no RTO map; update the data build first");
  const map = new Map(V.rto_map.map(([sid, rto, code, did]) => [`${sid}|${rto}|${code}`, did]));
  const SEG_CLASS = { "M-Cycle/Scooter": 0, "Moped": 0, "Motorised Cycle (CC > 25CC)": 0, "Motor Cycle/Scooter-Used for Hire": 0, "M-Cycle/Scooter-With Side Car": 0, "Motor Cycle/Scooter-Sidecar(T)": 0,
    "Three Wheeler (Passenger)": 1, "Three Wheeler (Goods)": 1, "Three Wheeler (Personal)": 1, "E-Rickshaw(P)": 1, "E-Rickshaw With Cart (G)": 1,
    "Motor Car": 2, "Motor Cab": 2, "Maxi Cab": 2, "Luxury Cab": 2, "Quadricycle (Commercial)": 2, "Bus": 3, "Educational Institution Bus": 3, "Omni Bus": 3, "Omni Bus (Private Use)": 3, "School Bus": 3 };
  const ALIAS = { "andaman-nicobar-island": "andaman-and-nicobar-islands", "ut-of-dnh-and-dd": "dadra-and-nagar-haveli-and-daman-and-diu" };
  const sidOf = (n) => { const s = slug(n); return ALIAS[s] || s; };
  const agg = new Map();   // key -> month -> [ev, erick, a2, a3, a4, abus]
  const rec = (k, mo) => { let m = agg.get(k); if (!m) agg.set(k, m = new Map()); let v = m.get(mo); if (!v) m.set(mo, v = [0, 0, 0, 0, 0, 0]); return v; };
  progress("vahan", "downloading VAHAN fuel-type table (~45 MB)");
  for (const r of parseCSV(await fetchText(IDP_FUEL, 600000))) if (["Electric(BOV)", "Pure EV", "Plug-in Hybrid EV"].includes(r.registration_type)) rec(`${sidOf(r.state_name)}|${r.rto.trim()}|${r.rto_code}`, r.date.slice(0, 7))[0] += Math.trunc(num(r.registrations) || 0);
  progress("vahan", "downloading VAHAN vehicle-class table (~85 MB)");
  for (const r of parseCSV(await fetchText(IDP_CLASS, 900000))) {
    const k = `${sidOf(r.state_name)}|${r.rto.trim()}|${r.rto_code}`, mo = r.date.slice(0, 7), n = Math.trunc(num(r.registrations) || 0);
    if (r.registration_type === "E-Rickshaw(P)" || r.registration_type === "E-Rickshaw With Cart (G)") rec(k, mo)[1] += n;
    const sg = SEG_CLASS[r.registration_type]; if (sg != null) rec(k, mo)[2 + sg] += n;
  }
  progress("vahan", "allocating RTOs to districts");
  const monthTot = new Map(); for (const m of agg.values()) for (const [mo, v] of m) monthTot.set(mo, (monthTot.get(mo) || 0) + v[0]);
  const removed = [];
  for (const [k, m] of agg) for (const [mo, v] of m) if (v[0] > 1000 && v[0] > 0.4 * (monthTot.get(mo) - v[0])) { removed.push(k); agg.delete(k); break; }
  const months = [...new Set([...agg.values()].flatMap(m => [...m.keys()]))].sort(), latest = months[months.length - 1];
  const dm = new Map(), pool = new Map(), byState = new Map();
  for (const d of india.districts) (byState.get(d.sid) || byState.set(d.sid, []).get(d.sid)).push(d.id);
  const add = (target, key, mo, v, f = 1) => { let m = target.get(key); if (!m) target.set(key, m = new Map()); let a = m.get(mo); if (!a) m.set(mo, a = [0, 0, 0, 0, 0, 0]); a[0] += v[0] * f; a[1] += Math.min(v[1], v[0]) * f; for (let j = 2; j < 6; j++) a[j] += v[j] * f; };
  let unmatched = 0;
  for (const [k, m] of agg) { const did = map.get(k); const sid = k.split("|")[0]; for (const [mo, v] of m) did ? add(dm, did, mo, v) : add(pool, sid, mo, v); if (!did) unmatched++; }
  for (const [sid, m] of pool) {
    const ids = byState.get(sid) || []; if (!ids.length) continue;
    const w = ids.map(id => [...(dm.get(id) || new Map()).values()].reduce((a, v) => a + v[0], 0)), tw = w.reduce((a, b) => a + b, 0) || ids.length;
    ids.forEach((id, i) => { const f = (tw === ids.length ? 1 : w[i]) / tw; for (const [mo, v] of m) add(dm, id, mo, v, f); });
  }
  const years = [...new Set(months.map(m => m.slice(0, 4)))], last24 = months.slice(-24);
  const splitFor = (sid, y) => { const s = V.split[sid] || {}; if (s[y]) return s[y]; const ys = Object.keys(s).sort(); return ys.length ? s[ys[ys.length - 1]] : [0.6, 0.3, 0.09, 0.01]; };
  const statById = new Map(india.districts.map(d => [d.id, d.stats]));
  for (const [id, m] of dm) {
    const st = statById.get(id); if (!st) continue; const sid = id.split(".")[0], yrs = {};
    for (const y of years) {
      const vs = [...m].filter(([mo]) => mo.startsWith(y)).map(([, v]) => v); if (!vs.length) continue;
      const S = (j) => vs.reduce((a, v) => a + v[j], 0), ev = S(0), er = S(1), rem = Math.max(0, ev - er), f = splitFor(sid, y);
      yrs[y] = { ev: Math.round(ev), e2w: Math.round(rem * f[0]), e3w: Math.round(er + rem * f[1]), erick: Math.round(er), e4w: Math.round(rem * f[2]), bus: Math.round(rem * f[3]), n: vs.length,
        all: { e2w: Math.round(S(2)), e3w: Math.round(S(3)), e4w: Math.round(S(4)), bus: Math.round(S(5)) } };
    }
    const stock = Object.fromEntries(["ev", "e2w", "e3w", "e4w", "bus"].map(k => [k, Object.values(yrs).reduce((a, y) => a + y[k], 0)]));
    st.ev = { years: yrs, stock, monthly: last24.map(mo => Math.round((m.get(mo) || [0])[0])) };
  }
  const addYear = (acc, v) => { if (!acc) return { ...v, all: { ...v.all } }; for (const [k, x] of Object.entries(v)) { if (k === "all") for (const [g, y] of Object.entries(x)) acc.all[g] = (acc.all[g] || 0) + y; else if (k === "n") acc.n = Math.max(acc.n || 0, x); else acc[k] = (acc[k] || 0) + x; } return acc; };
  const nat = {};
  for (const s of india.states) {
    const ids = byState.get(s.id) || [], ys = {};
    for (const id of ids) for (const [y, v] of Object.entries((statById.get(id).ev || {}).years || {})) ys[y] = addYear(ys[y], v);
    s.stats.ev = { years: ys, monthly: last24.map((_, k) => ids.reduce((a, id) => a + (((statById.get(id).ev || {}).monthly || [])[k] || 0), 0)) };
    for (const [y, v] of Object.entries(ys)) nat[y] = addYear(nat[y], v);
  }
  india.ev_national = { years: nat };
  Object.assign(V, { first: months[0], latest, months_latest_year: months.filter(m => m.startsWith(latest.slice(0, 4))).length, monthly_labels: last24, local_rebuild: { at: new Date().toISOString(), unmatched_rtos: unmatched, aggregates_removed: removed.length } });
  const src = india.sources.find(s => s.id === "vahan_rto"); if (src) { src.observed = `${months[0]} to ${latest}`; src.retrieved = new Date().toISOString().slice(0, 10); src.title = src.title.replace(/\d{4}-\d{2} to \d{4}-\d{2}/, `${months[0]} to ${latest}`); }
  return { months: months.length, latest, districts: dm.size, unmatched_rtos: unmatched };
}

async function rebuildOSM(ctx) {
  const { india, stateFiles, E, overpass, progress } = ctx;
  progress("osm", "querying OpenStreetMap for PM E-DRIVE location types (1-5 min)");
  const Q = `[out:json][timeout:900];area["ISO3166-1"="IN"][admin_level=2]->.in;(node["amenity"="fuel"](area.in);way["amenity"="fuel"](area.in);node["barrier"="toll_booth"](area.in);way["barrier"="toll_booth"](area.in);node["railway"="station"](area.in);node["amenity"="bus_station"](area.in);way["amenity"="bus_station"](area.in);node["aeroway"="aerodrome"]["iata"](area.in);way["aeroway"="aerodrome"]["iata"](area.in);node["office"="government"](area.in);way["office"="government"](area.in);way["amenity"="hospital"]["operator:type"~"government|public"](area.in);node["amenity"="hospital"]["operator:type"~"government|public"](area.in);way["amenity"~"university|college"]["operator:type"~"government|public"](area.in););out center tags;`;
  const j = JSON.parse(await overpass(Q));
  const els = j.elements || []; if (els.length < 5000) throw new Error(`Overpass returned only ${els.length} elements; nothing changed`);
  const locate = makeLocator(E, stateFiles), byD = new Map(), seen = new Set(); let n = 0;
  for (const e of els) {
    const lat = e.lat ?? (e.center || {}).lat, lon = e.lon ?? (e.center || {}).lon; if (lat == null || lon == null) continue;
    const t = siteType(e.tags); if (!t) continue;
    const key = `${t[0]}|${lat.toFixed(3)}|${lon.toFixed(3)}`; if (seen.has(key)) continue; seen.add(key);
    const d = locate(lon, lat, 0.02); if (!d) continue;
    const tg = e.tags || {};
    (byD.get(d.id) || byD.set(d.id, []).get(d.id)).push([Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, t[0], t[1], String(tg["name:en"] || tg.name || tg.brand || "").slice(0, 60), t[2]]); n++;
  }
  const statById = new Map(india.districts.map(d => [d.id, d.stats]));
  for (const st of Object.values(stateFiles)) for (const d of st.districts) {
    d.sites = byD.get(d.id) || []; const c = {}; for (const x of d.sites) c[x[2]] = (c[x[2]] || 0) + 1; if (statById.get(d.id)) statById.get(d.id).sites = c;
  }
  for (const s of india.states) { const c = {}; for (const d of india.districts.filter(x => x.sid === s.id)) for (const [k, v] of Object.entries(d.stats.sites || {})) c[k] = (c[k] || 0) + v; s.stats.sites = c; }
  const now = new Date().toISOString().slice(0, 10);
  const src = india.sources.find(s => s.id === "osm_sites");
  if (src) src.retrieved = now;
  else india.sources.push({ id: "osm_sites", title: "PM E-DRIVE location types: PSU OMC and other fuel outlets, toll plazas, railway and bus stations, airports, government premises", publisher: "OpenStreetMap contributors (Overpass API)", url: "https://www.openstreetmap.org", licence: "ODbL 1.0", observed: "snapshot", retrieved: now, kind: "observed", limits: "OSM coverage varies by region. Category follows the guideline wording from OSM tags; the nodal agency decides the final category (FAQ 2)." });
  return { sites: n };
}

/** run the selected parts; returns { india, stateFiles, report } with the new version stamped */
async function rebuild({ india, stateFiles, E, fetchText, overpass, parts, progress = () => {} }) {
  const ctx = { india, stateFiles, E, fetchText, overpass, progress }, report = {};
  if (parts.includes("chargers")) report.chargers = await rebuildChargers(ctx);
  if (parts.includes("vahan")) report.vahan = await rebuildVahan(ctx);
  if (parts.includes("osm")) report.osm = await rebuildOSM(ctx);
  const hash = crypto.createHash("sha256").update(JSON.stringify(india.sources.map(s => s.sha256 || s.retrieved)) + JSON.stringify(report)).digest("hex").slice(0, 6);
  const d = new Date(), version = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}-${hash}`;
  india.previous_version = india.version; india.version = version; india.built = d.toISOString().slice(0, 16) + "Z";
  india.local_rebuild = { at: d.toISOString(), parts, report };
  return { india, stateFiles, report, version };
}

module.exports = { rebuild, parseCSV, chargerInventory, siteType, tierOf };
