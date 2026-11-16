/* ReachGrid desktop local server.
 * - serves the bundled app (with a writable data overlay for downloaded data updates)
 * - serves the §7.2 scenario API over real HTTP on 127.0.0.1 (curl, Python, Excel can call it) with an API key
 * - proxies and caches basemap tiles on disk (offline maps)
 * - proxies OSRM street routing and Overpass (live OpenStreetMap) without browser CORS limits
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

function createServer({ appDir, userDir, gov, log = () => {} }) {
  const overlayDir = path.join(userDir, "data-overlay");
  const tileDir = path.join(userDir, "tiles");
  const scenDir = path.join(userDir, "scenarios");
  for (const d of [overlayDir, tileDir, scenDir]) fs.mkdirSync(d, { recursive: true });

  /* ---------- engine in this process (same browser scripts, evaluated in a sandbox global) ---------- */
  const G = { console, setTimeout, clearTimeout, Math, Date, JSON };
  G.window = G; G.self = G; G.globalThis = G;
  const ctx = vm.createContext(G);
  const load = (rel) => vm.runInContext(readApp(rel, "utf8"), ctx, { filename: rel });
  function readApp(rel, enc) {
    const o = path.join(overlayDir, rel);
    if (rel.startsWith("data/") && fs.existsSync(o)) return fs.readFileSync(o, enc);
    return fs.readFileSync(path.join(appDir, rel), enc);
  }
  for (const f of ["vendor/lp-solver.js", "js/engine.js", "js/region.js", "js/advanced.js", "js/jobs.js", "js/apicore.js"]) load(f);
  let coreLoaded = false;
  const core = async () => { if (!coreLoaded) { load("data/india.js"); load("data/roads.js"); coreLoaded = true; } return { india: G.RG_INDIA, roads: G.RG_ROADS }; };
  const stateData = async (sid) => { if (!/^[a-z0-9-]+$/.test(sid)) throw new Error("bad state id"); if (!G.RG_STATE || !G.RG_STATE[sid]) load(`data/state/${sid}.js`); return G.RG_STATE[sid]; };
  const reloadData = () => { coreLoaded = false; G.RG_STATE = {}; G._rgGraph = null; };

  const scenFile = (id) => path.join(scenDir, id.replace(/[^a-z0-9_]/gi, "") + ".json");
  const api = G.RGApiCore.createAPI({
    global: G, API: "/api/v1", SCOPE: "/", transport: "ReachGrid desktop local server (HTTP on 127.0.0.1)", docs: "/api.html",
    core, stateData,
    putScenario: async (rec) => { fs.writeFileSync(scenFile(rec.scenario_id), JSON.stringify(rec)); gov && gov.auditAdd("api.scenario.create", `${rec.scenario_id} ${rec.inputs.geography_id}`, "api"); },
    getScenario: async (id) => { const f = scenFile(id); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined; },
    listScenarios: async () => fs.readdirSync(scenDir).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(path.join(scenDir, f), "utf8"))),
    deleteScenario: async (id) => { const f = scenFile(id); if (fs.existsSync(f)) fs.unlinkSync(f); gov && gov.auditAdd("api.scenario.delete", id, "api"); },
    authorize: async (req, method) => {
      // the app's own window carries the session token; external callers need the API key
      const key = req.headers["x-api-key"] || new URLSearchParams(req.query || "").get("api_key");
      const token = req.headers["x-session-token"];
      if (token && gov && gov.checkToken(token)) return null;
      if (!gov || !gov.settings().apiKey) return null;
      if (key !== gov.settings().apiKey) return { status: 401, message: "missing or wrong X-API-Key (Settings → Local API in the app)" };
      if (method !== "GET" && !gov.settings().apiWrite) return { status: 403, message: "write access is disabled for API keys (Settings → Local API → allow writes)" };
      return null;
    },
  });

  /* ---------- helpers ---------- */
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { "Cache-Control": "no-store", ...headers }); res.end(body); };
  const readBody = (req) => new Promise((ok, bad) => { let b = ""; req.on("data", c => { b += c; if (b.length > 5e6) { bad(new Error("body too large")); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", bad); });
  async function fetchBuf(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { "User-Agent": "ReachGrid-India-Desktop/1.0", ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 30000) });
    if (!r.ok) throw new Error(`${url.split("?")[0]} → HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /* ---------- tiles: disk cache first, then CARTO ---------- */
  async function tile(res, s, z, x, y) {
    const f = path.join(tileDir, z, x, y + ".png");
    if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), { "Content-Type": "image/png", "Cache-Control": "max-age=86400", "X-Tile": "cache" });
    try {
      const buf = await fetchBuf(`https://${"abcd".includes(s) ? s : "a"}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`, { timeout: 15000 });
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf);
      send(res, 200, buf, { "Content-Type": "image/png", "Cache-Control": "max-age=86400", "X-Tile": "network" });
    } catch (e) { send(res, 504, "tile unavailable offline", { "Content-Type": "text/plain" }); }
  }
  function lon2x(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
  function lat2y(lat, z) { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); }
  /** download tiles for a bounding box and zoom range; progress callback(done, total, failed) */
  async function prefetchTiles(bbox, zmin, zmax, onProgress, signal) {
    const jobs = [];
    for (let z = zmin; z <= zmax; z++) for (let x = lon2x(bbox[0], z); x <= lon2x(bbox[2], z); x++) for (let y = lat2y(bbox[3], z); y <= lat2y(bbox[1], z); y++) jobs.push([z, x, y]);
    if (jobs.length > 20000) throw new Error(`${jobs.length} tiles is too many; zoom in or lower the max zoom`);
    let done = 0, failed = 0, i = 0;
    const worker = async () => {
      while (i < jobs.length && !(signal && signal.aborted)) {
        const [z, x, y] = jobs[i++]; const f = path.join(tileDir, String(z), String(x), y + ".png");
        if (!fs.existsSync(f)) {
          try { const buf = await fetchBuf(`https://${"abcd"[(x + y) % 4]}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`, { timeout: 15000 }); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
          catch { failed++; }
        }
        done++; if (done % 10 === 0 || done === jobs.length) onProgress && onProgress(done, jobs.length, failed);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return { total: jobs.length, failed };
  }
  function dirSize(d) { let n = 0, files = 0; if (!fs.existsSync(d)) return { bytes: 0, files: 0 }; const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else { n += fs.statSync(q).size; files++; } } }; walk(d); return { bytes: n, files }; }

  /* ---------- request router ---------- */
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const p = decodeURIComponent(u.pathname);
      if (p === "/api/v1" || p.startsWith("/api/v1/")) {
        await core();
        const r = await api.route({ method: req.method, pathname: p, searchParams: u.searchParams, query: u.search, bodyText: req.method === "POST" ? await readBody(req) : "", headers: req.headers });
        return send(res, r.status, r.body, r.headers);
      }
      let m;
      if ((m = p.match(/^\/tiles\/([a-d])\/(\d{1,2})\/(\d+)\/(\d+)\.png$/))) return tile(res, m[1], m[2], m[3], m[4]);
      if (p === "/proxy/osrm") {
        const c = u.searchParams.get("coords") || "";
        if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?;-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(c)) return send(res, 400, "coords must be lng,lat;lng,lat");
        const buf = await fetchBuf(`https://router.project-osrm.org/route/v1/driving/${c}?overview=full&geometries=geojson`, { timeout: 30000 });
        return send(res, 200, buf, { "Content-Type": "application/json" });
      }
      if (p === "/proxy/overpass" && req.method === "POST") {
        const q = await readBody(req);
        for (const ep of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
          try { const buf = await fetchBuf(ep, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 180000 }); return send(res, 200, buf, { "Content-Type": "application/json" }); }
          catch (e) { log("overpass " + ep + " " + e.message); }
        }
        return send(res, 502, JSON.stringify({ error: "Overpass unavailable" }), { "Content-Type": "application/json" });
      }
      // static files (data overlay first)
      let rel = p === "/" ? "app.html" : p.replace(/^\/+/, "");
      if (rel.includes("..")) return send(res, 400, "bad path");
      const over = path.join(overlayDir, rel), file = rel.startsWith("data/") && fs.existsSync(over) ? over : path.join(appDir, rel);
      if (!file.startsWith(appDir) && !file.startsWith(overlayDir)) return send(res, 403, "forbidden");
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found");
      send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": rel.startsWith("data/") ? "no-cache" : "max-age=60" });
    } catch (e) {
      log("server error " + e.stack);
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: e.message }), { "Content-Type": "application/json" });
    }
  });

  function listen(port = 0) {
    return new Promise((ok, bad) => { server.once("error", bad); server.listen(port, "127.0.0.1", () => ok(server.address().port)); });
  }

  /* ---------- data updates from the published repository ---------- */
  const DATA_BASE = "https://raw.githubusercontent.com/akshatinnovate-png/EV-Infra-ReachGrid-India/main/";
  function currentBuild() { try { const t = readApp("data/india.js", "utf8"); return (t.match(/data build ([\w.-]+)/) || [])[1] || null; } catch { return null; } }
  async function checkDataUpdate() {
    const head = (await fetchBuf(DATA_BASE + "data/changes.js", { timeout: 20000 })).toString("utf8");
    const remote = (head.match(/data build ([\w.-]+)/) || [])[1] || null;
    return { current: currentBuild(), remote, available: !!remote && remote !== currentBuild() };
  }
  async function applyDataUpdate(onProgress) {
    const india = await core().then(() => G.RG_INDIA);
    const files = ["data/india.js", "data/roads.js", "data/changes.js", ...india.states.map(s => `data/state/${s.id}.js`)];
    const tmp = path.join(userDir, "data-overlay.tmp"); fs.rmSync(tmp, { recursive: true, force: true });
    let i = 0;
    for (const f of files) {
      const buf = await fetchBuf(DATA_BASE + f, { timeout: 60000 });
      if (!/^\/\* ReachGrid India data build/.test(buf.slice(0, 60).toString("utf8"))) throw new Error(`${f} is not a ReachGrid data file`);
      const out = path.join(tmp, f); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, buf);
      onProgress && onProgress(++i, files.length);
    }
    fs.rmSync(overlayDir, { recursive: true, force: true }); fs.renameSync(tmp, overlayDir); reloadData();
    return { build: currentBuild(), files: files.length };
  }
  function revertData() { fs.rmSync(overlayDir, { recursive: true, force: true }); fs.mkdirSync(overlayDir, { recursive: true }); reloadData(); return currentBuild(); }

  /** live OpenStreetMap substations → grid overlay (replaces the power-plant proxy in india.js) */
  async function refreshGridFromOSM(onProgress) {
    const q = '[out:json][timeout:900];area["ISO3166-1"="IN"][admin_level=2]->.in;(node["power"="substation"](area.in);way["power"="substation"](area.in););out center tags;';
    let buf = null, lastErr;
    for (const ep of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
      try { onProgress && onProgress("Querying " + new URL(ep).host + " (can take a few minutes)…"); buf = await fetchBuf(ep, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 960000 }); break; }
      catch (e) { lastErr = e; }
    }
    if (!buf) throw lastErr || new Error("Overpass unavailable");
    const els = JSON.parse(buf.toString("utf8")).elements || [];
    const pts = [];
    for (const e of els) { const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon; if (lat == null) continue; const v = String((e.tags || {}).voltage || "").split(";")[0]; pts.push(Math.round(lat * 1e4), Math.round(lon * 1e4), /^\d+$/.test(v) ? Math.round(+v / 1000) : 0); }
    if (pts.length / 3 < 1000) throw new Error(`only ${pts.length / 3} substations returned`);
    const t = readApp("data/india.js", "utf8"), i = t.indexOf("="), obj = JSON.parse(t.slice(i + 1).trim().replace(/;$/, ""));
    obj.grid = { kind: "substation", points: pts };
    obj.sources = obj.sources.filter(s => s.id !== "grid").concat([{ id: "grid", title: "Electricity infrastructure proxy: OpenStreetMap power substations (live refresh)", publisher: "OpenStreetMap contributors", url: "https://www.openstreetmap.org", licence: "ODbL 1.0", observed: new Date().toISOString().slice(0, 10), retrieved: new Date().toISOString().slice(0, 10), kind: "observed", limits: "Proximity only: spare capacity must come from the DISCOM." }]);
    const out = path.join(overlayDir, "data/india.js"); fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, t.slice(0, t.indexOf("\n") + 1) + "window.RG_INDIA=" + JSON.stringify(obj) + ";\n");
    reloadData();
    return { substations: pts.length / 3 };
  }

  return { listen, server, prefetchTiles, tileCacheSize: () => dirSize(tileDir), clearTiles: () => { fs.rmSync(tileDir, { recursive: true, force: true }); fs.mkdirSync(tileDir, { recursive: true }); }, checkDataUpdate, applyDataUpdate, revertData, currentBuild, refreshGridFromOSM, engine: G, core, stateData };
}

module.exports = { createServer, crypto };
