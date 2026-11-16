// Tests for advanced analytics on real bundled data.  `node tests/advanced.test.js`
const assert = require("assert"), path = require("path"), fs = require("fs"), vm = require("vm");
global.window = {};
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../vendor/lp-solver.js"), "utf8"));
for (const f of ["india", "roads", "state/jharkhand"]) require(path.join(__dirname, `../data/${f}.js`));
const E = require("../js/engine.js"), Rg = require("../js/region.js"), A = require("../js/advanced.js");
const india = window.RG_INDIA, roads = window.RG_ROADS, jh = window.RG_STATE.jharkhand;
let pass = 0, fail = 0;
function t(name, fn) { const t0 = Date.now(); try { fn(); pass++; console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.stack.split("\n").slice(0, 3).join("\n    ")}`); } }
const opts = { ...E.DEFAULTS, weights: { ...E.DEFAULTS.weights } };
const args = { india, stateData: jh, roads, districtIds: ["jharkhand.east-singhbhum"], opts };

console.log("Objectives");
t("six plans incl. commercial and corridor; all within budget", () => {
  const { ctx, cands } = Rg.analyse(args);
  const p = E.runScenarios(ctx, cands, opts);
  assert.deepStrictEqual(Object.keys(p).sort(), ["commercial", "corridor", "equity", "greedy", "ratio", "score"]);
  for (const k in p) assert(p[k].metrics.cost <= opts.budgetLakh + 1e-9, k);
  assert(p.corridor.selected.every(c => c.host === "highway" || c.raw.roadKm < 2));
  assert(p.greedy.metrics.equityGap != null);
  console.log(`    commercial picks ${p.commercial.selected.length} sites, coverage ${(p.commercial.metrics.coverage * 100).toFixed(1)}%`);
});

console.log("Optimisers");
t("budget curve is monotone for greedy", () => {
  const { ctx, cands } = Rg.analyse(args);
  const c = A.budgetCurve(ctx, cands, opts);
  for (let i = 1; i < c.length; i++) assert(c[i].greedy >= c[i - 1].greedy - 1e-9);
});
t("local search never worse than greedy; ILP ≥ greedy and ≤ LP bound", () => {
  const { ctx, cands } = Rg.analyse(args);
  const r = A.compareOptimisers(ctx, cands, opts, { timeoutMs: 8000 });
  assert(r.local.newlyCovered >= r.greedy.newlyCovered - 1e-6);
  assert(r.ilp, r.ilpError);
  assert(r.ilp.newlyCovered <= r.ilp.bound + 1e-6);
  assert(r.local.cost <= opts.budgetLakh + 1e-9 && r.ilp.cost <= opts.budgetLakh + 1e-9);
  console.log(`    greedy ${Math.round(r.greedy.newlyCovered)} · local ${Math.round(r.local.newlyCovered)} · ILP ${Math.round(r.ilp.newlyCovered)} · LP bound ${Math.round(r.ilp.bound)} (greedy ${(r.greedy.ofBound * 100).toFixed(1)}% of bound, ILP ${r.ilp.ms} ms)`);
});

console.log("Evidence");
t("blocked evidence removes a site; ok evidence raises feasibility and overrides cost", () => {
  const { cands } = Rg.analyse(args);
  const a = cands.find(c => c.host === "town"), b = cands.find(c => c.host === "hotspot");
  const ev = [{ lat: a.lat, lng: a.lng, status: "blocked" }, { lat: b.lat, lng: b.lng, status: "ok", grid_kva: "250", cost_lakh: "29" }, { lat: 22.70, lng: 86.30, status: "ok", name: "Test petrol pump" }];
  const r = Rg.analyse({ ...args, evidence: ev });
  const a2 = r.cands.find(c => Math.abs(c.lat - a.lat) < 1e-9), b2 = r.cands.find(c => Math.abs(c.lat - b.lat) < 1e-9);
  assert(a2.blocked && b2.evidence && b2.cost === 29 && b2.comp.feasibility > 90);
  const p = E.runScenarios(r.ctx, r.cands, opts);
  for (const k in p) assert(!p[k].selected.some(c => c.blocked), k);
  assert(r.cands.some(c => c.id && c.id.startsWith("E")), "new evidence site added");
});

console.log("Network distance");
t("network mode: distances ≥ 0, coverage within sane range, reach consistent", () => {
  const graph = E.buildGraph(roads);
  const r = Rg.analyse({ ...args, opts: { ...opts, metric: "network" }, graph });
  assert.strictEqual(r.ctx.metric, "network");
  assert(r.ctx.base.coverage > 0 && r.ctx.base.coverage <= 1);
  for (const c of r.cands) for (const [, d] of c.reach) assert(d <= opts.tauKm + 1e-9);
  console.log(`    straight×detour ${(Rg.analyse(args).ctx.base.coverage * 100).toFixed(1)}% vs network ${(r.ctx.base.coverage * 100).toFixed(1)}%`);
});

console.log("Portfolio & data");
t("built sites count as chargers and never reduce coverage", () => {
  const before = Rg.analyse(args).ctx.base.coverage;
  const after = Rg.analyse({ ...args, extraChargers: [{ lat: 22.55, lng: 86.45, id: "B1" }] }).ctx.base.coverage;
  assert(after >= before);
});
t("uploaded EV registrations replace the pressure proxy", () => {
  const r = Rg.analyse({ ...args, evByDistrict: { "jharkhand.east-singhbhum": 12000 } });
  assert(/uploaded/.test(r.ctx.pressureSource));
});
t("recalibration recovers a known factor", () => {
  const rows = [10, 20, 40, 80].map(p => ({ predicted: p, observed: p * 0.05 }));
  const c = A.recalibrate(rows); assert(Math.abs(c.k - 0.05) < 1e-9 && c.r2 > 0.999);
});
t("CSV parser handles quotes, commas, CRLF", () => {
  const r = A.parseCSV('Lat,Lng,Name,Status\r\n22.8,86.2,"Pump, NH-18",ok\r\n');
  assert.strictEqual(r[0].name, "Pump, NH-18"); assert.strictEqual(r[0].status, "ok");
});

console.log("Validation");
t("holdout backtest runs and is deterministic", () => {
  const a = A.backtest({ ...args, districtIds: null }), b = A.backtest({ ...args, districtIds: null });
  assert(!a.error, a.error); assert.deepStrictEqual(a.greedy, b.greedy);
  console.log(`    ${a.hidden}/${a.regionChargers} hidden · hit rate greedy ${(a.greedy.hitRate * 100).toFixed(0)}%, commercial ${(a.commercial.hitRate * 100).toFixed(0)}% vs random ${(a.random.hitRate * 100).toFixed(0)}% · coverage greedy ${(a.greedy.coverage * 100).toFixed(1)}% vs real sites ${(a.realSites.coverage * 100).toFixed(1)}%`);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
