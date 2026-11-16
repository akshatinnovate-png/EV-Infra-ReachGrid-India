// Acceptance tests from proposal §8, run against the real bundled data.  `node tests/engine.test.js`
const assert = require("assert");
const path = require("path");
global.window = {};
require(path.join(__dirname, "../data/india.js"));
require(path.join(__dirname, "../data/roads.js"));
require(path.join(__dirname, "../data/state/jharkhand.js"));
require(path.join(__dirname, "../data/state/uttar-pradesh.js"));
const E = require("../js/engine.js");
const Rg = require("../js/region.js");
const india = window.RG_INDIA, roads = window.RG_ROADS, jh = window.RG_STATE.jharkhand;

let pass = 0, fail = 0;
function t(name, fn) {
  const t0 = Date.now();
  try { fn(); pass++; console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const opts = { ...E.DEFAULTS };
const args = { india, stateData: jh, roads, districtIds: ["jharkhand.east-singhbhum"], opts };

console.log("Data integrity");
t("all charger coordinates are valid and inside India's bounding box", () => {
  const a = india.charger_index;
  for (let i = 0; i < a.length; i += 3) { const la = a[i] / 1e4, ln = a[i + 1] / 1e4; assert(la > 6 && la < 37.6 && ln > 68 && ln < 98, `bad ${la},${ln}`); }
  assert.strictEqual(a.length / 3, india.totals.chargers);
});
t("district census totals reconcile to the Census 2011 national total within 0.1%", () => {
  const p = india.districts.reduce((s, d) => s + d.stats.pop, 0);
  assert(Math.abs(p - 1210854977) / 1210854977 < 0.001, `pop ${p}`);
});
t("every district reports census provenance", () => {
  for (const d of india.districts) assert(["observed", "imputed"].includes(d.stats.census_flag), d.id);
});

console.log("Algorithm behaviour");
t("haversine: Delhi–Mumbai ≈ 1,150 km", () => { const d = E.hav(28.6139, 77.209, 19.076, 72.8777); assert(Math.abs(d - 1153) < 15, d); });
t("adding a charger never increases the nearest distance for any demand point", () => {
  const { ctx } = Rg.analyse(args);
  const pts = [...ctx.chargerIdx.pts, { lat: 22.80, lng: 86.20, dc: true, verified: true }];
  const idx2 = new E.GridIndex(pts, 0.1);
  const b2 = E.baseline(ctx.cells, idx2, opts);
  for (let i = 0; i < ctx.cells.length; i++) assert(b2.dist[i] <= ctx.base.dist[i] + 1e-9);
  assert(b2.coverage >= ctx.base.coverage);
});
t("coverage is monotone non-decreasing in threshold τ", () => {
  let prev = -1;
  for (const tau of [2, 5, 10, 20, 40]) { const { ctx } = Rg.analyse({ ...args, opts: { ...opts, tauKm: tau } }); assert(ctx.base.coverage >= prev); prev = ctx.base.coverage; }
});
t("greedy plan respects the budget and only adds positive marginal gain", () => {
  const { ctx, cands } = Rg.analyse(args);
  const g = E.greedy(ctx.cells, ctx.base, cands, opts);
  const cost = g.selected.reduce((s, c) => s + c.cost, 0);
  assert(cost <= opts.budgetLakh + 1e-9, `cost ${cost}`);
  for (const s of g.steps) assert(s.gain > 0);
  const m = E.evaluate(ctx.cells, ctx.base, g.selected, opts);
  assert(m.coverage >= ctx.base.coverage);
});
t("greedy coverage gain ≥ score-only baseline at equal budget (reported, not assumed)", () => {
  const { ctx, cands } = Rg.analyse(args);
  const p = E.runScenarios(ctx, cands, opts);
  console.log(`    baseline ${(ctx.base.coverage * 100).toFixed(1)}% · greedy ${(p.greedy.metrics.coverage * 100).toFixed(1)}% · score-only ${(p.score.metrics.coverage * 100).toFixed(1)}% · ratio ${(p.ratio.metrics.coverage * 100).toFixed(1)}%`);
  assert(p.greedy.metrics.coverage >= ctx.base.coverage);
});
t("missing score components are renormalised, never zero-filled", () => {
  const { cands } = Rg.analyse({ ...args, opts: { ...opts, useGrid: false } });
  const h = cands.find(c => c.missing.includes("feasibility"));
  assert(h, "expected a hotspot candidate with unknown feasibility");
  const w = opts.weights, avail = Object.keys(h.comp);
  const expect = avail.reduce((s, k) => s + w[k] * h.comp[k], 0) / avail.reduce((s, k) => s + w[k], 0);
  assert(Math.abs(expect - h.score) < 1e-9);
});

console.log("Reproducibility");
t("identical inputs produce identical outputs", () => {
  const a = Rg.analyse(args), b = Rg.analyse(args);
  const ga = E.greedy(a.ctx.cells, a.ctx.base, a.cands, opts), gb = E.greedy(b.ctx.cells, b.ctx.base, b.cands, opts);
  assert.deepStrictEqual(ga.selected.map(c => c.id), gb.selected.map(c => c.id));
  assert.strictEqual(a.ctx.base.coverage, b.ctx.base.coverage);
});

console.log("Corridors");
t("Delhi → Jaipur routes on the highway graph and finds charging stops", () => {
  const g = E.buildGraph(roads);
  const r = E.route(g, { lat: 28.6139, lng: 77.209 }, { lat: 26.9124, lng: 75.7873 });
  assert(r && r.km > 230 && r.km < 400, `route ${r && r.km}`);
  const idx = Rg.chargerIndex(india, "all");
  const c = E.corridorGaps(r.path, idx, { rangeKm: 250 });
  console.log(`    ${r.km.toFixed(0)} km, ${c.stops.length} chargers within 3 km, longest gap ${c.maxGap.toFixed(1)} km`);
  assert(c.stops.length > 0);
});

console.log("Performance");
t("state-wide analysis (all Jharkhand districts) under 5 s", () => {
  const t0 = Date.now();
  const { ctx, cands } = Rg.analyse({ ...args, districtIds: null, opts: { ...opts, budgetLakh: 2000 } });
  E.runScenarios(ctx, cands, { ...opts, budgetLakh: 2000 });
  console.log(`    ${ctx.cells.length} cells, ${cands.length} candidates, ${Date.now() - t0} ms`);
  assert(Date.now() - t0 < 5000);
});

t("largest state (Uttar Pradesh, 75 districts) full analysis under 5 s, all three site types present", () => {
  const t0 = Date.now(), o = { ...opts, budgetLakh: 2500 };
  const { ctx, cands } = Rg.analyse({ india, stateData: window.RG_STATE["uttar-pradesh"], roads, districtIds: null, opts: o });
  const p = E.runScenarios(ctx, cands, o);
  const types = new Set(cands.map(c => c.host));
  console.log(`    ${ctx.cells.length} cells, ${cands.length} candidates (${[...types].join("/")}), greedy ${(ctx.base.coverage * 100).toFixed(1)}% → ${(p.greedy.metrics.coverage * 100).toFixed(1)}%, ${Date.now() - t0} ms`);
  assert(types.size === 3);
  assert(Date.now() - t0 < 5000);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
