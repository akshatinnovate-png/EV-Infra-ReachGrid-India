/* ReachGrid static API — a service worker that implements the proposal's §7.2 API contracts with no server.
 * Requests from pages on this origin to ./api/v1/... are answered here by the same engine the app uses;
 * scenarios persist in IndexedDB. Everything else passes straight through to the network. */
self.window = self;
importScripts("vendor/lp-solver.js", "js/engine.js", "js/region.js", "js/advanced.js", "js/jobs.js");

const SCOPE = new URL(self.registration.scope).pathname;          // e.g. /EV-Infra-ReachGrid-India/
const API = SCOPE + "api/v1";
const VERSION = "1.0.0";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin && (url.pathname === API || url.pathname.startsWith(API + "/"))) e.respondWith(route(e.request, url));
});

/* ---------- data loading (lazy; data files assign to window.*) ---------- */
const loaded = new Map();
function loadData(path) {
  if (!loaded.has(path)) loaded.set(path, fetch(SCOPE + path).then(r => { if (!r.ok) throw new HttpError(404, `data file ${path} not found`); return r.text(); }).then(t => { new Function(t)(); }));
  return loaded.get(path);
}
async function core() { await loadData("data/india.js"); await loadData("data/roads.js"); return { india: self.RG_INDIA, roads: self.RG_ROADS }; }
async function stateData(sid) { await loadData(`data/state/${sid}.js`); return self.RG_STATE[sid]; }

