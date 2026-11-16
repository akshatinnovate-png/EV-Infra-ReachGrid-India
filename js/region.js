/* Builds an analysis context for a set of districts from the bundled data. No DOM. */
(function (root) {
  "use strict";
  const E = typeof module !== "undefined" && module.exports ? require("./engine.js") : root.RGEngine;
  const idxCache = new Map();

  /** national charger points from india.charger_index (lat*1e4, lng*1e4, flags) */
  function chargerIndex(india, filter) {
    if (idxCache.has(filter)) return idxCache.get(filter);
    const a = india.charger_index, pts = [];
    for (let i = 0; i < a.length; i += 3) {
      const dc = !!(a[i + 2] & 1), verified = !!(a[i + 2] & 2);
      if (filter === "dc" && !dc) continue;
      if (filter === "verified" && !verified) continue;
      pts.push({ lat: a[i] / 1e4, lng: a[i + 1] / 1e4, dc, verified });
    }
    const idx = new E.GridIndex(pts, 0.1);
    idxCache.set(filter, idx);
    return idx;
  }

  function regionDistricts(stateData, districtIds) {
    const want = districtIds ? new Set(districtIds) : null;
    return stateData.districts.filter(d => !want || want.has(d.id));
  }

  function buildContext({ india, stateData, roads, districtIds, opts }) {
    const ds = regionDistricts(stateData, districtIds);
    const statById = new Map(india.districts.map(d => [d.id, d.stats]));
    const cells = [], vehicleRate = [], places = [], geoms = [];
    let observed = 0, popTot = 0;
    for (const d of ds) {
      const st = statById.get(d.id);
      const vr = st && st.pop ? st.vehicle_idx / st.pop : 0;
      for (const c of d.cells) { cells.push(c); vehicleRate.push(vr); }
      for (const p of d.places) places.push(p);
      geoms.push(d.geom);
      if (st) { popTot += st.pop; if (st.census_flag === "observed") observed += st.pop; }
    }
    let bb = [180, 90, -180, -90];
    for (const g of geoms) { const b = E.bbox(g); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; }
    const rl = (roads ? roads.lines : []).filter(([, co]) => co.some(([x, y]) => x >= bb[0] - 0.05 && x <= bb[2] + 0.05 && y >= bb[1] - 0.05 && y <= bb[3] + 0.05));
    const chargerIdx = chargerIndex(india, opts.chargerFilter);
    const base = E.baseline(cells, chargerIdx, opts);
    return {
      districts: ds, cells, vehicleRate, places, geoms, roads: rl, bbox: bb, chargerIdx, base,
      censusFlag: popTot && observed / popTot >= 0.9 ? "observed" : "imputed",
    };
  }

  /** full pipeline for one option set: context + candidates + scores */
  function analyse(args) {
    const ctx = buildContext(args);
    const cands = E.scoreCandidates(E.generateCandidates(ctx, args.opts), ctx, args.opts);
    return { ctx, cands };
  }

  const API = { chargerIndex, buildContext, analyse };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else root.RGRegion = API;
})(typeof self !== "undefined" ? self : this);
