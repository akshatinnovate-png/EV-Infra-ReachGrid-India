/* Builds an analysis context for a set of districts from the bundled data. No DOM.
 * Optional inputs: built portfolio sites (count as chargers), uploaded EV registrations (replace the
 * vehicle-ownership proxy), feasibility evidence (overrides host feasibility / cost / blocks sites),
 * and a highway-network distance mode. */
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const E = isNode ? require("./engine.js") : root.RGEngine;
  const A = () => (isNode ? require("./advanced.js") : root.RGAdvanced);
  const PM = () => (isNode ? require("./pmedrive.js") : root.RGPMEDrive);
  const idxCache = new Map();

  /** national charger points from india.charger_index (lat*1e4, lng*1e4, flags) + optional extra (built) sites */
  function chargerIndex(india, filter, extra) {
    const key = filter + "|" + (extra && extra.length ? extra.map(p => p.lat.toFixed(4) + p.lng.toFixed(4)).join(",") : "");
    if (idxCache.has(key)) return idxCache.get(key);
    const a = india.charger_index, pts = [];
    for (let i = 0; i < a.length; i += 3) {
      const dc = !!(a[i + 2] & 1), verified = !!(a[i + 2] & 2);
      if (filter === "dc" && !dc) continue;
      if (filter === "verified" && !verified) continue;
      pts.push({ lat: a[i] / 1e4, lng: a[i + 1] / 1e4, dc, verified });
    }
    for (const p of extra || []) pts.push({ lat: p.lat, lng: p.lng, dc: p.dc !== false, verified: true, built: true, id: p.id });
    const idx = new E.GridIndex(pts, 0.1);
    if (idxCache.size > 12) idxCache.clear();
    idxCache.set(key, idx);
    return idx;
  }

  /** electricity-infrastructure points (substations or power plants) from india.grid */
  const gridCache = new Map();
  function gridIndex(india) {
    if (!india.grid) return null;
    if (gridCache.has(india)) return gridCache.get(india);
    const a = india.grid.points, pts = [];
    for (let i = 0; i < a.length; i += 3) pts.push({ lat: a[i] / 1e4, lng: a[i + 1] / 1e4, size: a[i + 2] });
    const idx = new E.GridIndex(pts, 0.25); idx.kind = india.grid.kind;
    gridCache.set(india, idx); return idx;
  }

  function regionDistricts(stateData, districtIds) {
    const want = districtIds ? new Set(districtIds) : null;
    return stateData.districts.filter(d => !want || want.has(d.id));
  }

  function buildContext({ india, stateData, roads, districtIds, opts, extraChargers, chargerIdx, evByDistrict, graph }) {
    const ds = regionDistricts(stateData, districtIds);
    const statById = new Map(india.districts.map(d => [d.id, d.stats]));
    const cells = [], vehicleRate = [], places = [], geoms = [], cellDistrict = [], sites = [], mix = {};
    let observed = 0, popTot = 0, evUploaded = 0, evVahan = 0;
    for (const d of ds) {
      const st = statById.get(d.id);
      let vr = st && st.pop ? st.vehicle_idx / st.pop : 0;
      // default pressure: registered EVs (VAHAN, RTO-level, 2022 onward) per person; Census vehicle ownership if absent
      const ev = st && st.ev && st.ev.stock;
      if (ev && ev.ev > 0 && st.pop && opts.pressureSource !== "census") { vr = ev.ev / st.pop; evVahan++; }
      if (evByDistrict && evByDistrict[d.id] != null && st && st.pop) { vr = evByDistrict[d.id] / st.pop; evUploaded++; }
      mix[d.id] = ev && ev.ev > 0 ? { e2w: ev.e2w / ev.ev, e3w: ev.e3w / ev.ev, e4w: ev.e4w / ev.ev, bus: ev.bus / ev.ev, stock: ev, pop: st.pop } : null;
      for (const x of d.sites || []) sites.push(x);
      for (const c of d.cells) { cells.push(c); vehicleRate.push(vr); cellDistrict.push(d.id); }
      for (const p of d.places) places.push(p);
      geoms.push(d.geom);
      if (st) { popTot += st.pop; if (st.census_flag === "observed") observed += st.pop; }
    }
    let bb = [180, 90, -180, -90];
    for (const g of geoms) { const b = E.bbox(g); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; }
    const rl = (roads ? roads.lines : []).filter(([, co]) => co.some(([x, y]) => x >= bb[0] - 0.05 && x <= bb[2] + 0.05 && y >= bb[1] - 0.05 && y <= bb[3] + 0.05));
    const idx = chargerIdx || chargerIndex(india, opts.chargerFilter, extraChargers);
    const metric = opts.metric === "network" && graph ? "network" : "straight";
    const base = metric === "network" ? A().networkBaseline(cells, idx, graph, opts) : E.baseline(cells, idx, opts);
    return {
      districts: ds, cells, vehicleRate, cellDistrict, places, geoms, roads: rl, bbox: bb, chargerIdx: idx, base, metric, graph, sites, mix,
      gridIdx: opts.useGrid === false ? null : gridIndex(india),
      censusFlag: popTot && observed / popTot >= 0.9 ? "observed" : "imputed",
      pressureSource: evUploaded ? `uploaded EV registrations (${evUploaded}/${ds.length} districts)` : evVahan ? `VAHAN EV registrations by RTO, 2022 onward (${evVahan}/${ds.length} districts)` : "Census 2011 vehicle ownership proxy",
    };
  }

  /** full pipeline for one option set: context + candidates (+ evidence) + scores (+ network reach) */
  function analyse(args) {
    const ctx = buildContext(args);
    let cands = E.generateCandidates(ctx, args.opts);
    if (args.evidence && args.evidence.length) cands = A().applyEvidence(cands, args.evidence, ctx, args.opts);
    E.scoreCandidates(cands, ctx, args.opts);
    if (ctx.metric === "network") A().networkReach(cands, ctx, args.opts);
    if (args.opts.pm && args.opts.pm.enabled !== false) {
      // PM E-DRIVE costing: archetype from the district fleet mix, category from the site type, cost on the chosen basis
      const cIdx = new E.GridIndex(ctx.cells.map(c => ({ lat: c[1], lng: c[0] })), 0.05);
      const mixFor = (c) => { const n = cIdx.nearest(c.lat, c.lng, 30); return n ? ctx.mix[ctx.cellDistrict[n.i]] : null; };
      PM().applyToCandidates(cands, mixFor, args.opts.pm);
      args.opts.catACap = args.opts.pm.capACatA === false ? null : catACapFor(cands, args.opts);
    }
    return { ctx, cands };
  }

  /** Category A cap in ₹ lakh of subsidy: 20% of the subsidy the budget can buy (FAQ 1) */
  function catACapFor(cands, opts) {
    const basis = opts.pm.budgetBasis || "total";
    const B = opts.budgetLakh;
    if (basis === "subsidy") return PM().CAT_A_SHARE_LIMIT * B;
    let sub = 0, cost = 0; for (const c of cands) { sub += c.pm.subsidy; cost += c.cost; }
    return PM().CAT_A_SHARE_LIMIT * B * (cost ? sub / cost : 0.5);
  }

  const API = { chargerIndex, gridIndex, buildContext, analyse, catACapFor };
  if (isNode) module.exports = API; else root.RGRegion = API;
})(typeof self !== "undefined" ? self : this);