/* ---------- IndexedDB ---------- */
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("reachgrid-api", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("scenarios", { keyPath: "scenario_id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction("scenarios", mode), st = t.objectStore("scenarios"); const out = fn(st); t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); t.onerror = () => rej(t.error); }); }
const putScenario = (rec) => tx("readwrite", st => st.put(rec));
const getScenario = (id) => tx("readonly", st => st.get(id));
const listScenarios = () => tx("readonly", st => st.getAll());
const deleteScenario = (id) => tx("readwrite", st => st.delete(id));

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, msg, detail) { super(msg); this.status = status; this.detail = detail; } }
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "X-ReachGrid-API": VERSION, "X-ReachGrid-Build": self.RG_INDIA ? self.RG_INDIA.version : "unloaded", ...extra } });
}
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); }
const PROFILES = { coverage: "greedy", equity: "equity", corridor: "corridor", commercial: "commercial", score_only: "score", ratio_baseline: "ratio" };
function resolveGeo(india, id) {
  if (!id || typeof id !== "string") throw new HttpError(400, "geography_id is required, e.g. 'jharkhand' or 'jharkhand.east-singhbhum'");
  if (id === "india") return { level: "india", id, name: "India" };
  const st = india.states.find(s => s.id === id);
  if (st) return { level: "state", id, sid: id, name: st.name, stats: st.stats };
  const d = india.districts.find(x => x.id === id);
  if (d) return { level: "district", id, sid: d.sid, did: d.id, name: d.name, stats: d.stats };
  throw new HttpError(404, `unknown geography '${id}'. List them at GET ${API}/geographies`);
}
function num(v, name, lo, hi, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v); if (!isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${name} must be a number between ${lo} and ${hi}`);
  return n;
}
function buildOpts(b) {
  const E = self.RGEngine, D = E.DEFAULTS;
  const metric = b.distance_metric || "straight";
  if (!["straight", "network"].includes(metric)) throw new HttpError(400, "distance_metric must be 'straight' or 'network'");
  const filter = b.charger_filter || "all";
  if (!["all", "dc", "verified"].includes(filter)) throw new HttpError(400, "charger_filter must be all, dc or verified");
  const cm = b.cost_model || {};
  const hardware = cm.hardware || D.hardware;
  if (!D.hardwareCost[hardware] && !(cm.hardware_cost_lakh && cm.hardware_cost_lakh[hardware])) throw new HttpError(400, "cost_model.hardware must be dc60, dc30 or ac22");
  const weights = { ...D.weights, ...(b.score_weights || {}) };
  for (const [k, v] of Object.entries(weights)) if (!(k in D.weights) || !isFinite(+v) || +v < 0) throw new HttpError(400, `score_weights.${k} invalid`);
  return {
    ...D, metric, chargerFilter: filter, hardware,
    tauKm: num(b.threshold_km, "threshold_km", 1, 200, D.tauKm),
    detour: num(b.detour, "detour", 1, 3, D.detour),
    budgetLakh: num(b.budget_lakh, "budget_lakh", 1, 1e6, D.budgetLakh),
    hardwareCost: { ...D.hardwareCost, ...(cm.hardware_cost_lakh || {}) },
    siteCost: { ...D.siteCost, ...(cm.site_cost_lakh || {}) },
    commercial: { ...D.commercial, ...(b.commercial || {}) },
    weights: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, +v])),
  };
}
function warnings(ctx, sites, geo) {
  const w = [];
  if (ctx.censusFlag === "imputed") w.push("Demand uses Census 2011 totals apportioned to post-2011 district boundaries (imputed).");
  w.push("Demand is Census 2011 population; growth since 2011 is not modelled.");
  if (!/uploaded/.test(ctx.pressureSource)) w.push("EV pressure uses Census 2011 vehicle ownership as a proxy, not EV registrations.");
  w.push(ctx.metric === "network" ? "Distances are routed on a coarse 1:10m highway graph." : "Distances are straight-line × detour factor, not routed.");
  const unk = sites.filter(c => c.missing && c.missing.includes("feasibility")).length;
  if (unk) w.push(`${unk} selected site(s) have unknown host feasibility; their scores were renormalised.`);
  w.push("Charger listings are point-in-time and not verified as operational.");
  w.push("Grid capacity, land, permits and safety are not assessed. Shortlist is for field validation.");
  return w;
}

/* ---------- routes ---------- */
async function route(req, url) {
  const t0 = Date.now();
  try {
    const path = url.pathname.slice(API.length).replace(/\/+$/, "") || "/";
    const m = req.method.toUpperCase();
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    if (path === "/" && m === "GET") return json(index());
    if (path === "/openapi.json" && m === "GET") return json(openapi());
    const { india, roads } = await core();
    if (path === "/geographies" && m === "GET") {
      const st = url.searchParams.get("state");
      const list = st ? india.districts.filter(d => d.sid === st).map(d => ({ id: d.id, name: d.name, level: "district", state: d.sid }))
        : india.states.map(s => ({ id: s.id, name: s.name, level: "state", districts: india.districts.filter(d => d.sid === s.id).length }));
      return json({ count: list.length, geographies: list, hint: st ? undefined : "add ?state=<id> to list its districts" });
    }
    let mm;
    if ((mm = path.match(/^\/geographies\/([a-z0-9.\-]+)\/baseline$/)) && m === "GET") {
      const geo = resolveGeo(india, mm[1]);
      const q = Object.fromEntries(url.searchParams);
      if (geo.level === "india") return json({ geography: geo, stats: india.totals, data: dataInfo(india), quality_warnings: ["National figures use the precomputed 5/10/25 km straight-line thresholds."] });
      const opts = buildOpts({ threshold_km: q.threshold_km, detour: q.detour, distance_metric: q.distance_metric, charger_filter: q.charger_filter });
      const sd = await stateData(geo.sid);
      const graph = opts.metric === "network" ? (self._rgGraph ||= self.RGEngine.buildGraph(roads)) : null;
      const ctx = self.RGRegion.buildContext({ india, stateData: sd, roads, districtIds: geo.did ? [geo.did] : null, opts, graph });
      const h = self.RGEngine.histogram(ctx.cells, ctx.base.dist);
      return json({
        geography: { id: geo.id, name: geo.name, level: geo.level },
        assumptions: { threshold_km: opts.tauKm, distance_metric: opts.metric, detour: opts.detour, charger_filter: opts.chargerFilter },
        baseline_metrics: { weighted_coverage: ctx.base.coverage, covered_population: Math.round(ctx.base.covered), population: Math.round(ctx.base.total), mean_distance_km: ctx.base.meanDist, demand_cells: ctx.cells.length,
          distance_distribution: h.edges.slice(0, -1).map((e, i) => ({ from_km: e, to_km: isFinite(h.edges[i + 1]) ? h.edges[i + 1] : null, population_share: h.values[i] / h.total })) },
        layer_coverage: { chargers: geo.stats.chargers, verified_share: geo.stats.verified, power_known_share: geo.stats.power_known ?? null, census: geo.stats.census_flag || `${geo.stats.districts - geo.stats.imputed_districts}/${geo.stats.districts} districts one-to-one`, official_pcs_mar2024: geo.stats.official_pcs_mar2024 ?? null },
        data: dataInfo(india), quality_warnings: warnings(ctx, [], geo), elapsed_ms: Date.now() - t0,
      });
    }
    if (path === "/scenarios" && m === "GET") {
      const all = await listScenarios();
      return json({ count: all.length, scenarios: all.map(s => ({ scenario_id: s.scenario_id, created_at: s.created_at, geography_id: s.inputs.geography_id, objective_profile: s.inputs.objective_profile, coverage: s.proposed_metrics.weighted_coverage, sites: s.selected_candidate_ids.length })) });
    }
    if (path === "/scenarios" && m === "POST") {
      let body; try { body = await req.json(); } catch { throw new HttpError(400, "body must be JSON"); }
      const geo = resolveGeo(india, body.geography_id);
      if (geo.level === "india") throw new HttpError(400, "scenarios run on a state or district geography");
      const profile = body.objective_profile || "coverage";
      if (!PROFILES[profile]) throw new HttpError(400, `objective_profile must be one of ${Object.keys(PROFILES).join(", ")}`);
      const opts = buildOpts(body);
      const inputs = { geography_id: geo.id, distance_metric: opts.metric, threshold_km: opts.tauKm, detour: opts.detour, budget_lakh: opts.budgetLakh, cost_model: { hardware: opts.hardware, hardware_cost_lakh: opts.hardwareCost, site_cost_lakh: opts.siteCost }, objective_profile: profile, score_weights: opts.weights, charger_filter: opts.chargerFilter, include_sensitivity: !!body.include_sensitivity };
      const id = "scn_" + fnv(JSON.stringify([india.version, inputs]));
      const existing = await getScenario(id);
      if (existing && !(body.include_sensitivity && !existing.sensitivity)) return json({ ...summary(existing), reused: true, note: "Identical inputs and data build: returning the stored scenario (reproducible by construction)." }, 200, { Location: `${API}/scenarios/${id}` });
      const sd = await stateData(geo.sid);
      const args = { districtIds: geo.did ? [geo.did] : null, opts };
      const base = self.RGJobs.baseArgs(args, { india, roads, stateData: sd });
      const { ctx, cands } = self.RGRegion.analyse(base);
      const plans = self.RGEngine.runScenarios(ctx, cands, opts);
      const plan = plans[PROFILES[profile]];
      const rec = {
        scenario_id: id, created_at: new Date().toISOString(), api_version: VERSION, data_build: india.version,
        inputs, geography: { id: geo.id, name: geo.name, level: geo.level },
        selected_candidate_ids: plan.selected.map(c => c.id),
        baseline_metrics: { weighted_coverage: ctx.base.coverage, covered_population: Math.round(ctx.base.covered), population: Math.round(ctx.base.total), mean_distance_km: ctx.base.meanDist },
        proposed_metrics: { weighted_coverage: plan.metrics.coverage, newly_covered_population: Math.round(plan.metrics.newlyCovered), coverage_gain: plan.metrics.coverage - ctx.base.coverage, mean_distance_km: plan.metrics.meanDist, cost_lakh: plan.metrics.cost, sites: plan.metrics.sites, cost_per_newly_covered_person_rs: plan.metrics.costPerPerson, worst_served_reached: plan.metrics.worstServed, equity_gap: plan.metrics.equityGap },
        comparison: Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, { name: p.name, coverage: p.metrics.coverage, cost_lakh: p.metrics.cost, sites: p.metrics.sites, newly_covered_population: Math.round(p.metrics.newlyCovered) }])),
        selected_sites: plan.selected.map((c, i) => ({ rank: i + 1, id: c.id, label: c.label, host: c.host, lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), cost_lakh: c.cost, score: +c.score.toFixed(2), score_decomposition: c.comp, unknown_components: c.missing, marginal_gain: plan.steps[i] ? plan.steps[i].gain : null, confidence: self.RGEngine.confidenceFor(c, ctx).grade })),
        assumptions: { ...inputs, demand: "Census 2011 population on derived hex cells", pressure: ctx.pressureSource, candidates: cands.length },
        confidence_warnings: warnings(ctx, plan.selected, geo),
        provenance: india.sources.map(s => ({ id: s.id, title: s.title, licence: s.licence, sha256: s.sha256 || null, kind: s.kind })),
        sensitivity: body.include_sensitivity ? self.RGEngine.sensitivity(o => self.RGRegion.analyse({ ...base, opts: o }), opts) : null,
        elapsed_ms: Date.now() - t0,
      };
      await putScenario(rec);
      return json(summary(rec), 201, { Location: `${API}/scenarios/${id}` });
    }
    if ((mm = path.match(/^\/scenarios\/(scn_[0-9a-f]{8})$/))) {
      if (m === "GET") { const rec = await getScenario(mm[1]); if (!rec) throw new HttpError(404, "scenario not found"); return json(rec); }
      if (m === "DELETE") { await deleteScenario(mm[1]); return new Response(null, { status: 204 }); }
    }
    throw new HttpError(m === "GET" || m === "POST" || m === "DELETE" ? 404 : 405, `no route for ${m} ${path}`);
  } catch (e) {
    const status = e.status || 500;
    return json({ error: { status, message: e.message, detail: e.detail || null } }, status);
  }
}
function summary(r) {
  return { scenario_id: r.scenario_id, selected_candidate_ids: r.selected_candidate_ids, baseline_metrics: r.baseline_metrics, proposed_metrics: r.proposed_metrics, assumptions: r.assumptions, confidence_warnings: r.confidence_warnings, links: { self: `${API}/scenarios/${r.scenario_id}` } };
}
function dataInfo(india) { return { build: india.version, built: india.built, sources: india.sources.map(s => ({ id: s.id, observed: s.observed, retrieved: s.retrieved, licence: s.licence })) }; }
function index() {
  return { name: "ReachGrid India API", version: VERSION, transport: "service worker (runs in your browser; no server)", docs: SCOPE + "api.html", openapi: `${API}/openapi.json`,
    endpoints: [`GET ${API}/geographies`, `GET ${API}/geographies/{id}/baseline`, `POST ${API}/scenarios`, `GET ${API}/scenarios`, `GET ${API}/scenarios/{id}`, `DELETE ${API}/scenarios/{id}`] };
}
function openapi() {
  const geoParam = { name: "id", in: "path", required: true, schema: { type: "string" }, example: "jharkhand.east-singhbhum" };
  return {
    openapi: "3.1.0",
    info: { title: "ReachGrid India API", version: VERSION, description: "Implements the proposal's §7.2 contracts. Served by a service worker: callable from pages on this origin." },
    servers: [{ url: API }],
    paths: {
      "/geographies": { get: { summary: "List states, or districts of ?state=", parameters: [{ name: "state", in: "query", schema: { type: "string" } }], responses: { 200: { description: "List" } } } },
      "/geographies/{id}/baseline": { get: { summary: "Baseline access metrics, layer coverage, data dates and quality warnings", parameters: [geoParam, ...["threshold_km", "detour", "distance_metric", "charger_filter"].map(n => ({ name: n, in: "query", schema: { type: "string" } }))], responses: { 200: { description: "Baseline" }, 404: { description: "Unknown geography" } } } },
      "/scenarios": {
        get: { summary: "List stored scenarios", responses: { 200: { description: "List" } } },
        post: { summary: "Run a scenario", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["geography_id"], properties: {
          geography_id: { type: "string" }, distance_metric: { enum: ["straight", "network"] }, threshold_km: { type: "number" }, detour: { type: "number" }, budget_lakh: { type: "number" },
          cost_model: { type: "object", properties: { hardware: { enum: ["dc60", "dc30", "ac22"] }, hardware_cost_lakh: { type: "object" }, site_cost_lakh: { type: "object" } } },
          objective_profile: { enum: Object.keys(PROFILES) }, score_weights: { type: "object" }, charger_filter: { enum: ["all", "dc", "verified"] }, include_sensitivity: { type: "boolean" } } } } } },
          responses: { 201: { description: "scenario_id, selected_candidate_ids, baseline_metrics, proposed_metrics, assumptions, confidence_warnings" }, 200: { description: "Identical scenario already stored" }, 400: { description: "Invalid input" } } },
      },
      "/scenarios/{id}": { get: { summary: "Stored inputs, selected sites, score decomposition, coverage deltas, sensitivity, provenance", parameters: [{ ...geoParam, example: "scn_0123abcd" }], responses: { 200: { description: "Scenario" }, 404: { description: "Not found" } } }, delete: { summary: "Delete a stored scenario", responses: { 204: { description: "Deleted" } } } },
    },
  };
}
