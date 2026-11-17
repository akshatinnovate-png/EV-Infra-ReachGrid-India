// PM E-DRIVE costing, queueing and adoption maths against hand-computed values.  `node tests/pmedrive.test.js`
const assert = require("assert"), path = require("path");
global.window = {};
for (const f of ["india"]) require(path.join(__dirname, `../data/${f}.js`));
const P = require("../js/pmedrive.js");
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.stack.split("\n").slice(0, 3).join("\n    ")}`); } }
const near = (a, b, eps = 0.011) => assert(Math.abs(a - b) <= eps, `${a} != ${b}`);

console.log("PM E-DRIVE subsidy (Operational Guidelines Table 2, BEE benchmarks Oct 2025)");
t("city station, Category C: 80% of upstream only", () => {
  const r = P.costSite({ arch: "city", site: { cat: "C" } });
  assert.strictEqual(r.ratingKw, 84); near(r.upstream, 14.80);
  near(r.evse, 3.40 / 1.18 + 2 * 1.60 / 1.18); near(r.subsidy, 0.8 * 14.80); near(r.total, 14.80 + r.evse + 2);
  near(r.net, r.total - r.subsidy);
});
t("city station, Category B: 80% upstream + 70% EVSE (benchmark ex-GST)", () => {
  const r = P.costSite({ arch: "city", site: { cat: "B" } });
  near(r.subsidy, 0.8 * 14.80 + 0.7 * (3.40 + 2 * 1.60) / 1.18);
});
t("city station, Category A: 100% + 100%", () => { const r = P.costSite({ arch: "city", site: { cat: "A" } }); near(r.subsidy, 14.80 + (3.40 + 3.20) / 1.18); });
t("highway station: 240 + 2×60 kW → >150 kW upstream band, Category C", () => {
  const r = P.costSite({ arch: "highway", host: "highway" }); assert.strictEqual(r.ratingKw, 360); near(r.upstream, 24.00); near(r.subsidy, 19.20);
  assert.deepStrictEqual(r.chargers.map(l => [l.kw, l.n, l.conn]), [[240, 1, "CCS-II"], [60, 2, "CCS-II"]]);
});
t("subsidy on EVSE uses the lower of actual and benchmark", () => {
  const cheap = P.costSite({ arch: "city", site: { cat: "B" } }, { evseActualFactor: 0.5 });
  const dear = P.costSite({ arch: "city", site: { cat: "B" } }, { evseActualFactor: 2 });
  near(cheap.subsidyEvse, 0.7 * 0.5 * (6.60 / 1.18)); near(dear.subsidyEvse, 0.7 * (6.60 / 1.18));
});
t("battery swapping → Category D, upstream only; HT extension adds to upstream", () => {
  assert.strictEqual(P.costSite({ arch: "bss", gridKm: 4, gridKind: "power_plant" }).upstream, 6.04);   // plants: no HT extension
  const r = P.costSite({ arch: "bss", gridKm: 4, gridKind: "substation" }); assert.strictEqual(r.category, "D"); near(r.upstream, 6.04 + 3 * 6); near(r.subsidyEvse, 0); near(r.subsidy, 0.8 * (6.04 + 18));
});
t("Category A share check (FAQ 1: ≤ 20% of requested subsidy)", () => {
  const mk = (cat) => ({ pm: P.costSite({ arch: "city", site: { cat } }) });
  const s1 = P.summarise([mk("A"), mk("C"), mk("C"), mk("C"), mk("C")]); assert(!s1.catAOk && s1.catAShare > 0.2);
  const s2 = P.summarise([mk("A"), ...Array(8).fill(0).map(() => mk("C"))]); assert(s2.catAOk, s2.catAShare);
  assert.strictEqual(s2.chargers.e4w, 9); assert.strictEqual(s2.chargers.e2w3w, 18);
});
t("archetypes: highway host → highway; low e-4W share town → 2W/3W hub (or BSS)", () => {
  assert.strictEqual(P.archetypeOf({ host: "highway" }, null, P.DEFAULTS), "highway");
  assert.strictEqual(P.archetypeOf({ host: "town" }, { e4w: 0.01 }, P.DEFAULTS), "hub");
  assert.strictEqual(P.archetypeOf({ host: "town" }, { e4w: 0.01 }, { ...P.DEFAULTS, preferSwap: true }), "bss");
  assert.strictEqual(P.archetypeOf({ host: "town" }, { e4w: 0.08 }, P.DEFAULTS), "city");
});

console.log("Queueing (M/M/c, Erlang C)");
t("Erlang C known values: c=1 → ρ; c=2, a=1 → 1/3", () => { near(P.erlangC(1, 0.6), 0.6, 1e-12); near(P.erlangC(2, 1), 1 / 3, 1e-12); });
t("M/M/1 waiting time matches λ/(μ(μ−λ))", () => { const m = P.mmc(3, 4, 1); near(m.wqMin, (3 / (4 * 1)) * 60, 1e-9); });
t("chargersFor finds the smallest c meeting the target and saturation is unstable", () => {
  const m = P.chargersFor(10, 2, 0.2); assert(m.pWait <= 0.2); assert(P.mmc(10, 2, m.c - 1).pWait > 0.2);
  assert.strictEqual(P.mmc(10, 2, 5).stable, false);
});
t("full spatial coverage can still queue: busy city site needs extra 60 kW guns", () => {
  const q = P.siteQueue("city", { e2w: 3000, e3w: 200, e4w: 1500, bus: 0 }, 1);
  assert(q.e4w.extra > 0 && q.e4w.pWait > 0.2, JSON.stringify(q.e4w));
});

console.log("Adoption S-curve (anchored to observed VAHAN share)");
t("logistic passes through the anchor and saturates", () => {
  const f = P.logisticFit(0.06, 2025, 0.8, 2030); near(f.at(2025), 0.06, 1e-9); assert(f.at(2040) > 0.7 && f.at(2040) < 0.8);
  const g = P.logisticFit(0.85, 2026, 0.9, 2026); near(g.at(2026), 0.85, 1e-9); assert(g.adjusted && g.at(2027) > 0.85, "inflection at the anchor year: curve still passes the observation and keeps rising");
});
t("national projection from bundled VAHAN data grows and stays below saturation", () => {
  const r = P.scurveForecast(window.RG_INDIA.ev_national);
  assert(r.rows[0].year >= 2025 && r.rows.at(-1).year === 2030);
  assert(r.rows.at(-1).stock.e2w > r.rows[0].stock.e2w);
  for (const row of r.rows) for (const s of ["e2w", "e3w", "e4w", "bus"]) assert(row.share[s] <= P.SCURVE_DEFAULTS.saturation[s] + 1e-9);
});
console.log("Integration: East Singhbhum with PM E-DRIVE costing");
for (const f of ["roads", "state/jharkhand"]) require(path.join(__dirname, `../data/${f}.js`));
const E = require("../js/engine.js"), Rg = require("../js/region.js");
const opts = { ...E.DEFAULTS, weights: { ...E.DEFAULTS.weights }, pm: { ...P.DEFAULTS }, budgetLakh: 1000 };
const args = { india: window.RG_INDIA, stateData: window.RG_STATE.jharkhand, roads: window.RG_ROADS, districtIds: ["jharkhand.east-singhbhum"], opts };
t("pressure comes from VAHAN EV registrations; every candidate has archetype, category, cost", () => {
  const { ctx, cands } = Rg.analyse(args);
  assert(/VAHAN/.test(ctx.pressureSource), ctx.pressureSource);
  assert(cands.length > 50 && cands.every(c => c.pm && c.cost > 0 && ["A", "B", "C", "D"].includes(c.pm.category)));
  assert(cands.some(c => c.pm.arch === "highway") && cands.some(c => c.pm.arch !== "highway"));
});
t("₹10 crore plan stays within budget, Category A within its cap, modified-greedy guarantee reported", () => {
  const { ctx, cands } = Rg.analyse(args);
  const p = E.runScenarios(ctx, cands, opts);
  const s = P.summarise(p.greedy.selected);
  assert(p.greedy.metrics.cost <= 1000 + 1e-9 && s.total <= 1000 + 1e-6);
  assert(s.byCat.A <= opts.catACap + 1e-6);
  assert(p.greedy.guarantee && p.greedy.guarantee.bound > 0.3, JSON.stringify(p.greedy.guarantee));
});
t("budget basis: subsidy envelope buys more sites than total project cost", () => {
  const o1 = { ...opts, budgetLakh: 200 }, r1 = Rg.analyse({ ...args, opts: o1 });
  const tot = E.runScenarios(r1.ctx, r1.cands, o1).greedy.selected.length;
  const o2 = { ...o1, pm: { ...opts.pm, budgetBasis: "subsidy" } };
  const r2 = Rg.analyse({ ...args, opts: o2 }); const sub = E.runScenarios(r2.ctx, r2.cands, o2).greedy.selected.length;
  assert(sub > tot, `${sub} vs ${tot}`);
});
t("OSM PM E-DRIVE sites become candidates with their category (synthetic PSU outlet + toll plaza)", () => {
  const jh = window.RG_STATE.jharkhand, d0 = jh.districts.find(d => d.id === "jharkhand.east-singhbhum");
  const { ctx } = Rg.analyse(args);
  const far = ctx.cells.map((c, i) => [i, ctx.base.dist[i]]).sort((a, b) => b[1] - a[1])[0][0];    // least-served cell
  const [lon, lat] = ctx.cells[far];
  const d1 = { ...d0, sites: [[lat, lon, "omc", "B", "Indian Oil test outlet", ""], [lat + 0.05, lon + 0.05, "toll", "B", "Test toll plaza", "verify NHAI / state control"]] };
  const sd = { ...jh, districts: jh.districts.map(d => d.id === d0.id ? d1 : d) };
  const r = Rg.analyse({ ...args, stateData: sd });
  const omc = r.cands.find(c => c.site && c.site.type === "omc"), toll = r.cands.find(c => c.site && c.site.type === "toll");
  assert(omc && omc.pm.category === "B" && /Indian Oil/.test(omc.label), omc && omc.label);
  assert(toll && toll.pm.arch === "highway" && toll.pm.category === "B");
  assert(omc.pm.subsidy > P.costSite({ arch: omc.pm.arch, site: { cat: "C" } }).subsidy);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
