/* ReachGrid browser API — a service worker that serves the §7.2 API contracts from the shared core.
 * The desktop app serves the same core over a real local HTTP server. */
self.window = self;
importScripts("vendor/lp-solver.js", "js/engine.js", "js/region.js", "js/advanced.js", "js/jobs.js", "js/apicore.js");

const SCOPE = new URL(self.registration.scope).pathname;
const API = SCOPE + "api/v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const loaded = new Map();
function loadData(path) {
  if (!loaded.has(path)) loaded.set(path, fetch(SCOPE + path).then(r => { if (!r.ok) throw new Error(`data file ${path} not found`); return r.text(); }).then(t => { new Function(t)(); }));
  return loaded.get(path);
}
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("reachgrid-api", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("scenarios", { keyPath: "scenario_id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction("scenarios", mode), st = t.objectStore("scenarios"); const out = fn(st); t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); t.onerror = () => rej(t.error); }); }

const api = self.RGApiCore.createAPI({
  global: self, API, SCOPE, transport: "service worker (runs in your browser; no server)",
  core: async () => { await loadData("data/india.js"); await loadData("data/roads.js"); return { india: self.RG_INDIA, roads: self.RG_ROADS }; },
  stateData: async (sid) => { await loadData(`data/state/${sid}.js`); return self.RG_STATE[sid]; },
  putScenario: (rec) => tx("readwrite", st => st.put(rec)),
  getScenario: (id) => tx("readonly", st => st.get(id)),
  listScenarios: () => tx("readonly", st => st.getAll()),
  deleteScenario: (id) => tx("readwrite", st => st.delete(id)),
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !(url.pathname === API || url.pathname.startsWith(API + "/"))) return;
  e.respondWith((async () => {
    const r = await api.route({ method: e.request.method, pathname: url.pathname, searchParams: url.searchParams, bodyText: e.request.method === "POST" ? await e.request.text() : "", headers: e.request.headers });
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  })());
});
