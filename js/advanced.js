/* ReachGrid advanced analytics (no DOM; browser, worker, service worker and Node):
 *  - highway-network distances (bounded multi-source Dijkstra on the national graph)
 *  - feasibility evidence (field / utility / land data) applied to candidates
 *  - budget curve, 1-swap local search, exact integer programme with LP bound (proposal §6.4 "later versions")
 *  - holdout backtest against where operators actually built (proposal §8, §12)
 *  - commercial screen and portfolio recalibration (proposal §3 Portfolio Monitor, §10)
 */
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const E = isNode ? require("./engine.js") : root.RGEngine;
  const Rg = () => (isNode ? require("./region.js") : root.RGRegion);
  const LP = () => (root.solver || (typeof solver !== "undefined" ? solver : null)); // eslint-disable-line no-undef

  /* ---------------- small utilities ---------------- */
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function parseCSV(text) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some(x => x !== "")) rows.push(row); row = []; }
      else cur += ch;
    }
    row.push(cur); if (row.some(x => x !== "")) rows.push(row);
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"));
    return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
  }
  class Heap {
    constructor() { this.a = []; }
    push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
    get size() { return this.a.length; }
  }

  /* ---------------- highway-network distance ---------------- */
  const ACCESS_KM = 12, DIRECT_KM = 4;
  /** bounded multi-source Dijkstra; seeds: [[node, startKm]] → Map(node → km) */
  function dijkstra(graph, seeds, maxKm) {
    const D = new Map(), h = new Heap();
    for (const [n, d] of seeds) if (d <= maxKm && (!D.has(n) || d < D.get(n))) { D.set(n, d); h.push([d, n]); }
    while (h.size) {
      const [d, u] = h.pop(); if (d > D.get(u)) continue;
      for (const [v, w] of graph.adj[u]) { const nd = d + w; if (nd <= maxKm && (!D.has(v) || nd < D.get(v))) { D.set(v, nd); h.push([nd, v]); } }
    }
    return D;
  }
  function seedsAround(graph, lat, lng, det) { return graph.idx.within(lat, lng, ACCESS_KM).map(n => [n.i, n.d * det]); }
  /** distance from a point via its nearby graph nodes, given node distances D */
  function viaNetwork(graph, D, lat, lng, det) {
    let best = Infinity;
    for (const n of graph.idx.within(lat, lng, ACCESS_KM)) { const dn = D.get(n.i); if (dn != null) best = Math.min(best, dn + n.d * det); }
    return best;
  }
  function networkBaseline(cells, chargerIdx, graph, opts) {
    const det = opts.detour, maxKm = Math.max(120, opts.tauKm * 4);
    let lo = [90, 180], hi = [-90, -180];
    for (const c of cells) { lo = [Math.min(lo[0], c[1]), Math.min(lo[1], c[0])]; hi = [Math.max(hi[0], c[1]), Math.max(hi[1], c[0])]; }
    const seeds = [];
    for (const p of chargerIdx.pts) if (p.lat > lo[0] - 1.2 && p.lat < hi[0] + 1.2 && p.lng > lo[1] - 1.2 && p.lng < hi[1] + 1.2) seeds.push(...seedsAround(graph, p.lat, p.lng, det));
    const D = dijkstra(graph, seeds, maxKm);
    const dist = new Float64Array(cells.length); let tot = 0, cov = 0, wsum = 0, fallback = 0;
    cells.forEach(([lon, lat, w], i) => {
      const direct = chargerIdx.nearest(lat, lon, DIRECT_KM);
      let d = viaNetwork(graph, D, lat, lon, det);
      if (direct) d = Math.min(d, direct.d * det);
      if (!isFinite(d)) { const n = chargerIdx.nearest(lat, lon, 600); d = n ? n.d * det : Infinity; fallback += w; }
      dist[i] = d; tot += w; if (d <= opts.tauKm) cov += w; if (isFinite(d)) wsum += w * d;
    });
    return { dist, total: tot, covered: cov, coverage: tot ? cov / tot : 0, meanDist: tot ? wsum / tot : 0, metric: "network", fallbackShare: tot ? fallback / tot : 0 };
  }
  function networkReach(cands, ctx, opts) {
    const { graph, cells } = ctx, det = opts.detour, tau = opts.tauKm;
    const cellIdx = new E.GridIndex(cells.map(c => ({ lat: c[1], lng: c[0] })), 0.05);
    for (const c of cands) {
      const D = dijkstra(graph, seedsAround(graph, c.lat, c.lng, det), tau);
      const reach = [];
      for (const n of cellIdx.within(c.lat, c.lng, tau)) {
        const [lon, lat] = cells[n.i];
        let d = viaNetwork(graph, D, lat, lon, det);
        if (n.d <= DIRECT_KM) d = Math.min(d, n.d * det);
        if (d <= tau) reach.push([n.i, d]);
      }
      c.reach = reach;
    }
    return cands;
  }

  /* ---------------- feasibility evidence ---------------- */
  /** evidence rows: {lat,lng,status:ok|blocked|unknown,grid_kva,land,cost_lakh,host,name,notes} */
  function applyEvidence(cands, evidence, ctx, opts) {
    let k = 0;
    for (const ev of evidence) {
      const lat = +ev.lat, lng = +ev.lng; if (!isFinite(lat) || !isFinite(lng)) continue;
      if (!ctx.geoms.some(g => E.pointInGeom(lng, lat, g))) continue;
      let best = null;
      for (const c of cands) { const d = E.hav(lat, lng, c.lat, c.lng); if (d <= 0.3 && (!best || d < best.d)) best = { c, d }; }
      const status = String(ev.status || "unknown").toLowerCase();
      const kva = +ev.grid_kva || null;
      const feas = status === "ok" ? (kva ? Math.min(1, 0.7 + kva / 1000) : 0.85) : status === "blocked" ? 0 : null;
      const target = best ? best.c : null;
      const apply = (c) => {
        c.evidence = { status, grid_kva: kva, land: ev.land || null, notes: ev.notes || null, name: ev.name || null };
        if (feas != null) c.evFeas = feas;
        if (status === "blocked") c.blocked = true;
        if (ev.cost_lakh !== "" && ev.cost_lakh != null && isFinite(+ev.cost_lakh)) c.costOverride = +ev.cost_lakh;
      };
      if (target) apply(target);
      else if (status !== "blocked") {
        const c = { lat, lng, host: ["town", "highway", "hotspot"].includes(ev.host) ? ev.host : "town", label: `Evidence site · ${ev.name || "unnamed"}`, place: ev.name || null, id: "E" + String(++k).padStart(3, "0") };
        apply(c); cands.push(c);
      }
    }
    return cands;
  }

  /* ---------------- budget curve ---------------- */
  function budgetCurve(ctx, cands, opts, budgets) {
    budgets = budgets || [0.25, 0.5, 1, 2, 3, 4, 6, 8].map(m => Math.round(opts.budgetLakh * m));
    return budgets.map(B => {
      const o = { ...opts, budgetLakh: B };
      const g = E.greedy(ctx.cells, ctx.base, cands, o, "gain");
      const sc = E.byRank(cands, o, c => c.score);
      const mg = E.evaluate(ctx.cells, ctx.base, g.selected, o), ms = E.evaluate(ctx.cells, ctx.base, sc.selected, o);
      return { budget: B, greedy: mg.coverage, score: ms.coverage, sites: g.selected.length, newly: mg.newlyCovered, costPerPerson: mg.costPerPerson };
    });
  }

  /* ---------------- local search (1-swap + add) ---------------- */
  function localSearch(ctx, cands, opts, start) {
    const { cells, base } = ctx, tau = opts.tauKm, t0 = Date.now();
    const unc = new Uint8Array(cells.length); cells.forEach((c, i) => { unc[i] = base.dist[i] > tau ? 1 : 0; });
    const cov = (c) => c.reach.filter(([i, km]) => unc[i] && km <= tau).map(([i]) => i);
    const C = cands.filter(c => !c.blocked).map(c => ({ c, cells: cov(c) })).filter(x => x.cells.length);
    const inSel = new Set(start.map(c => c.id)); const cnt = new Uint16Array(cells.length);
    let sel = C.filter(x => inSel.has(x.c.id));
    sel.forEach(x => x.cells.forEach(i => cnt[i]++));
    const cost = () => sel.reduce((a, x) => a + x.c.cost, 0);
    let swaps = 0, adds = 0, iter = 0;
    for (; iter < 60 && Date.now() - t0 < 4000; iter++) {
      let best = null;
      const rem = opts.budgetLakh - cost();
      for (const u of C) { // additions
        if (inSel.has(u.c.id) || u.c.cost > rem + 1e-9) continue;
        let g = 0; for (const i of u.cells) if (!cnt[i]) g += cells[i][2];
        if (g > 0 && (!best || g > best.delta)) best = { delta: g, add: u };
      }
      for (const s of sel) {
        const sc = new Set(s.cells);
        let loss = 0; for (const i of s.cells) if (cnt[i] === 1) loss += cells[i][2];
        for (const u of C) {
          if (inSel.has(u.c.id) || u.c.cost > rem + s.c.cost + 1e-9) continue;
          let g = 0; for (const i of u.cells) if (cnt[i] - (sc.has(i) ? 1 : 0) === 0) g += cells[i][2];
          const delta = g - loss;
          if (delta > 1e-6 && (!best || delta > best.delta)) best = { delta, add: u, drop: s };
        }
      }
      if (!best) break;
      if (best.drop) { best.drop.cells.forEach(i => cnt[i]--); sel = sel.filter(x => x !== best.drop); inSel.delete(best.drop.c.id); swaps++; } else adds++;
      best.add.cells.forEach(i => cnt[i]++); sel.push(best.add); inSel.add(best.add.c.id);
    }
    return { selected: sel.map(x => x.c), swaps, adds, iterations: iter, ms: Date.now() - t0 };
  }

  /* ---------------- exact integer programme (budgeted maximum coverage) ---------------- */
  function ilp(ctx, cands, opts, { timeoutMs = 8000, maxCands = 350 } = {}) {
    const S = LP(); if (!S) return { error: "LP solver not loaded" };
    const { cells, base } = ctx, tau = opts.tauKm, t0 = Date.now();
    let pool = cands.filter(c => !c.blocked && c.cost <= opts.budgetLakh);
    let restricted = false;
    if (pool.length > maxCands) { pool = [...pool].sort((a, b) => b.raw.gap / b.cost - a.raw.gap / a.cost).slice(0, maxCands); restricted = true; }
    const coverers = new Map();
    pool.forEach((c, j) => c.reach.forEach(([i, km]) => { if (base.dist[i] > tau && km <= tau) { if (!coverers.has(i)) coverers.set(i, []); coverers.get(i).push(j); } }));
    const model = { optimize: "cov", opType: "max", constraints: { budget: { max: opts.budgetLakh } }, variables: {}, ints: {}, options: { timeout: timeoutMs } };
    pool.forEach((c, j) => { model.variables["x" + j] = { budget: c.cost, ["xu" + j]: 1 }; model.constraints["xu" + j] = { max: 1 }; model.ints["x" + j] = 1; });
    for (const [i, js] of coverers) {
      model.constraints["c" + i] = { max: 0 }; model.constraints["yu" + i] = { max: 1 };
      model.variables["y" + i] = { cov: cells[i][2], ["c" + i]: 1, ["yu" + i]: 1 };
      for (const j of js) model.variables["x" + j]["c" + i] = -1;
    }
    const relaxed = { ...model, ints: {}, options: {} };
    const lp = S.Solve(relaxed);
    const res = S.Solve(model);
    const selected = pool.filter((c, j) => (res["x" + j] || 0) > 0.5);
    const obj = res.result || 0, bound = lp.result || obj;
    return {
      selected, objective: obj, bound, gap: bound > 0 ? (bound - obj) / bound : 0, feasible: !!res.feasible,
      timedOut: Date.now() - t0 >= timeoutMs * 0.98 || res.isIntegral === false, ms: Date.now() - t0,
      vars: Object.keys(model.variables).length, cons: Object.keys(model.constraints).length, restricted, poolSize: pool.length,
    };
  }

  /** compare greedy, local search and ILP on equal budget */
  function compareOptimisers(ctx, cands, opts, ilpOpts) {
    const t0 = Date.now();
    const g = E.greedy(ctx.cells, ctx.base, cands, opts, "gain");
    const tg = Date.now() - t0;
    const ls = localSearch(ctx, cands, opts, g.selected);
    const ip = ilp(ctx, cands, opts, ilpOpts);
    const ev = (sel) => E.evaluate(ctx.cells, ctx.base, sel, opts);
    const out = { greedy: { ...ev(g.selected), ms: tg, selected: g.selected }, local: { ...ev(ls.selected), ms: ls.ms, swaps: ls.swaps, adds: ls.adds, selected: ls.selected } };
    if (!ip.error) out.ilp = { ...ev(ip.selected), ms: ip.ms, bound: ip.bound, gap: ip.gap, timedOut: ip.timedOut, restricted: ip.restricted, vars: ip.vars, cons: ip.cons, selected: ip.selected };
    else out.ilpError = ip.error;
    const boundNewly = out.ilp ? out.ilp.bound : null;
    for (const k of ["greedy", "local", "ilp"]) if (out[k] && boundNewly) out[k].ofBound = out[k].newlyCovered / boundNewly;
    return out;
  }

  /* ---------------- holdout backtest ---------------- */
  /** hide a share of the region's real chargers, plan K new sites on the rest, and check whether the plan
   *  lands where operators actually built (hit rate) and how much coverage it restores vs the real sites. */
  function backtest(args, { holdout = 0.2, seed = 7, hitKm = 3, randomRuns = 30 } = {}) {
    const R = Rg(), opts = args.opts;
    const full = R.chargerIndex(args.india, "all");
    const pre = R.buildContext({ ...args, chargerIdx: full });
    const inRegion = full.pts.map((p, i) => i).filter(i => { const p = full.pts[i]; return p.lng >= pre.bbox[0] && p.lng <= pre.bbox[2] && p.lat >= pre.bbox[1] && p.lat <= pre.bbox[3] && pre.geoms.some(g => E.pointInGeom(p.lng, p.lat, g)); });
    if (inRegion.length < 5) return { error: "Too few chargers in this region to hold any out (need ≥ 5)." };
    const r = rng(seed); const shuffled = [...inRegion].sort(() => r() - 0.5);
    const K = Math.max(1, Math.round(inRegion.length * holdout));
    const hidden = new Set(shuffled.slice(0, K));
    const reduced = new E.GridIndex(full.pts.filter((p, i) => !hidden.has(i)), 0.1);
    const hiddenPts = [...hidden].map(i => full.pts[i]);
    const hiddenIdx = new E.GridIndex(hiddenPts, 0.05);
    const ctx = R.buildContext({ ...args, chargerIdx: reduced });
    // fair test: besides the gap-seeking candidates, allow sites at the densest demand cells even where
    // chargers already exist nearby (that is where operators actually build)
    const gen = E.generateCandidates(ctx, opts);
    const dense = ctx.cells.map((c, i) => i).sort((a, b) => ctx.cells[b][2] - ctx.cells[a][2]).slice(0, 300);
    dense.forEach((i, k) => gen.push({ lat: ctx.cells[i][1], lng: ctx.cells[i][0], host: "hotspot", label: "Dense demand cell", id: "D" + String(k + 1).padStart(4, "0") }));
    const cands = E.scoreCandidates(gen, ctx, opts);
    const big = { ...opts, budgetLakh: 1e9 };
    const take = (sel) => sel.slice(0, K);
    const greedySel = take(E.greedy(ctx.cells, ctx.base, cands, big).selected);
    const scoreSel = take(E.byRank(cands, big, c => c.score).selected);
    const commercialSel = take(E.greedy(ctx.cells, ctx.base, cands, big, "commercial", ctx).selected);
    const demandSel = take(E.byRank(cands, big, c => c.raw.vehicleHH).selected);
    const measure = (sel) => {
      const hits = sel.filter(c => hiddenIdx.nearest(c.lat, c.lng, hitKm)).length;
      const sIdx = new E.GridIndex(sel.map(c => ({ lat: c.lat, lng: c.lng })), 0.05);
      const recall = hiddenPts.filter(p => sIdx.nearest(p.lat, p.lng, hitKm)).length;
      const m = E.evaluate(ctx.cells, ctx.base, sel, opts);
      return { sites: sel.length, hitRate: sel.length ? hits / sel.length : 0, recall: recall / K, coverage: m.coverage, newly: m.newlyCovered };
    };
    // the real hidden chargers as a "plan"
    const realAsCands = hiddenPts.map((p, j) => { const near = new E.GridIndex(ctx.cells.map(c => ({ lat: c[1], lng: c[0] })), 0.05).within(p.lat, p.lng, opts.tauKm / opts.detour); return { id: "H" + j, reach: near.map(n => [n.i, n.d * opts.detour]), cost: 0 }; });
    const real = E.evaluate(ctx.cells, ctx.base, realAsCands, opts);
    const rr = rng(seed + 1), rand = [];
    for (let k = 0; k < randomRuns; k++) { const pool = [...cands].sort(() => rr() - 0.5); rand.push(measure(pool.slice(0, K))); }
    const avg = (f) => rand.reduce((a, x) => a + x[f], 0) / rand.length;
    return {
      regionChargers: inRegion.length, hidden: K, candidates: cands.length, hitKm, holdout, seed,
      baselineWithout: ctx.base.coverage, realSites: { coverage: real.coverage, newly: real.newlyCovered },
      greedy: measure(greedySel), score: measure(scoreSel), commercial: measure(commercialSel), demand: measure(demandSel),
      random: { hitRate: avg("hitRate"), recall: avg("recall"), coverage: avg("coverage"), newly: avg("newly"), runs: randomRuns },
    };
  }

  /* ---------------- commercial screen & portfolio recalibration ---------------- */
  function commercialEstimate(site, ctx, opts, calib) {
    const a = opts.commercial || E.DEFAULTS.commercial, tau = opts.tauKm;
    const comp = E.competitorCounts(ctx, opts);
    let capture = 0;
    for (const [i, km] of site.reach) if (km <= tau) capture += ctx.cells[i][2] * (ctx.vehicleRate[i] || 0) / (comp[i] + 1);
    const evShare = /uploaded/.test(ctx.pressureSource || "") ? 1 : a.evShare;
    const sessionsDay = calib && calib.k ? capture * calib.k : (capture * evShare * a.sessionsPerEvWeek) / 7;
    const kwhYear = sessionsDay * 365 * a.kwhPerSession;
    const grossLakh = (kwhYear * a.marginPerKwh) / 1e5;
    const netLakh = grossLakh - a.opexLakhYr;
    return { capture, sessionsDay, kwhYear, grossLakh, netLakh, paybackYears: netLakh > 0 ? site.cost / netLakh : null, basis: calib && calib.k ? "recalibrated from portfolio" : "assumptions (hypothesis)" };
  }
  /** fit observed sessions/day ≈ k × predicted capture (least squares through origin) */
  function recalibrate(rows) {
    const r = rows.filter(x => x.predicted > 0 && x.observed != null && isFinite(x.observed));
    if (r.length < 2) return { n: r.length, k: null };
    const k = r.reduce((a, x) => a + x.observed * x.predicted, 0) / r.reduce((a, x) => a + x.predicted ** 2, 0);
    const mean = r.reduce((a, x) => a + x.observed, 0) / r.length;
    const ssRes = r.reduce((a, x) => a + (x.observed - k * x.predicted) ** 2, 0), ssTot = r.reduce((a, x) => a + (x.observed - mean) ** 2, 0);
    const mape = r.filter(x => x.observed > 0).reduce((a, x, _, arr) => a + Math.abs(x.observed - k * x.predicted) / x.observed / arr.length, 0);
    return { n: r.length, k, r2: ssTot ? 1 - ssRes / ssTot : null, mape };
  }

  const API = { rng, parseCSV, dijkstra, networkBaseline, networkReach, applyEvidence, budgetCurve, localSearch, ilp, compareOptimisers, backtest, commercialEstimate, recalibrate };
  if (isNode) module.exports = API; else root.RGAdvanced = API;
})(typeof self !== "undefined" ? self : this);
