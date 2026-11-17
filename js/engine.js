/* ReachGrid engine: reachability, candidate generation, scoring, budget-constrained optimisation,
 * baselines, sensitivity and corridor analysis. Pure functions, no DOM; runs in browser and Node.
 * Methodology: proposal §6 and Appendix A. */
(function (root) {
  "use strict";
  const R = 6371.0088, D2R = Math.PI / 180;

  function hav(lat1, lon1, lat2, lon2) {
    const dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* ---------- spatial grid index for points {lat, lng} ---------- */
  class GridIndex {
    constructor(points, cellDeg = 0.1) {
      this.c = cellDeg; this.pts = points; this.m = new Map();
      points.forEach((p, i) => {
        const k = this.key(p.lat, p.lng);
        let b = this.m.get(k); if (!b) this.m.set(k, (b = [])); b.push(i);
      });
    }
    key(lat, lng) { return Math.floor(lat / this.c) + ":" + Math.floor(lng / this.c); }
    /** nearest point; returns {i, d} (km) or null. maxKm bounds the search */
    nearest(lat, lng, maxKm = 2000, filter) {
      if (!this.pts.length) return null;
      const gy = Math.floor(lat / this.c), gx = Math.floor(lng / this.c);
      let best = null;
      const cellKm = this.c * 111.32 * Math.max(0.2, Math.cos(lat * D2R));
      const maxRing = Math.ceil(maxKm / cellKm) + 1;
      for (let r = 0; r <= maxRing; r++) {
        for (let y = gy - r; y <= gy + r; y++) {
          for (let x = gx - r; x <= gx + r; x++) {
            if (r && Math.abs(y - gy) !== r && Math.abs(x - gx) !== r) continue;
            const b = this.m.get(y + ":" + x); if (!b) continue;
            for (const i of b) {
              const p = this.pts[i]; if (filter && !filter(p)) continue;
              const d = hav(lat, lng, p.lat, p.lng);
              if (d <= maxKm && (!best || d < best.d)) best = { i, d };
            }
          }
        }
        if (best && best.d < (r - 0.5) * cellKm) break; // nothing closer can exist in outer rings
      }
      return best;
    }
    within(lat, lng, km) {
      const out = [];
      const dy = Math.ceil(km / (this.c * 111.32)) , dx = Math.ceil(km / (this.c * 111.32 * Math.max(0.2, Math.cos(lat * D2R))));
      const gy = Math.floor(lat / this.c), gx = Math.floor(lng / this.c);
      for (let y = gy - dy; y <= gy + dy; y++) for (let x = gx - dx; x <= gx + dx; x++) {
        const b = this.m.get(y + ":" + x); if (!b) continue;
        for (const i of b) { const p = this.pts[i]; const d = hav(lat, lng, p.lat, p.lng); if (d <= km) out.push({ i, d }); }
      }
      return out;
    }
  }

  /* ---------- geometry ---------- */
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInGeom(x, y, g) {
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      if (pointInRing(x, y, poly[0])) {
        let hole = false;
        for (let h = 1; h < poly.length; h++) if (pointInRing(x, y, poly[h])) { hole = true; break; }
        if (!hole) return true;
      }
    }
    return false;
  }
  function bbox(g) {
    let a = [180, 90, -180, -90];
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const p of polys) for (const [x, y] of p[0]) { a[0] = Math.min(a[0], x); a[1] = Math.min(a[1], y); a[2] = Math.max(a[2], x); a[3] = Math.max(a[3], y); }
    return a;
  }
  /** distance (km) from point to polyline, approximate (local equirectangular) */
  function distToLine(lat, lng, coords) {
    const kx = 111.32 * Math.cos(lat * D2R), ky = 110.57;
    let best = Infinity;
    for (let i = 1; i < coords.length; i++) {
      const ax = (coords[i - 1][0] - lng) * kx, ay = (coords[i - 1][1] - lat) * ky;
      const bx = (coords[i][0] - lng) * kx, by = (coords[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let t = L ? -(ax * dx + ay * dy) / L : 0; t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy; best = Math.min(best, Math.hypot(px, py));
    }
    return best;
  }

  /* ---------- defaults (documented assumptions, editable in the UI) ---------- */
  const DEFAULTS = {
    tauKm: 10,
    detour: 1.3,                          // road circuity multiplier on straight-line distance (assumption)
    weights: { gap: 0.30, pressure: 0.25, corridor: 0.20, equity: 0.15, feasibility: 0.10 }, // proposal §6.3
    hardware: "dc60",
    hardwareCost: { dc60: 32, dc30: 18, ac22: 6 },                 // ₹ lakh per site, equipment + install (assumption)
    siteCost: { highway: 8, town: 5, hotspot: 6 },                 // ₹ lakh civil / lease / grid connection (assumption)
    budgetLakh: 250,
    budgetStateLakh: 2500,
    metric: "straight",                   // straight | network (coarse highway graph)
    commercial: { evShare: 0.03, sessionsPerEvWeek: 0.5, kwhPerSession: 18, marginPerKwh: 6, opexLakhYr: 2.5 }, // hypotheses
    chargerFilter: "all",                  // all | dc | verified
  };

  /* ---------- region model ---------- */
  /**
   * cells: [[lon, lat, pop]] demand cells; chargers: [{lat,lng,dc,verified}] (includes neighbours);
   * vehicleRate: vehicle-households per person (district census) per cell index (array) for pressure.
   */
  function baseline(cells, chargerIdx, opts) {
    const tau = opts.tauKm, det = opts.detour;
    const dist = new Float64Array(cells.length);
    let tot = 0, cov = 0, wsum = 0;
    for (let i = 0; i < cells.length; i++) {
      const [lon, lat, w] = cells[i];
      const n = chargerIdx.nearest(lat, lon, 600);
      dist[i] = n ? n.d * det : Infinity;
      tot += w; if (dist[i] <= tau) cov += w; if (isFinite(dist[i])) wsum += w * dist[i];
    }
    return { dist, total: tot, covered: cov, coverage: tot ? cov / tot : 0, meanDist: tot ? wsum / tot : 0 };
  }

  function histogram(cells, dist, edges = [0, 2, 5, 10, 15, 25, 50, Infinity]) {
    const h = new Array(edges.length - 1).fill(0); let tot = 0;
    cells.forEach((c, i) => { tot += c[2]; for (let k = 0; k < edges.length - 1; k++) if (dist[i] >= edges[k] && dist[i] < edges[k + 1]) { h[k] += c[2]; break; } });
    return { edges, values: h, total: tot };
  }

  /**
   * Candidate sites. ctx: {cells, base, places:[[name,lon,lat,pop]], roads:[[type,[[lon,lat]...]]], geoms:[geometry], chargerIdx}
   */
  function generateCandidates(ctx, opts) {
    const { cells, base, places, roads, geoms, chargerIdx } = ctx;
    const inside = (x, y) => geoms.some(g => pointInGeom(x, y, g));
    const byType = { site: [], town: [], highway: [], hotspot: [] };
    const buckets = new Map(), B = 0.02;              // ~2 km buckets for de-duplication
    const add = (c) => {
      const gy = Math.floor(c.lat / B), gx = Math.floor(c.lng / B);
      for (let y = gy - 1; y <= gy + 1; y++) for (let x = gx - 1; x <= gx + 1; x++) {
        const b = buckets.get(y + ":" + x); if (!b) continue;
        for (const o of b) if (hav(o.lat, o.lng, c.lat, c.lng) < 1.5) return;
      }
      const k = gy + ":" + gx; (buckets.get(k) || buckets.set(k, []).get(k)).push(c);
      byType[c.site ? "site" : c.host].push(c);
    };
    // 0. real PM E-DRIVE location types (PSU OMC outlets, toll plazas, stations, airports, govt premises) in or near
    //    under-served demand, without a listed charger within 300 m. Category A/B first: they win de-duplication.
    const SITE_LABEL = { omc: "PSU fuel outlet", fuel: "Fuel outlet", toll: "Toll plaza", rail: "Railway station", bus: "Bus station", airport: "Airport", gov_office: "Govt. office", gov_hospital: "Govt. hospital", gov_education: "Govt. college / university" };
    const cellIdx0 = new GridIndex(cells.map(c => ({ lat: c[1], lng: c[0] })), 0.05);
    const sites = (ctx.sites || []).filter(x => inside(x[1], x[0]) && !chargerIdx.nearest(x[0], x[1], 0.3))
      .map(x => { const near = cellIdx0.within(x[0], x[1], opts.tauKm / opts.detour); let gap = 0; for (const n of near) if (base.dist[n.i] > opts.tauKm) gap += cells[n.i][2]; return { x, gap }; })
      .filter(o => o.gap > 0 || o.x[2] === "toll" || o.x[2] === "omc")
      .sort((a, b) => (a.x[3] > b.x[3] ? 1 : a.x[3] < b.x[3] ? -1 : 0) || b.gap - a.gap);
    for (const { x } of sites) add({ lat: x[0], lng: x[1], host: x[2], label: (x[4] ? x[4] + " · " : "") + SITE_LABEL[x[2]], site: { type: x[2], cat: x[3], name: x[4], note: x[5] } });
    // 1. towns without a charger within 1 km (largest first)
    for (const [name, lon, lat, pop] of [...places].sort((a, b) => b[3] - a[3])) {
      if (pop < 2000) continue;
      if (chargerIdx.nearest(lat, lon, 1.0)) continue;
      add({ lat, lng: lon, host: "town", label: `${name} town centre`, place: name, placePop: pop, placeDist: 0 });
    }
    // 2. corridor points every ~8 km along major roads inside the region, >3 km from any charger
    for (const [type, coords] of roads) {
      if (type > 2) continue;
      let acc = 0;
      for (let i = 1; i < coords.length; i++) {
        const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
        const seg = hav(y0, x0, y1, x1); let t = 8 - acc;
        while (t <= seg) {
          const f = t / seg, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
          if (inside(x, y) && !chargerIdx.nearest(y, x, 3)) add({ lat: y, lng: x, host: "highway", label: type === 1 ? "Major highway site" : "Highway site" });
          t += 8;
        }
        acc = (acc + seg) % 8;
      }
    }
    // 3. demand hotspots: most populous unserved cells
    const nHot = Math.max(80, Math.round(cells.length / 40));
    const idx = cells.map((c, i) => i).filter(i => base.dist[i] > opts.tauKm * 0.6).sort((a, b) => cells[b][2] - cells[a][2] || a - b).slice(0, nHot);
    for (const i of idx) add({ lat: cells[i][1], lng: cells[i][0], host: "hotspot", label: "Demand hotspot" });
    // balanced cap: interleave types so no single type crowds out the others
    const cap = opts.maxCands || 2500, out = [];
    for (let k = 0; out.length < cap && (k < byType.site.length || k < byType.town.length || k < byType.highway.length || k < byType.hotspot.length); k++)
      for (const t of ["site", "hotspot", "highway", "town"]) if (byType[t][k] && out.length < cap) out.push(byType[t][k]);
    // nearest town for labelling (indexed)
    const pIdx = new GridIndex(places.map(p => ({ lat: p[2], lng: p[1], p })), 0.1);
    for (const c of out) {
      if (c.host === "town" || c.site) continue;
      const n = pIdx.nearest(c.lat, c.lng, 60);
      if (n) { const p = pIdx.pts[n.i].p; c.place = p[0]; c.placeDist = n.d; c.label += n.d < 1 ? ` · ${p[0]}` : ` · ${n.d.toFixed(1)} km from ${p[0]}`; }
    }
    out.sort((a, b) => a.lat - b.lat || a.lng - b.lng);   // deterministic ids, independent of generation order
    out.forEach((c, i) => { c.id = "C" + String(i + 1).padStart(4, "0"); });
    return out;
  }

  function siteCost(c, opts) {
    if (c.costOverride != null) return c.costOverride;
    return opts.hardwareCost[opts.hardware] + (opts.siteCost[c.host] ?? opts.siteCost.town);
  }

  /** score candidates (proposal §6.3) with renormalisation for unavailable components */
  function scoreCandidates(cands, ctx, opts) {
    const { cells, base, roads, vehicleRate } = ctx;
    const tau = opts.tauKm, det = opts.detour;
    const cellPts = cells.map(c => ({ lat: c[1], lng: c[0] }));
    const cellIdx = new GridIndex(cellPts, 0.05);
    const majorRoads = roads.filter(r => r[0] <= 2).map(r => r[1]);
    for (const c of cands) {
      const near = cellIdx.within(c.lat, c.lng, tau / det);
      c.reach = near.map(n => [n.i, n.d * det]);
      let gap = 0, vh = 0, equity = 0;
      for (const [i, d] of c.reach) {
        const w = cells[i][2];
        vh += w * (vehicleRate[i] || 0);
        if (base.dist[i] > tau) { gap += w; equity += w * Math.min(3, base.dist[i] / tau); }
      }
      const localChargers = ctx.chargerIdx.within(c.lat, c.lng, tau / det).length;
      let road = Infinity; for (const l of majorRoads) road = Math.min(road, distToLine(c.lat, c.lng, l));
      // electricity infrastructure proximity: substations (preferred) or power plants (fallback proxy)
      let gridKm = null, gridScore = null;
      if (ctx.gridIdx) {
        const reachKm = ctx.gridIdx.kind === "substation" ? 15 : 80;
        const g = ctx.gridIdx.nearest(c.lat, c.lng, 150);
        gridKm = g ? g.d : null; gridScore = g ? Math.max(0, 1 - g.d / reachKm) : 0;
      }
      const SITE_FEAS = { omc: 0.85, toll: 0.8, rail: 0.75, bus: 0.75, airport: 0.75, gov_office: 0.8, gov_hospital: 0.75, gov_education: 0.8, fuel: 0.7 };
      const hostFeas = c.site ? SITE_FEAS[c.site.type] ?? 0.7 : c.host === "highway" ? (c.placeDist != null && c.placeDist < 3 ? 0.75 : 0.6) : c.host === "town" ? 0.65 : null;
      c.raw = {
        gap, equity,
        pressure: vh / (1 + localChargers),
        vehicleHH: vh, localChargers,
        corridor: Math.max(0, 1 - road / 10), roadKm: road,
        feasibility: c.evFeas != null ? c.evFeas : gridScore == null ? hostFeas : hostFeas == null ? 0.8 * gridScore : 0.6 * hostFeas + 0.4 * gridScore,
        gridKm, gridScore,
      };
      c.cost = siteCost(c, opts);
    }
    const keys = ["gap", "pressure", "corridor", "equity", "feasibility"];
    const max = {}; keys.forEach(k => { max[k] = Math.max(1e-9, ...cands.map(c => c.raw[k] == null ? 0 : c.raw[k])); });
    for (const c of cands) {
      let s = 0, wsum = 0; c.comp = {}; c.missing = [];
      for (const k of keys) {
        const w = opts.weights[k];
        if (c.raw[k] == null) { c.missing.push(k); continue; }
        const v = k === "corridor" || k === "feasibility" ? c.raw[k] * 100 : (c.raw[k] / max[k]) * 100;
        c.comp[k] = v; s += w * v; wsum += w;
      }
      c.score = wsum ? s / wsum : 0;   // renormalised over available components (proposal §6.3)
    }
    return cands;
  }

  function confidenceFor(c, ctx) {
    // data-quality rubric: census provenance, charger cross-verification nearby, distance-metric proxy
    const parts = [];
    parts.push(["Census demand", ctx.censusFlag === "observed" ? 1 : 0.6, ctx.censusFlag === "observed" ? "Census 2011, one-to-one district" : "Census 2011 apportioned to new district"]);
    const near = ctx.chargerIdx.within(c.lat, c.lng, 15).map(n => ctx.chargerIdx.pts[n.i]);
    const ver = near.length ? near.filter(p => p.verified).length / near.length : 0.5;
    parts.push(["Charger listings nearby", 0.4 + 0.6 * ver, near.length ? `${Math.round(ver * 100)}% of ${near.length} nearby sites in ≥2 sources` : "no nearby listings"]);
    parts.push(["Distance metric", ctx.metric === "network" ? 0.7 : 0.6, ctx.metric === "network" ? "routed on coarse highway graph" : "straight line × detour factor (no road routing)"]);
    parts.push(["Host feasibility", c.evidence ? (c.evidence.status === "ok" ? 0.95 : 0.5) : c.raw.feasibility == null ? 0.3 : 0.6,
      c.evidence ? `field evidence: ${c.evidence.status}${c.evidence.grid_kva ? `, ${c.evidence.grid_kva} kVA` : ""}${c.evidence.land ? `, land ${c.evidence.land}` : ""}` : c.raw.feasibility == null ? "host unknown, needs survey" : `host ${c.host === "hotspot" ? "unknown" : "inferred"}${c.raw.gridKm != null ? `; nearest ${ctx.gridIdx.kind === "substation" ? "substation" : "power plant"} ${c.raw.gridKm.toFixed(1)} km` : ""}; spare capacity unknown`]);
    const v = parts.reduce((a, p) => a + p[1], 0) / parts.length;
    return { value: v, grade: v >= 0.72 ? "High" : v >= 0.55 ? "Medium" : "Low", parts };
  }

  /* ---------- optimisation (Appendix A) ---------- */
  function evaluate(cells, base, selected, opts) {
    const d = Float64Array.from(base.dist);
    for (const c of selected) for (const [i, km] of c.reach) if (km < d[i]) d[i] = km;
    let cov = 0, tot = 0, ws = 0, far = 0, farCov = 0;
    const med = cells.map(c => c[2]).sort((a, b) => a - b)[Math.floor(cells.length / 2)] || 0;
    let dense = 0, denseCov = 0, sparse = 0, sparseCov = 0;
    for (let i = 0; i < cells.length; i++) {
      const w = cells[i][2]; tot += w; if (d[i] <= opts.tauKm) cov += w; if (isFinite(d[i])) ws += w * d[i];
      if (base.dist[i] > 2 * opts.tauKm) { far += w; if (d[i] <= opts.tauKm) farCov += w; }
      if (w > med) { dense += w; if (d[i] <= opts.tauKm) denseCov += w; } else { sparse += w; if (d[i] <= opts.tauKm) sparseCov += w; }
    }
    const cost = selected.reduce((a, c) => a + c.cost, 0);
    const newly = cov - base.covered;
    return {
      coverage: tot ? cov / tot : 0, covered: cov, newlyCovered: newly, meanDist: tot ? ws / tot : 0,
      cost, sites: selected.length, costPerPerson: newly > 0 ? (cost * 1e5) / newly : null,
      worstServed: far ? farCov / far : null, farPop: far, dist: d,
      denseCoverage: dense ? denseCov / dense : null, sparseCoverage: sparse ? sparseCov / sparse : null,
      equityGap: dense && sparse ? denseCov / dense - sparseCov / sparse : null,
    };
  }

  function greedy(cells, base, cands, opts, mode = "gain", ctx = null) {
    if (mode === "commercial") return commercialGreedy(cells, base, cands, opts, ctx);
    if (mode === "corridor") cands = cands.filter(c => c.host === "highway" || (c.raw && c.raw.roadKm < 2));
    const tau = opts.tauKm, B = opts.budgetLakh;
    const d = Float64Array.from(base.dist);
    const chosen = [], steps = [], used = new Set();
    let remaining = B, catA = 0;
    const capA = opts.catACap != null ? opts.catACap : Infinity;   // PM E-DRIVE FAQ 1: Category A ≤ ~20% of requested subsidy
    const isA = (c) => c.pm && c.pm.category === "A";
    const weightOf = (i) => mode === "equity" ? cells[i][2] * (1 + Math.min(3, base.dist[i] / tau)) : cells[i][2];
    for (;;) {
      let best = null;
      for (const c of cands) {
        if (used.has(c.id) || c.cost > remaining + 1e-9 || c.blocked) continue;
        if (isA(c) && catA + c.pm.subsidy > capA + 1e-9) continue;
        let g = 0;
        for (const [i, km] of c.reach) if (d[i] > tau && km <= tau) g += weightOf(i);
        if (g <= 0) continue;
        const r = g / c.cost;
        if (!best || r > best.r || (r === best.r && c.id < best.c.id)) best = { c, g, r };
      }
      if (!best) break;
      used.add(best.c.id); chosen.push(best.c); remaining -= best.c.cost; if (isA(best.c)) catA += best.c.pm.subsidy;
      for (const [i, km] of best.c.reach) if (km < d[i]) d[i] = km;
      steps.push({ id: best.c.id, gain: best.g, ratio: best.r, remaining });
    }
    // modified greedy (Khuller, Moss & Naor 1999): the better of the ratio-greedy set and the best single affordable site.
    // For budgeted maximum coverage (monotone submodular) this is guaranteed >= ½(1 − 1/e) ≈ 31.6% of the optimum;
    // with equal site costs plain greedy is guaranteed >= (1 − 1/e) ≈ 63.2%. The ILP in Compare gives the instance gap.
    let total = 0; for (const s of steps) total += s.gain;
    let single = null;
    for (const c of cands) {
      if (c.cost > B + 1e-9 || c.blocked || (isA(c) && c.pm.subsidy > capA + 1e-9)) continue;
      let g = 0; for (const [i, km] of c.reach) if (base.dist[i] > tau && km <= tau) g += weightOf(i);
      if (!single || g > single.g) single = { c, g };
    }
    const uniform = cands.length > 0 && cands.every(c => Math.abs(c.cost - cands[0].cost) < 1e-9);
    const guarantee = { gain: total, bound: uniform ? 1 - 1 / Math.E : 0.5 * (1 - 1 / Math.E), basis: uniform ? "greedy, equal costs: ≥ (1 − 1/e) of optimum" : "modified greedy, budgeted costs: ≥ ½(1 − 1/e) of optimum", usedSingle: false };
    if (single && single.g > total + 1e-9) {
      guarantee.usedSingle = true; guarantee.gain = single.g;
      return { selected: [single.c], steps: [{ id: single.c.id, gain: single.g, ratio: single.g / single.c.cost, remaining: B - single.c.cost }], guarantee };
    }
    return { selected: chosen, steps, guarantee };
  }

  /** commercial screening: maximise vehicle-household demand captured per ₹, sharing each cell's demand
   *  equally among all chargers that reach it (existing + already selected). Coverage is not the goal. */
  function competitorCounts(ctx, opts) {
    const key = opts.tauKm + "|" + opts.detour;
    if (ctx._comp && ctx._compKey === key) return ctx._comp;
    const comp = new Uint16Array(ctx.cells.length);
    ctx.cells.forEach((c, i) => { comp[i] = Math.min(65535, ctx.chargerIdx.within(c[1], c[0], opts.tauKm / opts.detour).length); });
    ctx._comp = comp; ctx._compKey = key; return comp;
  }
  function commercialGreedy(cells, base, cands, opts, ctx) {
    const tau = opts.tauKm, comp = competitorCounts(ctx, opts), sel = new Uint16Array(cells.length);
    const vh = (i) => cells[i][2] * (ctx.vehicleRate[i] || 0);
    const chosen = [], steps = [], used = new Set(); let remaining = opts.budgetLakh;
    for (;;) {
      let best = null;
      for (const c of cands) {
        if (used.has(c.id) || c.cost > remaining + 1e-9 || c.blocked) continue;
        let g = 0; for (const [i, km] of c.reach) if (km <= tau) g += vh(i) / (comp[i] + sel[i] + 1);
        const r = g / c.cost;
        if (g > 0 && (!best || r > best.r || (r === best.r && c.id < best.c.id))) best = { c, g, r };
      }
      if (!best) break;
      used.add(best.c.id); chosen.push(best.c); remaining -= best.c.cost; best.c.capture = best.g;
      for (const [i, km] of best.c.reach) if (km <= tau) sel[i]++;
      steps.push({ id: best.c.id, gain: best.g, ratio: best.r, remaining, unit: "vehicle households captured" });
    }
    return { selected: chosen, steps };
  }

  function byRank(cands, opts, key) {
    const sorted = [...cands].sort((a, b) => key(b) - key(a) || (a.id < b.id ? -1 : 1));
    let rem = opts.budgetLakh; const sel = [];
    for (const c of sorted) if (!c.blocked && c.cost <= rem + 1e-9 && key(c) > 0) { sel.push(c); rem -= c.cost; }
    return { selected: sel, steps: [] };
  }

  function runScenarios(ctx, cands, opts) {
    const { cells, base } = ctx;
    const plans = {
      greedy: { name: "Greedy marginal gain per ₹", objective: "coverage", ...greedy(cells, base, cands, opts, "gain") },
      equity: { name: "Equity-weighted greedy", objective: "equity", ...greedy(cells, base, cands, opts, "equity") },
      corridor: { name: "Corridor reach (highway sites)", objective: "corridor", ...greedy(cells, base, cands, opts, "corridor") },
      commercial: { name: "Commercial screening", objective: "commercial", ...greedy(cells, base, cands, opts, "commercial", ctx) },
      score: { name: "Score-only ranking", ...byRank(cands, opts, c => c.score) },
      ratio: { name: "EV/charger ratio baseline", ...byRank(cands, opts, c => c.raw.pressure) },
    };
    if (opts.objectivesOnly) for (const k of Object.keys(plans)) if (!opts.objectivesOnly.includes(k)) delete plans[k];
    for (const k in plans) plans[k].metrics = evaluate(cells, base, plans[k].selected, opts);
    return plans;
  }

  function jaccard(a, b) {
    const A = new Set(a), Bs = new Set(b); let i = 0; A.forEach(x => { if (Bs.has(x)) i++; });
    const u = A.size + Bs.size - i; return u ? i / u : 1;
  }

  /** sensitivity: vary τ, detour, weights and cost; report coverage and overlap with base greedy plan */
  function sensitivity(ctxBuilder, opts) {
    const runs = [];
    const variants = [
      ["Base", {}],
      ["τ × 0.5", { tauKm: opts.tauKm * 0.5 }], ["τ × 1.5", { tauKm: opts.tauKm * 1.5 }],
      ["Detour 1.0", { detour: 1.0 }], ["Detour 1.6", { detour: 1.6 }],
      ["Costs +30%", { costScale: 1.3 }], ["Costs −30%", { costScale: 0.7 }],
      ["Gap-heavy weights", { weights: { gap: 0.5, pressure: 0.2, corridor: 0.1, equity: 0.1, feasibility: 0.1 } }],
      ["Equity-heavy weights", { weights: { gap: 0.2, pressure: 0.15, corridor: 0.1, equity: 0.45, feasibility: 0.1 } }],
    ];
    let baseIds = null;
    for (const [name, v] of variants) {
      const o = { ...opts, ...v, weights: v.weights || opts.weights };
      if (v.costScale) o.hardwareCost = Object.fromEntries(Object.entries(opts.hardwareCost).map(([k, x]) => [k, x * v.costScale])),
        o.siteCost = Object.fromEntries(Object.entries(opts.siteCost).map(([k, x]) => [k, x * v.costScale]));
      const { ctx, cands } = ctxBuilder(o);
      const g = greedy(ctx.cells, ctx.base, cands, o);
      const m = evaluate(ctx.cells, ctx.base, g.selected, o);
      const sc = byRank(cands, o, c => c.score);
      const ids = g.selected.map(c => c.place || c.id);
      if (!baseIds) baseIds = ids;
      runs.push({ name, coverage: m.coverage, baseCoverage: ctx.base.coverage, sites: g.selected.length, overlap: jaccard(baseIds, ids), scoreOverlap: jaccard(g.selected.map(c => c.id), sc.selected.map(c => c.id)) });
    }
    return runs;
  }

  /* ---------- corridor analysis on the highway graph ---------- */
  class Heap {
    constructor() { this.a = []; }
    push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
    get size() { return this.a.length; }
  }
  function buildGraph(roads) {
    const adj = roads.nodes.map(() => []);
    for (const [a, b, km] of roads.edges) { adj[a].push([b, km]); adj[b].push([a, km]); }
    const idx = new GridIndex(roads.nodes.map(([lng, lat]) => ({ lat, lng })), 0.25);
    return { nodes: roads.nodes, adj, idx };
  }
  function route(graph, from, to) {
    const s = graph.idx.nearest(from.lat, from.lng, 80), t = graph.idx.nearest(to.lat, to.lng, 80);
    if (!s || !t) return null;
    const n = graph.nodes.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const h = new Heap(); dist[s.i] = 0; h.push([0, s.i]);
    while (h.size) {
      const [d, u] = h.pop(); if (d > dist[u]) continue; if (u === t.i) break;
      for (const [v, w] of graph.adj[u]) { const nd = d + w; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; h.push([nd, v]); } }
    }
    if (!isFinite(dist[t.i])) return null;
    const path = []; for (let u = t.i; u !== -1; u = prev[u]) path.push(graph.nodes[u]); path.reverse();
    return { path, km: dist[t.i] + s.d + t.d, snapFrom: s.d, snapTo: t.d };
  }
  /** charging opportunities along a path within bufferKm; gaps vs EV range */
  function corridorGaps(path, chargerIdx, opts) {
    const { bufferKm = 3, rangeKm = 250, reservePct = 20, filter } = opts;
    const usable = rangeKm * (1 - reservePct / 100);
    const samples = []; let along = 0;
    for (let i = 0; i < path.length; i++) {
      if (i) along += hav(path[i - 1][1], path[i - 1][0], path[i][1], path[i][0]);
      samples.push([path[i][0], path[i][1], along]);
    }
    // densify to ~1 km
    const dense = [];
    for (let i = 0; i < samples.length; i++) {
      dense.push(samples[i]);
      if (i < samples.length - 1) {
        const [x0, y0, a0] = samples[i], [x1, y1, a1] = samples[i + 1]; const k = Math.floor(a1 - a0);
        for (let j = 1; j < k; j++) dense.push([x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k, a0 + (a1 - a0) * j / k]);
      }
    }
    const stops = []; const seen = new Set();
    for (const [x, y, a] of dense) {
      const n = chargerIdx.nearest(y, x, bufferKm, filter);
      if (n && !seen.has(n.i)) { seen.add(n.i); stops.push({ at: a, i: n.i, off: n.d }); }
    }
    stops.sort((p, q) => p.at - q.at);
    const total = along;
    const marks = [0, ...stops.map(s => s.at), total];
    let maxGap = 0, maxAt = 0; const gaps = [];
    for (let i = 1; i < marks.length; i++) { const g = marks[i] - marks[i - 1]; gaps.push({ from: marks[i - 1], to: marks[i], km: g }); if (g > maxGap) { maxGap = g; maxAt = marks[i - 1]; } }
    // minimal-stop plan given usable range, starting full
    const plan = []; let pos = 0, ok = true;
    while (total - pos > usable) {
      const reach = stops.filter(s => s.at > pos && s.at <= pos + usable);
      if (!reach.length) { ok = false; break; }
      const nxt = reach[reach.length - 1]; plan.push(nxt); pos = nxt.at;
    }
    return { total, stops, gaps, maxGap, maxAt, feasible: ok, plan, usable, dense };
  }

  const E = { hav, GridIndex, pointInGeom, bbox, distToLine, DEFAULTS, siteCost, competitorCounts, baseline, histogram, generateCandidates, scoreCandidates, confidenceFor, evaluate, greedy, byRank, runScenarios, sensitivity, jaccard, buildGraph, route, corridorGaps };
  if (typeof module !== "undefined" && module.exports) module.exports = E; else root.RGEngine = E;
})(typeof self !== "undefined" ? self : this);
