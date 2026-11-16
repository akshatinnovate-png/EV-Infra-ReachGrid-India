/* Heavy analysis jobs, shared by the Web Worker (js/worker.js), the service-worker API (sw.js)
 * and the main-thread fallback. Results are plain, structured-clone-safe objects. */
(function (root) {
  "use strict";
  const E = root.RGEngine, Rg = root.RGRegion, A = root.RGAdvanced;
  const lite = (sel) => sel.map(c => ({ id: c.id, label: c.label, host: c.host, lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), cost: c.cost }));
  const strip = (m) => { if (!m) return m; const o = { ...m }; delete o.dist; if (o.selected) o.selected = lite(o.selected); return o; };
  function baseArgs(args, data) {
    const graph = args.opts.metric === "network" ? (root._rgGraph ||= E.buildGraph(data.roads)) : null;
    return { india: data.india, stateData: data.stateData, roads: data.roads, districtIds: args.districtIds, opts: args.opts,
      evidence: args.evidence, extraChargers: args.extraChargers, evByDistrict: args.evByDistrict, graph };
  }
  function run(job, args, data) {
    const base = baseArgs(args, data);
    if (job === "budgetCurve") { const { ctx, cands } = Rg.analyse(base); return A.budgetCurve(ctx, cands, args.opts); }
    if (job === "compareOptimisers") {
      const { ctx, cands } = Rg.analyse(base);
      const r = A.compareOptimisers(ctx, cands, args.opts, { timeoutMs: args.timeoutMs || 8000 });
      for (const k of ["greedy", "local", "ilp"]) if (r[k]) r[k] = strip(r[k]);
      return r;
    }
    if (job === "sensitivity") return E.sensitivity(o => Rg.analyse({ ...base, opts: o }), args.opts);
    if (job === "backtest") return A.backtest(base, { holdout: args.holdout || 0.2, hitKm: args.hitKm || 3 });
    throw new Error("unknown job " + job);
  }
  root.RGJobs = { run, lite, strip, baseArgs };
})(typeof self !== "undefined" ? self : this);
