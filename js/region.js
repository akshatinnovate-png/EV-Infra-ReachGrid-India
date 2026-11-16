/* Builds an analysis context for a set of districts from the bundled data. No DOM.
 * Optional inputs: built portfolio sites (count as chargers), uploaded EV registrations (replace the
 * vehicle-ownership proxy), feasibility evidence (overrides host feasibility / cost / blocks sites),
 * and a highway-network distance mode. */
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const E = isNode ? require("./engine.js") : root.RGEngine;
  const A = () => (isNode ? require("./advanced.js") : root.RGAdvanced);
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

  function regionDistricts(stateData, districtIds) {
    const want = districtIds ? new Set(districtIds) : null;
    return stateData.districts.filter(d => !want || want.has(d.id));
  }

  function buildContext({ india, stateData, roads, districtIds, opts, extraChargers, chargerIdx, evByDistrict, graph }) {
    const ds = regionDistricts(stateData, districtIds);
    const statById = new Map(india.districts.map(d => [d.id, d.stats]));
    const cells = [], vehicleRate = [], places = [], geoms = [], cellDistrict = [];
    let observed = 0, popTot = 0, evUploaded = 0;
    for (const d of ds) {
      const st = statById.get(d.id);
      let vr = st && st.pop ? st.vehicle_idx / st.pop : 0;
      if (evByDistrict && evByDistrict[d.id] != null && st && st.pop) { vr = evByDistrict[d.id] / st.pop; evUploaded++; }
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
      districts: ds, cells, vehicleRate, cellDistrict, places, geoms, roads: rl, bbox: bb, chargerIdx: idx, base, metric, graph,
      censusFlag: popTot && observed / popTot >= 0.9 ? "observed" : "imputed",
      pressureSource: evUploaded ? `uploaded EV registrations (${evUploaded}/${ds.length} districts)` : "Census 2011 vehicle ownership proxy",
    };
  }

  /** full pipeline for one option set: context + candidates (+ evidence) + scores (+ network reach) */
  function analyse(args) {
    const ctx = buildContext(args);
    let cands = E.generateCandidates(ctx, args.opts);
    if (args.evidence && args.evidence.length) cands = A().applyEvidence(cands, args.evidence, ctx, args.opts);
    E.scoreCandidates(cands, ctx, args.opts);
    if (ctx.metric === "network") A().networkReach(cands, ctx, args.opts);
    return { ctx, cands };
  }

  const API = { chargerIndex, buildContext, analyse };
  if (isNode) module.exports = API; else root.RGRegion = API;
})(typeof self !== "undefined" ? self : this);
