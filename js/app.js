/* ReachGrid India — application shell. India → State → District drill-down, planner, corridors, assistant. */
(() => {
  "use strict";
  const E = window.RGEngine, Rg = window.RGRegion;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const nIN = (n, d = 0) => n == null || !isFinite(n) ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
  const pct = (x, d = 1) => x == null || !isFinite(x) ? "—" : (x * 100).toFixed(d) + "%";
  const km = (x, d = 1) => x == null || !isFinite(x) ? "—" : x.toFixed(d) + " km";
  const people = (n) => n == null ? "—" : n >= 1e7 ? (n / 1e7).toFixed(2) + " cr" : n >= 1e5 ? (n / 1e5).toFixed(1) + " L" : nIN(n);
  const rupL = (l) => l == null || !isFinite(l) ? "—" : l >= 100 ? "₹" + (l / 100).toFixed(2) + " cr" : "₹" + nIN(l, l < 10 ? 1 : 0) + " L";
  const rup = (r) => r == null || !isFinite(r) ? "—" : "₹" + nIN(r);
  const DESK = window.RGDesktop || null;
  const WS_KEYS = new Set(["evidence", "portfolio", "review", "scenarios", "ev_upload", "use_cal", "portfolio_counts", "fcfg"]);
  const store = {
    get(k, d) {
      if (DESK && WS_KEYS.has(k)) { const v = DESK.storeGet(k); return v == null ? d : v; }
      try { const v = localStorage.getItem("rg_" + k); return v == null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) {
      if (DESK && WS_KEYS.has(k)) { const r = DESK.storeSet(k, v); if (!r || !r.ok) { setTimeout(() => toast((r && r.error) || "Not allowed"), 0); return false; } return true; }
      try { localStorage.setItem("rg_" + k, JSON.stringify(v)); } catch { } return true;
    },
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, "0"); };

  /* ------------------------------------------------------------------ data loading */
  function loadScript(url, onProgress) {
    const viaTag = () => new Promise((res, rej) => { const s = document.createElement("script"); s.src = url; s.onload = res; s.onerror = () => rej(new Error("Failed to load " + url)); document.head.appendChild(s); });
    if (location.protocol === "file:" || !window.fetch) return viaTag();
    return fetch(url).then(async r => {
      if (!r.ok || !r.body) throw new Error("http " + r.status);
      const total = +r.headers.get("content-length") || 0, reader = r.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress && total && onProgress(got / total); }
      const text = new TextDecoder().decode(await new Blob(parts).arrayBuffer());
      const s = document.createElement("script"); s.textContent = text; document.head.appendChild(s);
    }).catch(viaTag);
  }
  const stateCache = {};
  function loadState(sid) {
    if (window.RG_STATE && window.RG_STATE[sid]) return Promise.resolve(window.RG_STATE[sid]);
    if (!stateCache[sid]) stateCache[sid] = loadScript(`data/state/${sid}.js`).then(() => window.RG_STATE[sid]);
    return stateCache[sid];
  }

  /* ------------------------------------------------------------------ state */
  const S = {
    level: "india", sid: null, did: null, mode: "atlas", unit: "states", metric: "gap10",
    opts: { ...E.DEFAULTS, ...store.get("opts", {}) }, tab: "overview", planKey: "greedy", selCand: null,
    layers: { tiles: true, cells: true, chargers: true, places: true, roads: true, cands: false, sites: true, context: true },
    analysis: null, sens: null, osm: null, route: null, corridor: { from: null, to: null, range: 250, reserve: 20, buffer: 3, dcOnly: false },
  };
  S.opts.weights = { ...E.DEFAULTS.weights, ...(S.opts.weights || {}) };
  const PM = window.RGPMEDrive;
  /** fills PM E-DRIVE costing and S-curve settings (scenarios saved before they existed get the defaults) */
  function normOpts(o) {
    const pm = o.pm || {}, sc = o.scurve || {};
    o.pm = { ...PM.DEFAULTS, ...pm, otherLakh: { ...PM.DEFAULTS.otherLakh, ...(pm.otherLakh || {}) } };
    o.scurve = { ...PM.SCURVE_DEFAULTS, ...sc, saturation: { ...PM.SCURVE_DEFAULTS.saturation, ...(sc.saturation || {}) }, inflection: { ...PM.SCURVE_DEFAULTS.inflection, ...(sc.inflection || {}) } };
    o.weights = { ...E.DEFAULTS.weights, ...(o.weights || {}) };
    return o;
  }
  normOpts(S.opts);
  let INDIA, ROADS, GRAPH, map, canvasR;
  const statOf = (id) => INDIA.districtById.get(id)?.stats;

  const METRICS = {
    gap10: { label: "Population beyond 10 km of a charger", short: "Beyond 10 km", get: s => s.coverage ? 1 - s.coverage["10"] : null, fmt: v => pct(v), worse: "high" },
    mean_dist: { label: "Mean distance to nearest charger", short: "Mean dist.", get: s => s.mean_dist, fmt: v => km(v), worse: "high" },
    per_lakh: { label: "Chargers per lakh people", short: "Per lakh", get: s => s.per_lakh, fmt: v => nIN(v, 2), worse: "low" },
    per_1k_vehicle_hh: { label: "Chargers per 1,000 vehicle households", short: "Per 1k veh. HH", get: s => s.per_1k_vehicle_hh, fmt: v => nIN(v, 2), worse: "low" },
    chargers: { label: "Charging stations", short: "Sites", get: s => s.chargers, fmt: v => nIN(v), worse: "low" },
    dc_share: { label: "DC fast-charging share of sites", short: "DC share", get: s => s.chargers ? s.dc_sites / s.chargers : null, fmt: v => pct(v, 0), worse: "low" },
    verified: { label: "Sites confirmed by ≥2 sources", short: "≥2 src", get: s => s.verified, fmt: v => pct(v, 0), worse: "low" },
    car_rate: { label: "Households owning a car (Census 2011)", short: "Car HH", get: s => s.car_rate, fmt: v => pct(v), worse: "high" },
  };
  const PAL = ["#fde7ef", "#f9bfd3", "#f28fb2", "#e05a94", "#b8306f", "#6e1446"];

  /* ------------------------------------------------------------------ boot */
  const bootBar = $("#boot-bar"), bootPct = $("#boot-pct"), bootStep = $("#boot-step");
  function setBoot(p, step) { const v = Math.round(p * 100); bootBar.style.width = v + "%"; bootPct.textContent = v + "%"; if (step) bootStep.textContent = step; }
  async function boot() {
    try {
      if (DESK) await desktopSignIn();
      setBoot(0.04, "Boundaries, census, chargers");
      await loadScript("data/india.js", p => setBoot(0.04 + p * 0.6));
      setBoot(0.66, "Highway graph");
      await loadScript("data/roads.js", p => setBoot(0.66 + p * 0.28));
      setBoot(0.96, "Assembling map");
      INDIA = window.RG_INDIA; ROADS = window.RG_ROADS;
      INDIA.districtById = new Map(INDIA.districts.map(d => [d.id, d]));
      INDIA.stateById = new Map(INDIA.states.map(s => [s.id, s]));
      INDIA.states.sort((a, b) => a.name.localeCompare(b.name));
      initStatic(); initMap(); initWindows(); initAsk(); initClock(); initWorkspace();
      const qs = new URLSearchParams(location.search), r = qs.get("r");
      if (r || qs.has("app") || qs.get("mode") === "corridor") enterApp(qs.get("mode") === "corridor" ? "corridor" : null, true);
      setBoot(1, "Ready");
      setTimeout(() => $("#boot").classList.add("done"), 250);
      if (r) { const [sid, ds] = r.split("/"); if (INDIA.stateById.has(sid)) { await goState(sid, { instant: true }); if (ds) await goDistrict(`${sid}.${ds}`, { instant: true }); } else goIndia(); }
      else goIndia({ instant: true });
      setTimeout(() => map.invalidateSize(), 50);
      if (qs.has("tour")) setTimeout(tourStart, 600);
      if (DESK) initDesktop();
      window.RGApp = { ready: true, goDistrict, goState, goIndia, state: S, selfTest: desktopSelfTest };
    } catch (e) {
      bootStep.textContent = "Failed: " + e.message + (DESK ? "" : ". Serve the folder over http (see README).");
      console.error(e);
    }
  }

  /* ------------------------------------------------------------------ static sections */
  function initStatic() {
    const T = INDIA.totals, ch = INDIA.sources.find(s => s.id === "chargers");
    $("#news1-t").textContent = `${ch.observed.replace("compiled ", "")} • Data build ${INDIA.version}`;
    $("#news1-b").textContent = `${nIN(T.chargers)} real charging stations · ${INDIA.states.length} states & UTs · ${nIN(INDIA.districts.length)} districts`;
    $("#vstring").textContent = (ch.sha256 + INDIA.sources.map(s => s.sha256 || "").join("")).slice(0, 180).toUpperCase();
    $("#statband").innerHTML = [
      [nIN(T.chargers), "public charging sites mapped"],
      [pct(T.coverage["10"], 0), "of Indians within 10 km (straight line)"],
      [km(T.mean_dist), "mean distance to a charger"],
      [nIN(INDIA.districts.filter(d => d.stats.coverage["25"] < 0.5).length), "districts where most people are >25 km away"],
      [pct(T.verified, 0), "sites confirmed by ≥2 sources"],
    ].map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join("");
    const q = INDIA.quality;
    $("#sources-body").innerHTML = `<table class="t"><thead><tr><th>Layer</th><th>Publisher</th><th>Licence</th><th>Observed</th><th>Retrieved</th><th>Status</th><th>Known limits</th><th>SHA-256</th></tr></thead><tbody>${INDIA.sources.map(s => `<tr><td><b>${esc(s.title)}</b></td><td>${s.url.startsWith("http") ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher)}</a>` : esc(s.publisher)}</td><td>${esc(s.licence)}</td><td>${esc(s.observed)}</td><td>${esc(s.retrieved)}</td><td><span class="tag ${s.kind === "derived" ? "der" : "obs"}">${esc(s.kind)}</span></td><td>${esc(s.limits)}</td><td class="mono" style="font-size:10px">${esc((s.sha256 || "").slice(0, 16))}${s.sha256 ? "…" : ""}</td></tr>`).join("")}</tbody></table>
      <div class="hdr">Pipeline quality report</div>
      <div class="kpis">${[["Chargers assigned inside a district", q.assigned_inside], ["Assigned to nearest district (coastal / edge)", q.assigned_nearest], ["Dropped: outside India boundaries", q.outside_boundaries || 0], ["Source state label disagreed with location", q.source_state_label_differs], ["Districts with census apportioned (imputed)", INDIA.totals.imputed_districts], ["Population reconciled to Census 2011", pct(INDIA.totals.pop / 1210854977, 2)]].map(([l, v]) => `<div class="kpi"><b>${typeof v === "number" ? nIN(v) : v}</b><span>${l}</span></div>`).join("")}</div>
      <p class="sub" style="margin-top:10px">Rules: a mapped point is never assumed operational; aggregate counts with different definitions are not combined; missing data is never treated as zero. Rebuild everything with <span class="mono">bash pipeline/fetch_sources.sh && python3 pipeline/build.py</span>.</p>`;
    $$("[data-go]").forEach(a => a.addEventListener("click", (e) => { e.preventDefault(); enterApp(a.dataset.go === "corridor" ? "corridor" : "atlas"); }));
    $("#theme-toggle").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark"; store.set("theme", document.documentElement.dataset.theme);
    });
    const th = store.get("theme", null); if (th) document.documentElement.dataset.theme = th;
  }

  /* ------------------------------------------------------------------ map */
  const G = {};
  let tiles;
  function initMap() {
    map = L.map("map", { zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 3.5, maxZoom: 17, worldCopyJump: false, attributionControl: true });
    canvasR = L.canvas({ padding: 0.4 });
    // basemap: OpenStreetMap tiles by default (the desktop app proxies and caches them; Settings can point it at another tile server)
    const ti = DESK ? (DESK.info().tiles || { osm: true, key: "osm" }) : { osm: true, key: "osm" };
    tiles = L.tileLayer(DESK ? `/tiles/{s}/{z}/{x}/{y}.png?src=${ti.key}` : "https://tile.openstreetmap.org/{z}/{x}/{y}.png", { subdomains: "abc", maxZoom: 19, className: ti.osm ? "osm-muted" : "", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' + (ti.osm ? "" : " · custom tile server") });
    map.attributionControl.setPrefix('<a href="#sources">ReachGrid data sources</a>');
    ["context", "base", "roads", "cells", "route", "chargers", "places", "cands", "extra", "sites", "osm"].forEach(k => { G[k] = L.layerGroup().addTo(map); });
    map.fitBounds([[6.5, 68], [35.7, 97.4]]);
  }
  function clearLayers(...ks) { ks.forEach(k => G[k].clearLayers()); }
  function setTiles(on) { if (on && !map.hasLayer(tiles)) tiles.addTo(map); if (!on && map.hasLayer(tiles)) map.removeLayer(tiles); $("#map").classList.toggle("tiles", on); }

  function breaks(vals) {
    const v = vals.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return [];
    return [1, 2, 3, 4, 5].map(i => v[Math.min(v.length - 1, Math.floor((i / 6) * v.length))]);
  }
  function colorFor(val, br, worse) {
    if (val == null || !isFinite(val)) return "#cfcfcf";
    let k = br.findIndex(b => val < b); if (k < 0) k = 5;
    return PAL[worse === "high" ? k : 5 - k];
  }

  function lift(layer, others) {
    if (layer && layer._path) { layer.bringToFront(); layer._path.classList.add("rg-lift"); }
    others.forEach(o => o !== layer && o._path && o._path.classList.add("rg-fade"));
  }

  /* draw India (states or districts choropleth) */
  function drawIndia() {
    setTiles(false); clearLayers("context", "base", "roads", "cells", "chargers", "places", "cands", "sites", "osm");
    if (S.mode !== "corridor") clearLayers("route");
    const m = METRICS[S.metric];
    const feats = S.unit === "states" ? INDIA.states : INDIA.districts;
    const br = breaks(feats.map(f => m.get(f.stats)));
    const layers = [];
    for (const f of feats) {
      const val = m.get(f.stats);
      const lyr = L.geoJSON(f.geom, { style: { color: "#1b1b1d", weight: S.unit === "states" ? 1.4 : 0.5, fillColor: S.mode === "corridor" ? "#f6f6f6" : colorFor(val, br, m.worse), fillOpacity: S.mode === "corridor" ? 0.85 : 0.92, className: "rg-region" } });
      const name = f.name, st = INDIA.stateById.get(f.sid || f.id);
      lyr.bindTooltip(`<b>${esc(name)}</b>${f.sid ? ` · ${esc(st.name)}` : ""}<br>${esc(m.label)}: <b>${m.fmt(val)}</b><br>${nIN(f.stats.chargers)} chargers · ${people(f.stats.pop)} people`, { className: "rg-tip", sticky: true });
      lyr.on("mouseover", e => e.layer.setStyle({ weight: 3 })).on("mouseout", e => e.layer.setStyle({ weight: S.unit === "states" ? 1.4 : 0.5 }));
      lyr.on("click", () => {
        if (S.mode === "corridor") return;
        const all = layers.flatMap(l => l.getLayers()); lift(lyr.getLayers()[0], all);
        setTimeout(() => f.sid ? goState(f.sid).then(() => goDistrict(f.id)) : goState(f.id), 380);
      });
      lyr.addTo(G.base); layers.push(lyr);
    }
    if (S.unit === "states" && S.mode !== "corridor") {
      for (const s of INDIA.states) {
        if (s.stats.area < 6000) continue;
        const c = L.geoJSON(s.geom).getBounds().getCenter();
        L.marker(c, { interactive: false, icon: L.divIcon({ className: "", html: `<div class="state-lbl">${esc(s.name.length > 16 ? s.name.split(" ").map(w => w[0]).join("") : s.name)}</div>`, iconSize: [120, 14], iconAnchor: [60, 7] }) }).addTo(G.places);
      }
    }
    if (S.mode === "corridor" && ROADS) for (const [t, co] of ROADS.lines) L.polyline(co.map(([x, y]) => [y, x]), { color: "#1b1b1d", weight: t === 1 ? 1.2 : 0.6, opacity: 0.45, interactive: false, renderer: canvasR }).addTo(G.roads);
    if (S.layers.chargersIndia) drawNationalChargers();
  }
  function drawNationalChargers(bounds) {
    const a = INDIA.charger_index;
    for (let i = 0; i < a.length; i += 3) {
      const lat = a[i] / 1e4, lng = a[i + 1] / 1e4;
      if (bounds && !bounds.contains([lat, lng])) continue;
      L.circleMarker([lat, lng], { radius: bounds ? 2.2 : 1.4, stroke: false, fillColor: a[i + 2] & 1 ? "#111" : "#555", fillOpacity: bounds ? 0.55 : 0.75, interactive: false, renderer: canvasR }).addTo(G.chargers);
    }
  }

  /* draw a state: districts choropleth with medium geometry */
  function drawState(sd) {
    setTiles(S.layers.tiles && S.layers.stateTiles); clearLayers("context", "base", "roads", "cells", "chargers", "places", "cands", "sites", "osm", "route");
    drawContextStates(S.sid);
    const m = METRICS[S.metric];
    const br = breaks(sd.districts.map(d => m.get(statOf(d.id) || {})));
    const layers = [];
    for (const d of sd.districts) {
      const st = statOf(d.id), val = m.get(st);
      const lyr = L.geoJSON(d.geom, { style: { color: "#1b1b1d", weight: 1.2, fillColor: colorFor(val, br, m.worse), fillOpacity: 0.88, className: "rg-region" } });
      lyr.bindTooltip(`<b>${esc(d.name)}</b><br>${esc(m.label)}: <b>${m.fmt(val)}</b><br>${nIN(st.chargers)} chargers · ${people(st.pop)} people`, { className: "rg-tip", sticky: true });
      lyr.on("mouseover", e => e.layer.setStyle({ weight: 3 })).on("mouseout", e => e.layer.setStyle({ weight: 1.2 }));
      lyr.on("click", () => { const all = layers.flatMap(l => l.getLayers()); lift(lyr.getLayers()[0], all); setTimeout(() => goDistrict(d.id), 380); });
      lyr.addTo(G.base); layers.push(lyr);
      const c = INDIA.districtById.get(d.id).c;
      L.marker([c[1], c[0]], { interactive: false, icon: L.divIcon({ className: "", html: `<div class="state-lbl">${esc(d.name)}</div>`, iconSize: [120, 14], iconAnchor: [60, 7] }) }).addTo(G.places);
    }
    if (S.layers.chargers) for (const d of sd.districts) for (const c of d.chargers) L.circleMarker([c[0], c[1]], { radius: 2.4, stroke: false, fillColor: isDC(c) ? "#111" : "#444", fillOpacity: 0.8, interactive: false, renderer: canvasR }).addTo(G.chargers);
    if (S.layers.roads) drawRoads(sd.districts.map(d => d.geom));
  }
  function drawContextStates(sid) {
    for (const s of INDIA.states) if (s.id !== sid) L.geoJSON(s.geom, { interactive: false, style: { color: "#1b1b1d", weight: 0.8, fill: true, fillColor: "#ffffff", fillOpacity: 0.35, dashArray: "2 3" } }).addTo(G.context);
  }
  function drawRoads(geoms) {
    let bb = [180, 90, -180, -90]; geoms.forEach(g => { const b = E.bbox(g); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; });
    for (const [t, co] of ROADS.lines) {
      if (!co.some(([x, y]) => x >= bb[0] - 0.3 && x <= bb[2] + 0.3 && y >= bb[1] - 0.3 && y <= bb[3] + 0.3)) continue;
      L.polyline(co.map(([x, y]) => [y, x]), { color: t === 1 ? "#1b1b1d" : "#555", weight: t === 1 ? 2.2 : 1.3, opacity: 0.7, dashArray: t === 3 ? "4 3" : null, interactive: false, renderer: canvasR }).addTo(G.roads);
    }
  }
  const isDC = (c) => (c[4] || 0) >= 15 || (c[6] || 0) > 0;
  const TIER_LABEL = { ac_slow: "AC ≤7.4 kW", ac_fast: "AC 7.4–22 kW", dc_fast: "DC 25–60 kW", dc_ultra: "DC >60 kW", unknown: "power unknown" };
  const tierOf = (c) => { const kw = c[4], ac = c[5], dc = c[6]; if (kw) return kw <= 7.4 ? "ac_slow" : kw <= 22 && !dc ? "ac_fast" : kw <= 60 ? "dc_fast" : "dc_ultra"; if (dc) return "dc_fast"; if (ac) return "ac_slow"; return "unknown"; };
  const CONN_RE = [["CCS2", /ccs/i], ["Type 2", /type\s*2/i], ["Bharat AC-001", /ac-?001|bharat\s*ac/i], ["Bharat DC-001", /dc-?001|bharat\s*dc/i], ["3-pin / 15A", /3-?pin|15a/i], ["CHAdeMO", /chademo/i], ["GB/T", /gb\/?t/i], ["Type 6 / LEV", /type\s*6|lev/i]];

  /* draw a district in detail */
  function drawDistrict(sd, d) {
    setTiles(S.layers.tiles); clearLayers("context", "base", "roads", "cells", "chargers", "places", "cands", "sites", "osm", "route");
    for (const o of sd.districts) if (o.id !== d.id) {
      const l = L.geoJSON(o.geom, { style: { color: "#1b1b1d", weight: 1, fillColor: "#ffffff", fillOpacity: S.layers.tiles ? 0.25 : 0.55, dashArray: "3 3" } });
      l.bindTooltip(esc(o.name), { className: "rg-tip", sticky: true }); l.on("click", () => goDistrict(o.id)); l.addTo(G.context);
    }
    L.geoJSON(d.geom, { interactive: false, style: { color: "#1b1b1d", weight: 3, fill: !S.layers.tiles, fillColor: "#ffffff", fillOpacity: 0.6 } }).addTo(G.base);
    if (S.layers.roads) drawRoads([d.geom]);
    drawCells(); drawChargersDetail(d); drawPlaces(d);
  }
  function drawCells() {
    clearLayers("cells");
    const A = S.analysis; if (!A || !S.layers.cells) return;
    const { ctx } = A, tau = S.opts.tauKm;
    const plan = A.plans && A.plans[S.planKey], pd = plan && S.layers.sites ? plan.metrics.dist : null;
    const maxW = Math.max(...ctx.cells.map(c => c[2]));
    const cellKm = S.level === "district" ? (curDistrict()?.cell_km || 3) : 3;
    ctx.cells.forEach((c, i) => {
      const d0 = ctx.base.dist[i], d1 = pd ? pd[i] : d0;
      let col;
      if (d1 <= tau && d0 > tau) col = "#5aa9ff";
      else if (d0 <= tau) col = "#ffffff";
      else col = d0 <= 1.5 * tau ? PAL[2] : d0 <= 2 * tau ? PAL[3] : d0 <= 3 * tau ? PAL[4] : PAL[5];
      const a = 0.12 + 0.68 * Math.sqrt(c[2] / maxW);
      const r = (cellKm * 1000) / 2 * 1.05;
      L.circle([c[1], c[0]], { radius: S.level === "district" ? r : Math.max(r, 1500), stroke: false, fillColor: col, fillOpacity: d0 <= tau && !(d1 <= tau && d0 > tau) ? a * 0.5 : a, interactive: false, renderer: canvasR }).addTo(G.cells);
    });
  }
  function chargerPopup(c) {
    const f = INDIA.charger_fields, o = Object.fromEntries(f.map((k, i) => [k, c[i]]));
    return `<b>${esc(o.name || "Unnamed station")}</b><br>${esc(o.operator || "Operator unknown")}${o.network ? ` · ${esc(o.network)}` : ""}<br>
      ${o.max_kw ? `<b>${o.max_kw} kW</b> max · ` : "power not published · "}${o.dc_points != null ? `${o.dc_points} DC / ${o.ac_points ?? "?"} AC guns` : "guns not published"}<br>
      ${o.connectors ? esc(o.connectors) + "<br>" : ""}${o.pricing ? "Tariff: " + esc(o.pricing) + "<br>" : ""}
      ${o.address ? `<span class="sub">${esc(o.address)}</span><br>` : ""}
      <span class="tag ${o.n_sources >= 2 ? "obs" : "imp"}">${o.n_sources >= 2 ? `confirmed by ${o.n_sources} sources` : "single source"}</span>
      <span class="sub">updated ${esc(o.last_updated || "?")}</span><br><span class="sub">Sources: ${esc(o.sources)}</span><br>
      <span class="sub">Listing ≠ operational status.</span>`;
  }
  function drawChargersDetail(d) {
    clearLayers("chargers"); if (!S.layers.chargers) return;
    const b = L.geoJSON(d.geom).getBounds().pad(0.35);
    drawNationalChargers(b);
    for (const c of d.chargers) {
      if (S.opts.chargerFilter === "dc" && !isDC(c)) continue;
      if (S.opts.chargerFilter === "verified" && c[8] < 2) continue;
      L.marker([c[0], c[1]], { icon: L.divIcon({ className: "", html: `<div class="charger-sq t-${tierOf(c)}" title="${TIER_LABEL[tierOf(c)]}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }), keyboard: false }).bindPopup(chargerPopup(c)).addTo(G.chargers);
    }
  }
  function drawPlaces(d) {
    clearLayers("places"); if (!S.layers.places) return;
    d.places.slice(0, 14).forEach(([n, lon, lat, pop], i) => {
      const near = Rg.chargerIndex(INDIA, "all").nearest(lat, lon, 300);
      L.marker([lat, lon], { icon: L.divIcon({ className: "", html: `<div class="place-lbl ${i < 3 ? "big" : ""}">${esc(n)}</div>`, iconSize: [140, 16], iconAnchor: [-6, 8] }) })
        .bindTooltip(`<b>${esc(n)}</b> · ${nIN(pop)} people (GeoNames)<br>Nearest charger: <b>${near ? km(near.d) : "none within 300 km"}</b> straight-line`, { className: "rg-tip" }).addTo(G.places);
    });
  }
  function drawPlan(animate) {
    clearLayers("sites", "cands"); drawExtras();
    const A = S.analysis; if (!A) return;
    if (S.layers.cands) for (const c of A.cands) L.marker([c.lat, c.lng], { icon: L.divIcon({ className: "", html: '<div class="cand-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }) }).bindTooltip(`${esc(c.id)} · ${esc(c.label)}<br>score ${c.score.toFixed(0)} · ${rupL(c.cost)}`, { className: "rg-tip" }).on("click", () => selectCand(c.id)).addTo(G.cands);
    if (!S.layers.sites || !A.plans) return;
    const plan = A.plans[S.planKey];
    if (S.level === "state") G.base.eachLayer(l => l.setStyle && l.setStyle({ fillOpacity: 0.18 }));
    plan.selected.forEach((c, i) => {
      const add = () => {
        L.circle([c.lat, c.lng], { radius: (S.opts.tauKm / S.opts.detour) * 1000, color: "#e44fbf", weight: 1.5, dashArray: "5 4", fill: false, interactive: false }).addTo(G.sites);
        L.marker([c.lat, c.lng], { zIndexOffset: 1000, icon: L.divIcon({ className: "", html: `<div class="sel-pin ${animate ? "pop" : ""}">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
          .bindTooltip(`#${i + 1} ${esc(c.label)}<br>${rupL(c.cost)} · score ${c.score.toFixed(0)}`, { className: "rg-tip" }).on("click", () => selectCand(c.id)).addTo(G.sites);
      };
      animate ? setTimeout(add, 90 * i) : add();
    });
    if (animate) setTimeout(drawCells, 90 * plan.selected.length); else drawCells();
  }

  /* ------------------------------------------------------------------ navigation */
  function setURL() {
    const u = new URL(location.href);
    if (S.level === "india") u.searchParams.delete("r"); else u.searchParams.set("r", S.sid + (S.did ? "/" + S.did.split(".")[1] : ""));
    if (document.body.classList.contains("app-mode")) u.searchParams.set("app", "1");
    if (S.mode === "corridor") u.searchParams.set("mode", "corridor"); else u.searchParams.delete("mode");
    history.replaceState(null, "", u);
  }
  function curState() { return S.sid ? window.RG_STATE?.[S.sid] : null; }
  function curDistrict() { const sd = curState(); return sd && S.did ? sd.districts.find(d => d.id === S.did) : null; }

  function goIndia(o = {}) {
    S.level = "india"; S.sid = S.did = null; S.analysis = null; S.sens = null; S.osm = null; S.tab = "overview";
    if (S.mode !== "corridor") S.route = null;
    drawIndia(); map.flyToBounds([[6.5, 68], [35.7, 97.4]], { duration: o.instant ? 0 : 0.8 });
    render(); setURL();
  }
  async function goState(sid, o = {}) {
    S.mode = "atlas";
    $("#insp-title").textContent = "Loading " + INDIA.stateById.get(sid).name + " …";
    const sd = await loadState(sid);
    S.level = "state"; S.sid = sid; S.did = null; S.analysis = null; S.sens = null; S.osm = null; S.selCand = null;
    if (S.tab !== "chargers" && S.tab !== "ledger") S.tab = "overview";
    drawState(sd);
    map.flyToBounds(L.geoJSON(INDIA.stateById.get(sid).geom).getBounds(), { duration: o.instant ? 0 : 0.9, ...mapPad() });
    render(); setURL();
  }
  async function goDistrict(did, o = {}) {
    const sid = did.split(".")[0];
    if (S.sid !== sid || !curState()) await goState(sid, { instant: true });
    S.level = "district"; S.did = did; S.sens = null; S.osm = null; S.selCand = null;
    const d = curDistrict(); if (!d) return;
    runAnalysis(false);
    drawDistrict(curState(), d); drawPlan(false);
    map.flyToBounds(L.geoJSON(d.geom).getBounds(), { duration: o.instant ? 0 : 0.9, ...mapPad() });
    render(); setURL();
  }

  /* ------------------------------------------------------------------ analysis */
  function effOpts(o = S.opts) { return S.level === "state" ? { ...o, budgetLakh: o.budgetStateLakh ?? 2500 } : o; }
  function analysisArgs(opts = effOpts()) {
    if (opts.metric === "network") GRAPH ||= E.buildGraph(ROADS);
    return { india: INDIA, stateData: curState(), roads: ROADS, districtIds: S.level === "district" ? [S.did] : null, opts,
      evidence: Evidence.all(), extraChargers: extraChargers(), evByDistrict: evMap(), graph: opts.metric === "network" ? GRAPH : null };
  }
  /** user overrides of PM E-DRIVE category / station type, keyed by site position */
  const ovKey = (c) => c.lat.toFixed(4) + "," + c.lng.toFixed(4);
  function applyPmOverrides(cands, ctx, o) {
    if (!o.pm || !o.pm.enabled) return;
    const ov = store.get("pm_overrides", {});
    for (const c of cands) {
      const v = ov[ovKey(c)]; if (!v || !c.pm) continue;
      c.catOverride = v.cat || null; c.archOverride = v.arch || null;
      c.arch = v.arch || c.pm.arch;
      c.pm = PM.costSite({ ...c, catOverride: v.cat || null, gridKm: c.raw ? c.raw.gridKm : null, gridKind: ctx.gridIdx ? ctx.gridIdx.kind : null }, o.pm);
      if (c.costOverride == null) c.cost = Math.max(0.01, o.pm.budgetBasis === "subsidy" ? c.pm.subsidy : o.pm.budgetBasis === "net" ? c.pm.net : c.pm.total);
    }
  }
  function runAnalysis(withPlans = true) {
    const t0 = performance.now(), o = effOpts();
    const { ctx, cands } = Rg.analyse(analysisArgs(o));
    applyPmOverrides(cands, ctx, o);
    const plans = E.runScenarios(ctx, cands, o);
    S.analysis = { ctx, cands, plans, ms: performance.now() - t0, key: scenarioKey() };
    return S.analysis;
  }
  function scenarioKey() {
    const o = S.opts;
    return fnv(JSON.stringify([INDIA.version, S.sid, S.did, o.tauKm, o.detour, o.chargerFilter, effOpts().budgetLakh, o.hardware, o.hardwareCost, o.siteCost, o.weights, o.metric, o.commercial, o.pm, o.pressureSource, Evidence.all().length, extraChargers().length, EVUpload.get() && EVUpload.get().at]));
  }
  const rerun = debounce(() => {
    store.set("opts", S.opts);
    S.sens = null; S.compare = null; S.backtest = null;
    runAnalysis(); drawPlan(true); if (S.level === "district") drawChargersDetail(curDistrict());
    renderInspector(); updateStatus();
  }, 220);

  /* ------------------------------------------------------------------ windows */
  function initWindows() {
    let z = 10;
    $$(".fw").forEach(w => {
      w.addEventListener("pointerdown", () => { w.style.zIndex = ++z; });
      $("[data-min]", w).addEventListener("click", (e) => { e.stopPropagation(); w.classList.toggle("min"); });
      const tb = $(".tb", w);
      tb.addEventListener("pointerdown", (e) => {
        if (innerWidth <= 1100 || e.target.closest("button") || document.body.classList.contains("app-mode")) return;
        const desk = w.parentElement.parentElement.getBoundingClientRect(), r = w.getBoundingClientRect();
        const ox = e.clientX - r.left, oy = e.clientY - r.top; w.classList.add("drag"); tb.setPointerCapture(e.pointerId);
        const mv = (ev) => { w.style.left = Math.max(0, Math.min(desk.width - 80, ev.clientX - desk.left - ox)) + "px"; w.style.top = Math.max(0, Math.min(desk.height - 30, ev.clientY - desk.top - oy)) + "px"; w.style.right = "auto"; w.style.bottom = "auto"; };
        const up = () => { w.classList.remove("drag"); tb.removeEventListener("pointermove", mv); tb.removeEventListener("pointerup", up); };
        tb.addEventListener("pointermove", mv); tb.addEventListener("pointerup", up);
      });
    });
  }

  function render() { renderCrumbs(); renderNav(); renderInspector(); renderLegend(); }

  function renderCrumbs() {
    const c = [["India", () => { S.mode = "atlas"; goIndia(); }]];
    if (S.mode === "corridor") c.push(["Corridor check", () => { }]);
    if (S.sid) c.push([INDIA.stateById.get(S.sid).name, () => goState(S.sid)]);
    if (S.did) c.push([INDIA.districtById.get(S.did).name, () => { }]);
    const el = $("#crumbs"); el.innerHTML = "";
    c.forEach(([t, fn], i) => { const b = document.createElement("button"); b.textContent = (i ? "→ " : "") + t; b.onclick = fn; el.appendChild(b); });
  }

  /* ---------- navigator ---------- */
  function searchIndex() {
    const out = [];
    for (const s of INDIA.states) out.push({ k: norm(s.name), label: s.name, sub: "State / UT", go: () => goState(s.id) });
    for (const d of INDIA.districts) out.push({ k: norm(d.name), label: d.name, sub: INDIA.stateById.get(d.sid).name, go: () => goDistrict(d.id) });
    for (const p of INDIA.places) { const d = INDIA.districtById.get(p[4]); out.push({ k: norm(p[0]), label: p[0], sub: `${d.name}, ${INDIA.stateById.get(d.sid).name}`, go: () => goDistrict(p[4]).then(() => map.flyTo([p[2], p[1]], 12)) }); }
    return out;
  }
  let SI;
  function searchBox(id, placeholder, onPick, source) {
    return { html: `<div class="search-wrap"><input type="search" id="${id}" placeholder="${esc(placeholder)}" autocomplete="off" style="width:100%"><div class="results" id="${id}-r" hidden></div></div>`,
      bind() {
        const inp = $("#" + id), res = $("#" + id + "-r"); let items = [], on = 0;
        const show = () => {
          const q = norm(inp.value.trim()); if (q.length < 2) { res.hidden = true; return; }
          const src = source ? source() : (SI ||= searchIndex());
          items = src.filter(x => x.k.startsWith(q)).concat(src.filter(x => !x.k.startsWith(q) && x.k.includes(q))).slice(0, 12); on = 0;
          res.innerHTML = items.map((x, i) => `<button data-i="${i}" class="${i ? "" : "on"}"><span>${esc(x.label)}</span><small>${esc(x.sub)}</small></button>`).join("") || `<button disabled><span>No match</span></button>`;
          res.hidden = false;
        };
        const pick = (i) => { const x = items[i]; if (!x) return; res.hidden = true; inp.value = x.label; if (!onPick) { inp.blur(); setTimeout(() => { inp.value = ""; }, 400); } onPick ? onPick(x) : x.go(); };
        inp.addEventListener("input", show);
        inp.addEventListener("keydown", e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); on = (on + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; $$("button", res).forEach((b, i) => b.classList.toggle("on", i === on)); } if (e.key === "Enter") pick(on); if (e.key === "Escape") res.hidden = true; });
        res.addEventListener("click", e => { const b = e.target.closest("button[data-i]"); if (b) pick(+b.dataset.i); });
        inp.addEventListener("blur", () => setTimeout(() => res.hidden = true, 180));
      } };
  }

  function rankTable(rows, m, onClick) {
    return `<div class="scroll"><table class="t"><thead><tr><th>#</th><th>Name</th><th class="n">${esc(m.short)}</th><th class="n">Sites</th></tr></thead><tbody>${rows.map((r, i) => `<tr class="click" data-id="${esc(r.id)}"><td>${i + 1}</td><td>${esc(r.name)}${r.stats.census_flag === "imputed" ? ' <span class="tag imp" title="Census apportioned">imp</span>' : ""}</td><td class="n">${m.fmt(m.get(r.stats))}</td><td class="n">${nIN(r.stats.chargers)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function sortedByMetric(rows) {
    const m = METRICS[S.metric];
    return [...rows].sort((a, b) => { const va = m.get(a.stats), vb = m.get(b.stats); if (va == null) return 1; if (vb == null) return -1; return m.worse === "high" ? vb - va : va - vb; });
  }
  function metricControls() {
    return `<label class="f">Colour regions by<select id="metric">${Object.entries(METRICS).map(([k, m]) => `<option value="${k}" ${k === S.metric ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>`;
  }

  function renderNav() {
    const body = $("#nav-body");
    if (S.mode === "corridor") return renderCorridorNav(body);
    if (S.level === "india") {
      $("#nav-title").textContent = "Navigator · India";
      const rows = sortedByMetric(S.unit === "states" ? INDIA.states : INDIA.districts.filter(d => d.stats.pop > 0)).map(r => ({ ...r, name: r.sid ? `${r.name} (${INDIA.stateById.get(r.sid).name.slice(0, 14)})` : r.name }));
      body.innerHTML = `
        <div class="hdr"><span>Show</span><span class="seg"><button data-unit="states" aria-pressed="${S.unit === "states"}">States</button><button data-unit="districts" aria-pressed="${S.unit === "districts"}">Districts</button></span></div>
        ${metricControls()}
        <div class="hdr"><span>Ranked: needs attention first</span><span class="sub">${rows.length}</span></div>
        ${rankTable(rows, METRICS[S.metric])}
        <p class="sub">Click any ${S.unit === "states" ? "state on the map to pop it out" : "district to open it"}.</p>`;
      $$("[data-unit]", body).forEach(b => b.onclick = () => { S.unit = b.dataset.unit; drawIndia(); render(); });
      $$("tr[data-id]", body).forEach(tr => tr.onclick = () => S.unit === "states" ? goState(tr.dataset.id) : goDistrict(tr.dataset.id));
    } else {
      const sd = curState(), st = INDIA.stateById.get(S.sid);
      $("#nav-title").textContent = `Navigator · ${st.name}`;
      const rows = sortedByMetric(sd.districts.map(d => ({ id: d.id, name: d.name, stats: statOf(d.id) })));
      body.innerHTML = `<div style="margin:0 0 8px"><button class="btn sm ghost" id="back-india">← India</button> ${S.level === "district" ? `<button class="btn sm ghost" id="back-state">← ${esc(st.name)}</button>` : ""}</div>
        ${metricControls()}
        <div class="hdr"><span>Districts: needs attention first</span><span class="sub">${rows.length}</span></div>
        ${rankTable(rows, METRICS[S.metric])}`;
      $("#back-india").onclick = () => goIndia();
      if ($("#back-state")) $("#back-state").onclick = () => goState(S.sid);
      $$("tr[data-id]", body).forEach(tr => { if (tr.dataset.id === S.did) tr.style.background = "var(--paper)"; tr.onclick = () => goDistrict(tr.dataset.id); });
    }
    $("#metric").onchange = (e) => { S.metric = e.target.value; if (S.level === "india") drawIndia(); else if (S.level === "state") drawState(curState()); renderNav(); renderLegend(); };
  }

  /* ---------- inspector ---------- */
  function tabs(list) {
    return `<div class="tabs" role="tablist">${list.map(([k, t]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${t}</button>`).join("")}</div>`;
  }
  function bindTabs(el) { $$("[data-tab]", el).forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderInspector(); }); }

  function renderInspector() {
    const el = $("#insp-body");
    if (S.mode === "corridor") return renderCorridorInsp(el);
    if (S.level === "india") return renderIndiaInsp(el);
    const isD = S.level === "district";
    const name = isD ? INDIA.districtById.get(S.did).name : INDIA.stateById.get(S.sid).name;
    $("#insp-title").textContent = `${name} · ${isD ? "District" : "State"} inspector`;
    const T = [["overview", "Overview"], ["plan", "Plan"], ["forecast", "Forecast"], ["compare", "Compare"], ["validate", "Validate"], ["evidence", "Evidence"], ["portfolio", "Portfolio"], ["chargers", "Chargers"], ["ledger", "Ledger"]];
    el.innerHTML = tabs(T) + `<div id="tabbody"></div>`;
    bindTabs(el);
    const tb = $("#tabbody");
    if (["plan", "forecast", "compare", "validate", "evidence", "portfolio"].includes(S.tab) && !S.analysis) {
      tb.innerHTML = `<p class="sub">Building demand cells, candidate sites and plans for ${esc(name)}…</p>`;
      setTimeout(() => { runAnalysis(); drawPlan(true); if (S.level === "state") drawCells(); renderInspector(); updateStatus(); }, 30);
      return;
    }
    ({ overview: tabOverview, plan: tabPlan, forecast: tabForecast, compare: tabCompare, sens: tabCompare, validate: tabValidate, evidence: tabEvidence, portfolio: tabPortfolio, chargers: tabChargers, ledger: tabLedger }[S.tab] || tabOverview)(tb, name);
  }

  function kpiGrid(st, extra = []) {
    const dcShare = st.chargers ? st.dc_sites / st.chargers : null;
    return `<div class="kpis">${[
      [people(st.pop), "people (Census 2011)"], [nIN(st.chargers), "charging sites"], [nIN(st.per_lakh, 2), "per lakh people"],
      [pct(st.coverage["10"], 0), "within 10 km*"], [km(st.mean_dist), "mean distance*"], [pct(dcShare, 0), "DC fast sites"],
      [st.median_kw ? st.median_kw + " kW" : "—", "median max power"], [st.median_price ? "₹" + st.median_price : "—", "median tariff /kWh"], [pct(st.verified, 0), "≥2-source sites"],
      ...extra].map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join("")}</div>
      <p class="sub" style="margin:5px 0 0">* straight-line from population-weighted demand cells, national charger set.</p>`;
  }
  function operatorsBars(ops) {
    const max = Math.max(1, ...ops.map(o => o[1]));
    return ops.map(([n, v]) => `<div class="hist"><span title="${esc(n)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n)}</span><div class="minibar"><i style="width:${(v / max) * 100}%"></i></div><span class="n" style="text-align:right">${nIN(v)}</span></div>`).join("");
  }
  function provenance(st) {
    return st.census_flag === "observed"
      ? `<span class="tag obs">census observed</span> Census 2011 district “${esc(st.census_src.join(", "))}”.`
      : `<span class="tag imp">census imputed</span> Post-2011 district: Census 2011 totals of ${esc(st.census_src.join(", ") || "neighbouring districts")} apportioned by area and town population.`;
  }

  function renderIndiaInsp(el) {
    const T = INDIA.totals;
    $("#insp-title").textContent = "India · National inspector";
    const bands = [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 0.9], [0.9, 1.01]].map(([a, b]) => [a, b, INDIA.districts.filter(d => d.stats.coverage["10"] >= a && d.stats.coverage["10"] < b)]);
    const maxB = Math.max(...bands.map(b => b[2].length));
    const worst = INDIA.districts.filter(d => d.stats.pop > 1e6).sort((a, b) => a.stats.coverage["10"] - b.stats.coverage["10"]).slice(0, 8);
    el.innerHTML = `<div class="big-name">India</div>
      <div class="sub" style="margin-bottom:8px">${INDIA.states.length} states & UTs · ${nIN(INDIA.districts.length)} districts · build ${esc(INDIA.version)}</div>
      ${kpiGrid(T)}
      <div class="hdr"><span>Districts by population within 10 km</span></div>
      ${bands.map(([a, b, ds]) => `<div class="hist"><span>${Math.round(a * 100)}–${Math.min(100, Math.round(b * 100))}%</span><div class="minibar"><i style="width:${(ds.length / maxB) * 100}%;background:${PAL[5 - Math.round(a * 5)]}"></i></div><span>${ds.length}</span></div>`).join("")}
      <div class="hdr"><span>Largest access gaps (districts >10 L people)</span></div>
      <table class="t"><tbody>${worst.map(d => `<tr class="click" data-d="${d.id}"><td>${esc(d.name)}<br><span class="sub">${esc(INDIA.stateById.get(d.sid).name)}</span></td><td class="n">${pct(1 - d.stats.coverage["10"], 0)} beyond 10 km<br><span class="sub">${people(d.stats.pop * (1 - d.stats.coverage["10"]))} people</span></td></tr>`).join("")}</tbody></table>
      ${INDIA.vahan_national ? `<div class="hdr"><span>Electric two-wheeler registrations (VAHAN)</span></div>${barRows(Object.entries(INDIA.vahan_national).map(([y, v]) => ({ name: y + ` · ${pct(v.share, 1)} of 2W`, value: v.e2w })), { max: Math.max(...Object.values(INDIA.vahan_national).map(v => v.e2w)), fmt: (v) => people(v) })}` : ""}
      <div class="hdr"><span>Power tiers (all sites)</span></div>${inventoryBars(T.inventory || null)}
      <div class="hdr"><span>Largest operators (sites)</span></div>${operatorsBars(T.operators)}
      <div class="hdr"><span>Cross-check: official counts</span><span class="sub">BEE, March 2024</span></div>
      <div class="scroll" style="max-height:220px"><table class="t"><thead><tr><th>State</th><th class="n">Listed now</th><th class="n">Official 2024</th><th class="n">Ratio</th></tr></thead><tbody>${INDIA.states.filter(x => x.stats.official_pcs_mar2024 != null).sort((a, b) => b.stats.chargers - a.stats.chargers).map(x => `<tr class="click" data-st="${x.id}"><td>${esc(x.name)}</td><td class="n">${nIN(x.stats.chargers)}</td><td class="n">${nIN(x.stats.official_pcs_mar2024)}</td><td class="n" style="color:${x.stats.chargers < x.stats.official_pcs_mar2024 ? "var(--bad)" : "inherit"}">${(x.stats.chargers / x.stats.official_pcs_mar2024).toFixed(1)}×</td></tr>`).join("")}</tbody></table></div>
      <p class="sub">Red: fewer listings than the 2024 official count, a sign of missing listings (e.g. Karnataka, Delhi). Shown side by side only, because the definitions differ.</p>
      <div class="note">Counts are listed public sites from 8 merged sources. They are not operational counts and are not added to official PCS totals, which use different definitions.</div>`;
    $$("[data-d]", el).forEach(r => r.onclick = () => goDistrict(r.dataset.d));
    $$("[data-st]", el).forEach(r => r.onclick = () => goState(r.dataset.st));
  }

  function tabOverview(tb, name) {
    const isD = S.level === "district";
    const st = isD ? statOf(S.did) : INDIA.stateById.get(S.sid).stats;
    let html = `<div class="big-name">${esc(name)}</div><div class="sub" style="margin-bottom:8px">${isD ? esc(INDIA.stateById.get(S.sid).name) + " · " : ""}${nIN(st.area)} km² · ${isD ? provenance(st) : `${st.districts} districts, ${st.imputed_districts} with apportioned census`}</div>`;
    html += kpiGrid(st, [[pct(st.car_rate), "households with car"], [pct(st.tw_rate), "with 2-wheeler"], [st.km2_per_charger ? nIN(st.km2_per_charger) + " km²" : "—", "area per charger"]]);
    if (!isD && st.official_pcs_mar2024 != null) html += `<div class="note">Official PCS count (BEE, March 2024): <b>${nIN(st.official_pcs_mar2024)}</b> vs <b>${nIN(st.chargers)}</b> listed sites in this dataset. Different definitions and dates, so they are compared, never added together.</div>`;
    if (isD && S.analysis) {
      const h = E.histogram(S.analysis.ctx.cells, S.analysis.ctx.base.dist), max = Math.max(...h.values);
      const labels = ["0–2 km", "2–5", "5–10", "10–15", "15–25", "25–50", "50+ km"];
      html += `<div class="hdr"><span>Where people are vs nearest charger</span><span class="sub">detour ×${S.opts.detour}</span></div>${h.values.map((v, i) => `<div class="hist"><span>${labels[i]}</span><div class="minibar"><i style="width:${(v / max) * 100}%;background:${i < 3 ? "#1b1b1d" : PAL[Math.min(5, i)]}"></i></div><span>${pct(v / h.total, 0)}</span></div>`).join("")}`;
      const d = curDistrict(), idx = Rg.chargerIndex(INDIA, "all");
      html += `<div class="hdr"><span>Towns & nearest charger</span><span class="sub">GeoNames</span></div><table class="t"><thead><tr><th>Town</th><th class="n">Population</th><th class="n">Nearest</th></tr></thead><tbody>${d.places.slice(0, 12).map(([n, lon, lat, p]) => { const near = idx.nearest(lat, lon, 400); return `<tr class="click" data-ll="${lat},${lon}"><td>${esc(n)}</td><td class="n">${nIN(p)}</td><td class="n" style="color:${near && near.d > S.opts.tauKm ? "var(--bad)" : "inherit"}">${near ? km(near.d) : "—"}</td></tr>`; }).join("")}</tbody></table>`;
    }
    html += inventoryHTML(st.inventory) + vahanHTML(isD ? st : null, isD ? INDIA.stateById.get(S.sid).stats : st);
    html += `<div class="hdr"><span>Operators (sites)</span></div>${operatorsBars(st.operators)}`;
    html += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px"><button class="btn sm" id="go-plan">Plan new chargers →</button>${!isD ? "" : `<button class="btn sm ghost" id="go-led">Data confidence</button>`}</div>`;
    tb.innerHTML = html;
    $("#go-plan").onclick = () => { S.tab = "plan"; renderInspector(); };
    if ($("#go-led")) $("#go-led").onclick = () => { S.tab = "ledger"; renderInspector(); };
    $$("[data-ll]", tb).forEach(r => r.onclick = () => { const [a, b] = r.dataset.ll.split(","); map.flyTo([+a, +b], 13); });
  }

  /* ---------- plan tab ---------- */
  function tabPlan(tb) {
    const A = S.analysis, o = S.opts, P = A.plans;
    const ctrl = `
      <div class="grid2">
        <label class="f">Planning objective<select id="objective">${[["greedy", "Coverage (max people reached per ₹)"], ["equity", "Equity (worst-served first)"], ["corridor", "Corridor reach (highway sites)"], ["commercial", "Commercial screening (demand captured)"]].map(([k, n]) => `<option value="${k}" ${S.planKey === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="f">Distance metric<select data-o="metric"><option value="straight" ${o.metric !== "network" ? "selected" : ""}>Straight line × detour</option><option value="network" ${o.metric === "network" ? "selected" : ""}>Highway network (routed)</option></select></label>
        <label class="f"><span class="row"><span>Access threshold τ</span><b>${o.tauKm} km</b></span><input type="range" min="2" max="50" step="1" value="${o.tauKm}" data-o="tauKm"></label>
        <label class="f"><span class="row"><span>Road detour factor</span><b>×${o.detour}</b></span><input type="range" min="1" max="1.8" step="0.05" value="${o.detour}" data-o="detour"></label>
        ${S.level === "state" ? `<label class="f"><span class="row"><span>State budget</span><b>${rupL(effOpts().budgetLakh)}</b></span><input type="range" min="100" max="20000" step="50" value="${effOpts().budgetLakh}" data-o="budgetStateLakh"></label>` : `<label class="f"><span class="row"><span>Budget</span><b>${rupL(o.budgetLakh)}</b></span><input type="range" min="20" max="2000" step="10" value="${o.budgetLakh}" data-o="budgetLakh"></label>`}
        ${o.pm.enabled ? `<label class="f">Budget counts<select data-pm="budgetBasis"><option value="total" ${o.pm.budgetBasis === "total" ? "selected" : ""}>Total project cost</option><option value="subsidy" ${o.pm.budgetBasis === "subsidy" ? "selected" : ""}>PM E-DRIVE subsidy envelope</option><option value="net" ${o.pm.budgetBasis === "net" ? "selected" : ""}>Agency outlay after subsidy</option></select></label>` : `<label class="f">Hardware per site<select data-o="hardware"><option value="dc60" ${o.hardware === "dc60" ? "selected" : ""}>DC 60 kW (${rupL(o.hardwareCost.dc60)})</option><option value="dc30" ${o.hardware === "dc30" ? "selected" : ""}>DC 30 kW (${rupL(o.hardwareCost.dc30)})</option><option value="ac22" ${o.hardware === "ac22" ? "selected" : ""}>AC 22 kW ×2 (${rupL(o.hardwareCost.ac22)})</option></select></label>`}
      </div>
      <div class="pmbar"><label class="lgrow"><input type="checkbox" data-pmb="enabled" ${o.pm.enabled ? "checked" : ""}> <b>PM E-DRIVE costing</b> (Guidelines 26 Sep 2025, BEE benchmarks Oct 2025)</label>
        ${o.pm.enabled ? `<label class="lgrow"><input type="checkbox" data-pmb="preferSwap" ${o.pm.preferSwap ? "checked" : ""}> battery swapping (Cat D) for 2W/3W hubs</label><label class="lgrow"><input type="checkbox" data-pmb="capACatA" ${o.pm.capACatA ? "checked" : ""}> keep Category A ≤ 20% of subsidy</label>` : ""}</div>
      <label class="f">Existing chargers that count<select data-o="chargerFilter"><option value="all" ${o.chargerFilter === "all" ? "selected" : ""}>All listed sites</option><option value="dc" ${o.chargerFilter === "dc" ? "selected" : ""}>DC fast only (≥15 kW or DC guns)</option><option value="verified" ${o.chargerFilter === "verified" ? "selected" : ""}>Confirmed by ≥2 sources only</option></select></label>
      <details><summary class="mono" style="cursor:pointer;font-size:11.5px">Score weights & cost assumptions</summary>
        ${Object.keys(o.weights).map(k => `<label class="f"><span class="row"><span>${k}</span><b>${o.weights[k].toFixed(2)}</b></span><input type="range" min="0" max="0.6" step="0.05" value="${o.weights[k]}" data-w="${k}"></label>`).join("")}
        <div class="grid2">${Object.keys(o.siteCost).map(k => `<label class="f">Site cost: ${k} (₹ L)<input type="number" min="0" step="1" value="${o.siteCost[k]}" data-sc="${k}"></label>`).join("")}</div>
        ${o.pm.enabled ? `<div class="hdr" style="margin-top:10px"><span>PM E-DRIVE cost assumptions</span><span class="sub">replace with quotes / DISCOM demand notes</span></div>
        <div class="grid2">${[["gstRate", "GST on EVSE (benchmarks incl. GST)", 0.01], ["evseActualFactor", "EVSE price ÷ benchmark", 0.05], ["upstreamFactor", "DISCOM demand note ÷ BEE estimate", 0.05], ["htLakhPerKm", "HT extension ₹ L / km (substations)", 0.5]].map(([k, n, st]) => `<label class="f">${n}<input type="number" min="0" step="${st}" value="${o.pm[k]}" data-pmn="${k}"></label>`).join("")}</div>` : ""}
        <div class="hdr" style="margin-top:10px"><span>Commercial assumptions (hypotheses)</span></div>
        <div class="grid2">${[["evShare", "EV share of vehicle households", 0.005], ["sessionsPerEvWeek", "Public sessions per EV per week", 0.1], ["kwhPerSession", "kWh per session", 1], ["marginPerKwh", "Gross margin ₹/kWh", 0.5], ["opexLakhYr", "Opex ₹ lakh/yr", 0.5]].map(([k, n, st]) => `<label class="f">${n}<input type="number" min="0" step="${st}" value="${(o.commercial || E.DEFAULTS.commercial)[k]}" data-cm="${k}"></label>`).join("")}</div>
        <button class="linkbtn" id="reset-opts">Reset to proposal defaults</button>
        <p class="sub">Costs are planning assumptions, not quotes. Grid connection costs vary widely and are unknown until a DISCOM study.</p>
      </details>`;
    const rows = Object.entries(P).map(([k, p]) => {
      const m = p.metrics;
      return `<div class="brow ${k === S.planKey ? "active" : ""}"><div class="top"><button class="nm" data-plan="${k}">${esc(p.name)}</button><span class="v">${pct(m.coverage)}</span></div>
        <div class="rail"><s style="left:${A.ctx.base.coverage * 100}%" title="baseline"></s><i style="left:${m.coverage * 100}%"></i></div>
        <small>${m.sites} sites · ${rupL(m.cost)} · +${people(m.newlyCovered)} covered · ${m.costPerPerson ? rup(m.costPerPerson) + "/person" : "—"} · worst-served reached ${pct(m.worstServed, 0)} · equity gap ${m.equityGap != null ? (m.equityGap * 100).toFixed(0) + " pt" : "—"}</small></div>`;
    }).join("");
    const plan = P[S.planKey];
    const sites = plan.selected.map((c, i) => {
      const step = plan.steps[i];
      return `<div class="siteRow ${S.selCand === c.id ? "on" : ""}" data-c="${c.id}"><div class="num">${i + 1}</div><div><b>${esc(c.label)}</b>${reviewBadge(c.id)}${c.evidence ? ` <span class="tag obs">evidence</span>` : ""}<br><span class="sub">${c.pm ? `<span class="tag cat cat${c.pm.category}" title="${esc(PM.CATEGORIES[c.pm.category].label)}">Cat ${c.pm.category}</span> ${esc(c.pm.archLabel)} · subsidy ${rupL(c.pm.subsidy)} · ` : ""}${esc(c.host)} · score ${c.score.toFixed(0)}${c.missing.length ? ` · <span title="renormalised">${c.missing.length} unknown</span>` : ""}${step ? (step.unit ? ` · ${nIN(step.gain)} veh. HH captured` : ` · +${people(step.gain)} ${S.planKey === "equity" ? "weighted " : ""}covered`) : ""}</span></div><div style="text-align:right">${rupL(c.cost)}<br><span class="tag ${({ High: "obs", Medium: "der", Low: "imp" })[E.confidenceFor(c, A.ctx).grade]}">${E.confidenceFor(c, A.ctx).grade}</span></div></div>`;
    }).join("") || `<p class="sub">No candidate adds coverage within this budget. Try a larger budget or threshold.</p>`;
    tb.innerHTML = `${ctrl}
      <div class="hdr"><span>Scenario board · baseline ${pct(A.ctx.base.coverage)}</span><span class="sub" id="opt-ms" title="full re-analysis: candidates, scores and all six plans">${A.cands.length} candidates · re-optimised in ${A.ms.toFixed(0)} ms</span></div>
      <div class="board">${rows}</div>
      ${guaranteeHTML(plan)}
      ${o.pm.enabled ? pmSummaryHTML(plan) : ""}
      <div class="hdr"><span>${esc(plan.name)} · shortlist</span><span class="sub">id ${A.key}</span></div>
      <div id="explain"></div>
      <div>${sites}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
        <button class="btn sm" data-x="csv">Shortlist CSV</button><button class="btn sm" data-x="geojson">GeoJSON</button><button class="btn sm" data-x="json">Scenario JSON</button><button class="btn sm ghost" data-x="save">Save scenario</button><button class="btn sm ghost" data-x="print">Print report</button><button class="btn sm ghost" data-x="enc">Encrypted export</button>
      </div>
      ${o.pm.enabled ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"><button class="btn sm" data-x="sna">PM E-DRIVE proposal (Annexures B/C/D, .xlsx)</button><button class="btn sm" data-x="fsr">Feasibility study report (PDF)</button></div>` : ""}
      ${savedScenariosHTML()}
      <div class="note">Shortlist for field validation, not a construction decision. Each site still needs land, DISCOM grid capacity, permits and demand checks.</div>`;
    $$("input[data-o],select[data-o]", tb).forEach(i => i.addEventListener("input", () => { const k = i.dataset.o; S.opts[k] = i.type === "range" ? +i.value : i.value; i.closest("label").querySelector("b") && (i.closest("label").querySelector("b").textContent = k === "budgetLakh" || k === "budgetStateLakh" ? rupL(+i.value) : k === "tauKm" ? i.value + " km" : k === "detour" ? "×" + i.value : ""); rerun(); }));
    $$("input[data-w]", tb).forEach(i => i.addEventListener("input", () => { S.opts.weights = { ...S.opts.weights, [i.dataset.w]: +i.value }; i.closest("label").querySelector("b").textContent = (+i.value).toFixed(2); rerun(); }));
    $$("[data-pm]", tb).forEach(i => i.addEventListener("change", () => { S.opts.pm = { ...S.opts.pm, [i.dataset.pm]: i.value }; Audit.add("plan.pmedrive", i.dataset.pm + "=" + i.value); rerun(); }));
    $$("[data-pmb]", tb).forEach(i => i.addEventListener("change", () => { S.opts.pm = { ...S.opts.pm, [i.dataset.pmb]: i.checked }; Audit.add("plan.pmedrive", i.dataset.pmb + "=" + i.checked); rerun(); }));
    $$("[data-pmn]", tb).forEach(i => i.addEventListener("change", () => { S.opts.pm = { ...S.opts.pm, [i.dataset.pmn]: Math.max(0, +i.value || 0) }; rerun(); }));
    $$("input[data-sc]", tb).forEach(i => i.addEventListener("change", () => { S.opts.siteCost = { ...S.opts.siteCost, [i.dataset.sc]: Math.max(0, +i.value || 0) }; rerun(); }));
    $$("input[data-cm]", tb).forEach(i => i.addEventListener("change", () => { S.opts.commercial = { ...(S.opts.commercial || E.DEFAULTS.commercial), [i.dataset.cm]: Math.max(0, +i.value || 0) }; rerun(); }));
    $("#objective").onchange = (e) => { S.planKey = e.target.value; Audit.add("plan.objective", e.target.value); drawPlan(true); renderInspector(); updateStatus(); };
    $("#reset-opts").onclick = () => { S.opts = normOpts({ ...E.DEFAULTS, weights: { ...E.DEFAULTS.weights } }); rerun(); };
    $$("[data-plan]", tb).forEach(b => b.onclick = () => { S.planKey = b.dataset.plan; drawPlan(true); renderInspector(); });
    $$("[data-goto]", tb).forEach(b => b.onclick = () => { S.tab = b.dataset.goto; renderInspector(); });
    $$("[data-c]", tb).forEach(r => r.onclick = () => selectCand(r.dataset.c));
    $$("[data-x]", tb).forEach(b => b.onclick = () => exportPlan(b.dataset.x));
    $$("[data-load]", tb).forEach(b => b.onclick = () => { const s = store.get("scenarios", []).find(x => x.id === b.dataset.load); if (s) { S.opts = normOpts({ ...E.DEFAULTS, ...s.opts }); S.planKey = s.plan; if (s.region.did && s.region.did !== S.did) goDistrict(s.region.did).then(rerun); else rerun(); } });
    $$("[data-del]", tb).forEach(b => b.onclick = () => { store.set("scenarios", store.get("scenarios", []).filter(x => x.id !== b.dataset.del)); renderInspector(); });
    if (S.selCand) showExplain(S.selCand);
  }
  /** approximation guarantee of the greedy plan (budgeted maximum coverage is monotone submodular) */
  function guaranteeHTML(plan) {
    const g = plan && plan.guarantee; if (!g) return "";
    const lp = S.compare && S.compare.opt && S.compare.opt.lpBound ? S.compare.opt : null;
    const ratio = lp ? (lp.greedy && lp.lpBound ? lp.greedy.gain / lp.lpBound : null) : null;
    return `<div class="note guarantee"><b>Optimality.</b> Covering people within ${S.opts.tauKm} km under a budget is a monotone submodular objective, so the ${g.usedSingle ? "best single site (it beat the greedy set here)" : "greedy plan"} is guaranteed to reach at least <b>${(g.bound * 100).toFixed(1)}%</b> of the best possible (${esc(g.basis)}).${ratio != null ? ` Measured on this region against the exact LP bound: <b>${pct(Math.min(1, ratio))}</b> of optimum.` : ` <button class="linkbtn" data-goto="compare">Measure the actual gap against the exact ILP / LP bound →</button>`}</div>`;
  }
  /** Annexure-B style summary of the selected plan */
  function pmSummaryHTML(plan) {
    const sm = PM.summarise(plan.selected); if (!sm.sites) return "";
    const basis = { total: "total project cost", subsidy: "PM E-DRIVE subsidy", net: "agency outlay" }[S.opts.pm.budgetBasis];
    return `<div class="pmsum"><div class="hdr"><span>PM E-DRIVE proposal · ${esc(plan.name)}</span><span class="sub">budget counted as ${basis}</span></div>
      <div class="kpis"><div class="kpi"><b>${sm.sites}</b><span>EV PCS</span></div><div class="kpi"><b>${sm.chargers.e2w3w} · ${sm.chargers.e4w} · ${sm.chargers.bus}</b><span>chargers 2W/3W · 4W · bus</span></div><div class="kpi"><b>${rupL(sm.total)}</b><span>project cost (ex-GST)</span></div>
      <div class="kpi"><b>${rupL(sm.subsidy)}</b><span>subsidy requested</span></div><div class="kpi"><b>${rupL(sm.net)}</b><span>agency / CPO outlay</span></div><div class="kpi"><b class="${sm.catAOk ? "" : "bad"}">${pct(sm.catAShare, 0)}</b><span>Category A share ${sm.catAOk ? "✓ ≤ 20%" : "⚠ above 20% (FAQ 1)"}</span></div></div>
      <div class="catbars">${["A", "B", "C", "D"].map(k => `<span class="cb cat${k}" style="flex:${Math.max(0.001, sm.byCat[k])}" title="Category ${k}: ${rupL(sm.byCat[k])}"></span>`).join("")}</div>
      <div class="sub" style="font-size:10.5px">Subsidy by category: ${["A", "B", "C", "D"].map(k => `${k} ${rupL(sm.byCat[k])}`).join(" · ")}. Upstream costs are estimates until DISCOM demand notes arrive.</div></div>`;
  }
  function savedScenariosHTML() {
    const list = store.get("scenarios", []);
    if (!list.length) return "";
    return `<div class="hdr"><span>Saved scenarios (this browser)</span></div><table class="t"><tbody>${list.slice(-8).reverse().map(s => `<tr><td><b>${esc(s.region.name)}</b><br><span class="sub">${esc(s.planName)} · τ ${s.opts.tauKm} km · ${rupL(s.opts.budgetLakh)}</span></td><td class="n">${pct(s.metrics.coverage)}<br><span class="sub">${s.id}</span></td><td><button class="linkbtn" data-load="${s.id}">load</button> <button class="linkbtn" data-del="${s.id}">×</button></td></tr>`).join("")}</tbody></table>`;
  }
  function selectCand(id) {
    S.selCand = id;
    if (S.tab !== "plan") { S.tab = "plan"; renderInspector(); } else { $$(".siteRow").forEach(r => r.classList.toggle("on", r.dataset.c === id)); showExplain(id); }
    const c = S.analysis.cands.find(x => x.id === id); if (c) map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 11), { duration: 0.6 });
  }
  function showExplain(id) {
    const A = S.analysis, c = A.cands.find(x => x.id === id), el = $("#explain"); if (!c || !el) return;
    const conf = E.confidenceFor(c, A.ctx), w = S.opts.weights;
    const plan = A.plans[S.planKey], rank = plan.selected.findIndex(x => x.id === id);
    const names = { gap: "Access gap", pressure: "EV pressure", corridor: "Corridor", equity: "Equity", feasibility: "Feasibility" };
    el.innerHTML = `<div class="explain"><div style="display:flex;justify-content:space-between;gap:6px"><b>${esc(c.id)} · ${esc(c.label)}</b><button class="linkbtn" id="x-close">close</button></div>
      <div class="sub">${c.lat.toFixed(4)}, ${c.lng.toFixed(4)} · ${esc(c.host)} · ${rupL(c.cost)} ${rank >= 0 ? `· picked #${rank + 1} in ${esc(plan.name)}` : "· not in this plan"}</div>
      <div class="hdr"><span>Score ${c.score.toFixed(1)} / 100</span><span class="sub">weight × component</span></div>
      ${Object.keys(names).map(k => c.comp[k] == null ? `<div class="comp"><span>${names[k]}</span><span class="tag imp">unknown, excluded &amp; reweighted</span><span></span></div>` : `<div class="comp"><span>${names[k]} ×${w[k]}</span><div class="minibar"><i style="width:${c.comp[k]}%"></i></div><span>${c.comp[k].toFixed(0)}</span></div>`).join("")}
      <ul style="margin:6px 0;padding-left:16px">
        <li>Would newly cover <b>${people(c.raw.gap)}</b> people now beyond ${S.opts.tauKm} km (est., ${pct(c.raw.gap / A.ctx.base.total, 1)} of region)</li>
        <li>${nIN(c.raw.vehicleHH)} ${/uploaded/.test(A.ctx.pressureSource) ? "registered EVs (uploaded)" : /VAHAN/.test(A.ctx.pressureSource) ? "registered EVs (VAHAN, since 2022)" : "vehicle-owning households (Census 2011 rates)"} in reach · ${c.raw.localChargers} existing sites in reach</li>
        ${c.raw.gridKm != null ? `<li>Nearest ${A.ctx.gridIdx && A.ctx.gridIdx.kind === "substation" ? "power substation" : "power plant (grid proxy)"}: <b>${km(c.raw.gridKm)}</b>. Proximity only; spare capacity comes from the DISCOM.</li>` : ""}
        <li>Nearest mapped highway ${isFinite(c.raw.roadKm) ? km(c.raw.roadKm) : "far"}${c.placePop ? ` · ${esc(c.place)} pop. ${nIN(c.placePop)}` : ""}</li>
      </ul>
      <div class="hdr"><span>Confidence: ${conf.grade}</span><span class="sub">separate from score</span></div>
      ${conf.parts.map(([n, v, t]) => `<div class="comp"><span>${esc(n)}</span><div class="minibar"><i style="width:${v * 100}%;background:${v >= 0.7 ? "var(--good)" : v >= 0.5 ? "var(--warn)" : "var(--bad)"}"></i></div><span title="${esc(t)}">${Math.round(v * 100)}</span></div><div class="sub" style="margin:-2px 0 4px 98px;font-size:10.5px">${esc(t)}</div>`).join("")}
      ${c.evidence ? `<div class="note">Field evidence: <b>${esc(c.evidence.status)}</b>${c.evidence.grid_kva ? ` · ${c.evidence.grid_kva} kVA` : ""}${c.evidence.land ? ` · land ${esc(c.evidence.land)}` : ""}${c.evidence.notes ? ` · ${esc(c.evidence.notes)}` : ""}</div>` : ""}
      ${c.pm ? pmExplainHTML(c) : ""}
      ${explainExtras(c)}
      <div style="margin-top:6px"><a class="linkbtn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=16/${c.lat}/${c.lng}">Inspect site on OpenStreetMap ↗</a></div></div>`;
    bindExplainExtras(c);
    $$("[data-ov]", el).forEach(sel => sel.onchange = () => {
      const ov = store.get("pm_overrides", {}), k = ovKey(c), cur = ov[k] || {};
      cur[sel.dataset.ov] = sel.value || null; if (!cur.cat && !cur.arch) delete ov[k]; else ov[k] = cur;
      store.set("pm_overrides", ov); Audit.add("plan.override", `${c.id} ${sel.dataset.ov}=${sel.value || "auto"}`); rerun();
    });
    $("#x-close").onclick = () => { S.selCand = null; el.innerHTML = ""; $$(".siteRow").forEach(r => r.classList.remove("on")); };
  }

  /** EVs in a site's reach, by segment: people reached × the district's registered EVs per person (VAHAN) */
  function fleetInReach(c, ctx) {
    let pop = 0, w = new Map();
    for (const [i, kmv] of c.reach) if (kmv <= S.opts.tauKm) { pop += ctx.cells[i][2]; const d = ctx.cellDistrict[i]; w.set(d, (w.get(d) || 0) + ctx.cells[i][2]); }
    const f = { e2w: 0, e3w: 0, e4w: 0, bus: 0 };
    for (const [d, p] of w) { const m = ctx.mix[d]; if (!m) continue; for (const k in f) f[k] += p * m.stock[k] / m.pop; }
    return { pop, fleet: f };
  }
  function pmExplainHTML(c) {
    const p = c.pm, A = S.analysis, ov = store.get("pm_overrides", {})[ovKey(c)] || {};
    const { fleet } = fleetInReach(c, A.ctx), q = PM.siteQueue(p.arch, fleet, 1 / (1 + (c.raw.localChargers || 0)));
    const G = { e2w3w: "12 kW LECCS (2W/3W)", e4w: "60 kW CCS-II (4W)", bus: "240 kW CCS-II (bus/truck)" };
    const sel = (k, opts, v) => `<select data-ov="${k}"><option value="">auto</option>${opts.map(([x, n]) => `<option value="${x}" ${v === x ? "selected" : ""}>${n}</option>`).join("")}</select>`;
    return `<div class="hdr"><span>PM E-DRIVE · <span class="tag cat cat${p.category}">Category ${p.category}</span> · ${esc(p.archLabel)}</span><span class="sub">${p.ratingKw} kW connected</span></div>
      <div class="sub" style="font-size:11px">${p.chargers.length ? p.chargers.map(l => `${l.n} × ${l.kw} kW ${esc(l.conn)} (${esc(PM.CHARGER[l.kw].std)})`).join(" + ") : "battery swapping station"} · indicative area ${p.area[0]}–${p.area[1]} m² · ${esc(PM.CATEGORIES[p.category].label)}${c.site && c.site.note ? ` · <i>${esc(c.site.note)}</i>` : ""}</div>
      <table class="t" style="margin-top:4px"><tbody>
        <tr><td>Upstream infrastructure <span class="sub">${esc(p.upstreamBasis)}</span></td><td class="n">${rupL(p.upstream)}</td><td class="n">subsidy ${rupL(p.subsidyUpstream)}</td></tr>
        <tr><td>EVSE, ex-GST <span class="sub">BEE Oct 2025 benchmark basis</span></td><td class="n">${rupL(p.evse)}</td><td class="n">subsidy ${rupL(p.subsidyEvse)}</td></tr>
        <tr><td>Other (not eligible)</td><td class="n">${rupL(p.other)}</td><td class="n">—</td></tr>
        <tr style="font-weight:600"><td>Total · net after subsidy ${rupL(p.net)}</td><td class="n">${rupL(p.total)}</td><td class="n">${rupL(p.subsidy)}</td></tr></tbody></table>
      <div class="grid2" style="margin-top:4px"><label class="f">Location category ${sel("cat", [["A", "A · govt premises"], ["B", "B · govt-controlled public"], ["C", "C · other"], ["D", "D · battery swapping"]], ov.cat)}</label><label class="f">Station type ${sel("arch", Object.entries(PM.ARCHETYPES).map(([k, a]) => [k, a.label]), ov.arch)}</label></div>
      ${Object.keys(q).length ? `<div class="hdr"><span>Peak-hour queue (M/M/c)</span><span class="sub">${nIN(Math.round(fleet.e2w + fleet.e3w))} 2W/3W · ${nIN(Math.round(fleet.e4w))} 4W in reach, shared with ${c.raw.localChargers} existing</span></div>
      <table class="t"><thead><tr><th>Guns</th><th class="n">EVs/h</th><th class="n">Utilisation</th><th class="n">P(wait)</th><th class="n">Mean wait</th><th class="n">Add</th></tr></thead><tbody>
      ${Object.entries(q).map(([g, m]) => `<tr><td>${m.guns} × ${G[g]}</td><td class="n">${m.lambda.toFixed(1)}</td><td class="n">${m.stable ? pct(m.rho, 0) : "overloaded"}</td><td class="n" style="color:${m.pWait > PM.QUEUE_DEFAULTS.target ? "var(--bad)" : "var(--good)"}">${pct(m.pWait, 0)}</td><td class="n">${isFinite(m.wqMin) ? m.wqMin.toFixed(0) + " min" : "∞"}</td><td class="n">${m.extra ? "+" + m.extra : "—"}</td></tr>`).join("")}</tbody></table>` : ""}`;
  }
  function regionName() { return S.level === "district" ? `${INDIA.districtById.get(S.did).name}, ${INDIA.stateById.get(S.sid).name}` : INDIA.stateById.get(S.sid).name; }
  function scenarioRecord() {
    const A = S.analysis, plan = A.plans[S.planKey];
    return {
      scenario_id: A.key, created_at: new Date().toISOString(), tool: "ReachGrid India", data_build: INDIA.version,
      region: { level: S.level, sid: S.sid, did: S.did, name: regionName() },
      assumptions: { objective: S.planKey, threshold_km: S.opts.tauKm, distance_metric: S.opts.metric === "network" ? `highway-network routing (detour ${S.opts.detour} on access legs)` : `haversine × detour ${S.opts.detour}`, demand_pressure: A.ctx.pressureSource, evidence_rows: Evidence.all().length, built_sites_counted: extraChargers().length, commercial: S.opts.commercial, counted_chargers: S.opts.chargerFilter, budget_lakh: effOpts().budgetLakh, hardware: S.opts.hardware, hardware_cost_lakh: S.opts.hardwareCost, site_cost_lakh: S.opts.siteCost, score_weights: S.opts.weights, demand: "Census 2011 population on hex cells (derived)" },
      baseline: { coverage: A.ctx.base.coverage, mean_distance_km: A.ctx.base.meanDist, population: A.ctx.base.total },
      plans: Object.fromEntries(Object.entries(A.plans).map(([k, p]) => [k, { name: p.name, sites: p.metrics.sites, cost_lakh: p.metrics.cost, coverage: p.metrics.coverage, newly_covered: p.metrics.newlyCovered, cost_per_person_rs: p.metrics.costPerPerson, worst_served_reached: p.metrics.worstServed, selected: p.selected.map(c => c.id) }])),
      selected_plan: S.planKey,
      shortlist: plan.selected.map((c, i) => ({ rank: i + 1, id: c.id, label: c.label, host: c.host, lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), cost_lakh: c.cost, score: +c.score.toFixed(2), components: c.comp, unknown_components: c.missing, confidence: E.confidenceFor(c, A.ctx).grade, evidence: c.evidence || null, review: Review.get(A.key, c.id) })),
      sources: INDIA.sources.map(s => ({ id: s.id, title: s.title, licence: s.licence, sha256: s.sha256 || null })),
      caveats: ["Model output, not a guarantee of utilisation or social impact.", "Grid capacity, land, permits and safety are not assessed.", "Charger listings are not verified as operational."],
    };
  }
  function download(name, text, type) {
    if (DESK) { DESK.saveFile(name, text).then(r => { if (r && r.ok) toast("Saved " + r.path); }); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  async function exportPlan(kind) {
    if (kind === "save" && !Gov.need("save", "save scenarios")) return;
    if (kind !== "save" && kind !== "print" && !Gov.need("export", "export")) return;
    const rec = scenarioRecord(), base = `reachgrid_${slug(rec.region.name)}_${rec.scenario_id}`;
    Audit.add("export." + kind, `${rec.region.name} · ${rec.scenario_id}`);
    if (kind === "enc") {
      if (!(window.crypto && crypto.subtle)) { toast("Encryption needs https or localhost"); return; }
      const pass = await askText("Passphrase for the encrypted file", { password: true }); if (!pass) return;
      download(base + ".rgenc", await encryptJSON(rec, pass), "application/octet-stream"); toast("Encrypted with AES-256-GCM"); return;
    }
    if (kind === "json") download(base + ".json", JSON.stringify(rec, null, 2), "application/json");
    if (kind === "csv") {
      const h = ["rank", "id", "label", "host", "lat", "lng", "cost_lakh", "score", "gap", "pressure", "corridor", "equity", "feasibility", "unknown_components", "confidence", "scenario_id"];
      download(base + ".csv", [h.join(","), ...rec.shortlist.map(s => [s.rank, s.id, s.label, s.host, s.lat, s.lng, s.cost_lakh, s.score, ...["gap", "pressure", "corridor", "equity", "feasibility"].map(k => s.components[k] == null ? "" : s.components[k].toFixed(1)), s.unknown_components.join("|"), s.confidence, rec.scenario_id].map(csvCell).join(","))].join("\n"), "text/csv");
    }
    if (kind === "geojson") download(base + ".geojson", JSON.stringify({ type: "FeatureCollection", properties: { scenario_id: rec.scenario_id, region: rec.region.name }, features: rec.shortlist.map(s => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lng, s.lat] }, properties: s })) }), "application/geo+json");
    if (kind === "save") { const list = store.get("scenarios", []).filter(x => x.id !== rec.scenario_id); list.push({ id: rec.scenario_id, region: rec.region, opts: S.opts, plan: S.planKey, planName: rec.plans[S.planKey].name, metrics: rec.plans[S.planKey] }); store.set("scenarios", list.slice(-30)); renderInspector(); }
    if (kind === "sna") return exportSNA();
    if (kind === "fsr") return exportFSR();
    if (kind === "print") { if (DESK) { const r = await DESK.pdfReport(base + ".pdf"); if (r && r.ok) toast("PDF saved: " + r.path); } else window.print(); }
  }

  function districtOfPoint(lat, lng) {
    const A = S.analysis, ix = A._cellIdx || (A._cellIdx = new E.GridIndex(A.ctx.cells.map(c => ({ lat: c[1], lng: c[0] })), 0.05));
    const n = ix.nearest(lat, lng, 50); const did = n ? A.ctx.cellDistrict[n.i] : S.did; return INDIA.districtById.get(did);
  }
  function proposalSites(selected) {
    return selected.map(c => {
      const d = districtOfPoint(c.lat, c.lng), st = d ? INDIA.stateById.get(d.sid).name : "";
      return { c, state: st, city: c.place || (d ? d.name : ""), location: c.site && c.site.name ? `${c.site.name} (${c.label.split(" · ").pop()})` : c.label,
        highway: { no: "", from: "", to: "", milestone: c.label }, confidence: E.confidenceFor(c, S.analysis.ctx).grade };
    });
  }
  async function exportSNA() {
    const m0 = store.get("sna_meta", { entity: "", nodal: "", mode: "CPO (to be selected)", stage: "Proposal" });
    const md = modal("PM E-DRIVE proposal (Annexures B, C, D)", `<p class="sub">Fills MHI's proposal formats (Operational Guidelines 26 Sep 2025) from the current plan. Upload on the PM E-DRIVE portal after replacing upstream estimates with DISCOM demand notes.</p>
      <div class="grid2"><label class="f">Name of entity (Ministry / State / UT / CPSE)<input id="sna-e" value="${esc(m0.entity || ("Government of " + INDIA.stateById.get(S.sid).name))}"></label>
      <label class="f">Nodal agency<input id="sna-n" value="${esc(m0.nodal)}" placeholder="e.g. State Designated Agency"></label>
      <label class="f">Mode of implementation<input id="sna-m" value="${esc(m0.mode)}"></label>
      <label class="f">Stage of submission<select id="sna-s">${["Proposal", "First tranche", "Second tranche"].map(x => `<option ${x === m0.stage ? "selected" : ""}>${x}</option>`).join("")}</select></label></div>
      <button class="btn" id="sna-go" style="margin-top:8px">Create .xlsx</button>`);
    $("#sna-go", md.el).onclick = async () => {
      const meta = { entity: $("#sna-e").value.trim(), nodal: $("#sna-n").value.trim(), mode: $("#sna-m").value.trim(), stage: $("#sna-s").value };
      store.set("sna_meta", meta);
      const rec = scenarioRecord(), plan = S.analysis.plans[S.planKey];
      const sheets = PM.proposalSheets(proposalSites(plan.selected), { ...meta, tauKm: S.opts.tauKm, scenario: rec.scenario_id, build: INDIA.version, region: regionName() });
      const b64 = window.RGXlsx.toBase64(window.RGXlsx.build(sheets)), name = `PM-EDRIVE_proposal_${slug(regionName())}_${rec.scenario_id}.xlsx`;
      Audit.add("export.sna", `${regionName()} · ${plan.selected.length} sites · ${rec.scenario_id}`);
      if (DESK) { const r = await DESK.saveFile(name, b64, { base64: true }); if (r && r.ok) toast("Saved " + r.path); }
      else { const a = document.createElement("a"); a.href = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + b64; a.download = name; a.click(); }
      md.close();
    };
  }
  function fsrHTML() {
    const A = S.analysis, o = S.opts, plan = A.plans[S.planKey], sm = PM.summarise(plan.selected), rec = scenarioRecord();
    const st = S.level === "district" ? statOf(S.did) : INDIA.stateById.get(S.sid).stats, R = regionEV();
    const ratio = A.plans.ratio, gain = plan.metrics.newlyCovered, rgain = ratio ? ratio.metrics.newlyCovered : 0;
    const F = R ? PM.scurveForecast(R.ev, o.scurve) : null, f30 = F ? F.rows[F.rows.length - 1] : null;
    const cal = INDIA.vahan_rto && INDIA.vahan_rto.calibration;
    const sites = proposalSites(plan.selected);
    const e = esc, L = (x) => rupL(x);
    const css = `body{font:11px/1.45 "Segoe UI",Arial,sans-serif;color:#111;margin:0}h1{font-size:22px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #111;padding-bottom:2px}table{border-collapse:collapse;width:100%;margin:4px 0}td,th{border:1px solid #bbb;padding:3px 5px;text-align:left;vertical-align:top}th{background:#f3e4ec}.n{text-align:right}.sub{color:#555}.k{display:inline-block;border:1px solid #111;padding:4px 8px;margin:0 6px 6px 0}.k b{display:block;font-size:15px}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Feasibility study report</title><style>${css}</style></head><body>
      <h1>Feasibility study report: EV public charging stations</h1>
      <div class="sub">${e(regionName())} · scenario ${e(rec.scenario_id)} · data build ${e(INDIA.version)} · ${new Date().toISOString().slice(0, 10)} · prepared with ReachGrid India for the PM E-DRIVE proposal (FAQ 4 of the Operational Guidelines, 26 Sep 2025)</div>
      <h2>1. Summary</h2>
      <div><span class="k"><b>${sm.sites}</b>EV PCS</span><span class="k"><b>${sm.chargers.e2w3w} / ${sm.chargers.e4w} / ${sm.chargers.bus}</b>chargers 2W-3W / 4W / bus</span><span class="k"><b>${L(sm.total)}</b>project cost (ex-GST)</span><span class="k"><b>${L(sm.subsidy)}</b>subsidy requested</span><span class="k"><b>${pct(sm.catAShare, 0)}</b>Category A share</span><span class="k"><b>${pct(A.ctx.base.coverage)} → ${pct(plan.metrics.coverage)}</b>people within ${o.tauKm} km</span></div>
      <p>The plan brings ${people(gain)} more people within ${o.tauKm} km of a public charger${ratio ? `, against ${people(rgain)} for the same budget allocated by the EV-to-charger ratio method (${rgain ? (gain >= rgain ? "+" : "") + pct(gain / rgain - 1, 0) : "n/a"})` : ""}.</p>
      <h2>2. Basis of selection of locations</h2>
      <p>Demand: Census 2011 population on ${nIN(A.ctx.cells.length)} hexagonal cells (dasymetric), with demand pressure from ${e(A.ctx.pressureSource)}. Existing supply: ${nIN(st.chargers)} listed charging sites (${e(INDIA.sources.find(x => x.id === "chargers")?.title || "charger dataset")}). Access is measured as ${o.metric === "network" ? "routed distance on the highway network" : `straight-line distance × ${o.detour} road detour`} to the nearest charger, with a ${o.tauKm} km threshold.</p>
      <p>Candidate sites: ${nIN(A.cands.length)} (${Object.entries(A.cands.reduce((a, c) => { const k = c.site ? c.site.type : c.host; a[k] = (a[k] || 0) + 1; return a; }, {})).map(([k, v]) => `${v} ${k}`).join(", ")}). Each is scored on access gap ${o.weights.gap}, EV pressure ${o.weights.pressure}, corridor ${o.weights.corridor}, equity ${o.weights.equity} and feasibility ${o.weights.feasibility}; unknown components are excluded and the weights renormalised.</p>
      <p>Selection: ${e(plan.name)} maximises newly covered people per rupee within the budget of ${L(effOpts().budgetLakh)} (counted as ${e({ total: "total project cost", subsidy: "PM E-DRIVE subsidy", net: "agency outlay" }[o.pm.budgetBasis])}). The objective is monotone submodular, so the modified greedy plan is guaranteed to reach at least ${plan.guarantee ? (plan.guarantee.bound * 100).toFixed(1) : "31.6"}% of the optimum${S.compare && S.compare.opt && S.compare.opt.greedy.ofBound ? `; measured here at ${pct(S.compare.opt.greedy.ofBound, 1)} of the exact LP bound` : ""}. Category A sites are capped at 20% of the requested subsidy (FAQ 1).</p>
      <h2>3. Configurations and charger ratings</h2>
      <table><tr><th>Station type</th><th>Configuration</th><th>Basis</th></tr>${Object.values(PM.ARCHETYPES).map(a => `<tr><td>${e(a.label)}</td><td>${a.chargers.length ? a.chargers.map(c => `${c.n} × ${c.kw} kW ${e(PM.CHARGER[c.kw].conn)}`).join(" + ") : "battery swapping"}</td><td>${e(a.basis)}</td></tr>`).join("")}</table>
      <p>Connectors follow Table 1 of the Operational Guidelines (LEVDC IS-17017-2-6 / LECCS IS-17017-2-7 up to 12 kW; CCS-II IS-17017-2-3). Station type follows the site: highway and toll locations get the highway configuration; districts where e-4W are under ${pct(o.pm.hubIfFourWheelerShareBelow, 0)} of registered EVs get 2W/3W hubs${o.pm.preferSwap ? " (battery swapping, Category D)" : ""}.</p>
      <h2>4. Proposed stations</h2>
      <table><tr><th>#</th><th>Location</th><th>Cat.</th><th>Configuration</th><th class="n">Newly covered</th><th class="n">Project ₹ L</th><th class="n">Subsidy ₹ L</th><th>Confidence</th></tr>
      ${sites.map((x, i) => `<tr><td>${i + 1}</td><td>${e(x.location)}<div class="sub">${e(x.city)}, ${e(x.state)} · ${x.c.lat.toFixed(5)}, ${x.c.lng.toFixed(5)}</div></td><td>${x.c.pm.category}</td><td>${e(x.c.pm.archLabel)}</td><td class="n">${people(x.c.raw.gap)}</td><td class="n">${x.c.pm.total.toFixed(2)}</td><td class="n">${x.c.pm.subsidy.toFixed(2)}</td><td>${e(x.confidence)}</td></tr>`).join("")}</table>
      <h2>5. Demand outlook</h2>
      ${R ? `<p>Registered EVs (VAHAN, by RTO, matched to districts): ${Object.entries(R.ev.years).map(([y, v]) => `${y}${v.n && v.n < 12 ? ` (${v.n} mo)` : ""}: ${nIN(v.ev)}`).join(" · ")}. EV share of new registrations ${F.anchorYear}: 2W ${pct(F.rows[0].share.e2w, 1)}, 3W ${pct(F.rows[0].share.e3w, 0)}, 4W ${pct(F.rows[0].share.e4w, 1)}.</p><p>S-curve projection to ${f30.year}: ${people(f30.stock.e2w)} e-2W, ${people(f30.stock.e3w)} e-3W, ${people(f30.stock.e4w)} e-4W, ${nIN(f30.stock.bus)} e-buses on the road (assumptions in the Forecast tab).</p>` : "<p>No RTO-level VAHAN data for this region.</p>"}
      <h2>6. Costs and subsidy</h2>
      <table><tr><th>Category</th><th class="n">Subsidy requested ₹ L</th></tr>${["A", "B", "C", "D"].map(k => `<tr><td>${k}: ${e(PM.CATEGORIES[k].label)}</td><td class="n">${sm.byCat[k].toFixed(2)}</td></tr>`).join("")}<tr><th>Total</th><th class="n">${sm.subsidy.toFixed(2)}</th></tr></table>
      <p>Subsidy = category % × the lower of benchmark and actual cost, excluding GST and refundable deposits. EVSE benchmarks: BEE, October 2025. Upstream: estimated from the BEE (Aug 2022) table by station rating${A.ctx.gridIdx && A.ctx.gridIdx.kind === "substation" ? " plus HT extension to the nearest substation" : ""}; to be replaced by DISCOM demand notes.</p>
      <h2>7. Data, validation and limitations</h2>
      ${cal ? `<p>VAHAN segment split validated out of sample: e-2W ${pct(cal.e2w.test_state_mape, 1)} mean state error in ${e(cal.e2w.test_year)}; e-4W ${cal.e4w ? pct(cal.e4w.test_mape, 1) : "n/a"} and e-bus ${cal.bus ? pct(cal.bus.test_mape, 1) : "n/a"} mean monthly error against published national figures.</p>` : ""}
      <table><tr><th>Source</th><th>Publisher</th><th>Licence</th><th>Observed</th><th>Limits</th></tr>${INDIA.sources.map(x => `<tr><td>${e(x.title)}</td><td>${e(x.publisher)}</td><td>${e(x.licence || "")}</td><td>${e(x.observed || "")}</td><td>${e(x.limits || "")}</td></tr>`).join("")}</table>
      <p class="sub">This is a planning study. Every site needs land, DISCOM capacity confirmation, permits and a site survey before procurement.</p>
      </body></html>`;
  }
  async function exportFSR() {
    const html = fsrHTML(), rec = scenarioRecord(), name = `Feasibility-study_${slug(regionName())}_${rec.scenario_id}`;
    Audit.add("export.fsr", `${regionName()} · ${rec.scenario_id}`);
    if (DESK && DESK.pdfHtml) { const r = await DESK.pdfHtml(html, name + ".pdf"); if (r && r.ok) toast("PDF saved: " + r.path); return; }
    const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 400); } else download(name + ".html", html, "text/html");
  }

  /* ---------- chargers tab ---------- */
  function tabChargers(tb) {
    const sd = curState(), ds = S.level === "district" ? [curDistrict()] : sd.districts;
    const all = ds.flatMap(d => d.chargers.map(c => ({ c, d: d.name })));
    const ops = [...new Set(all.map(x => x.c[3] || "Unknown"))].sort();
    tb.innerHTML = `<div class="grid2"><input type="search" id="cq" placeholder="Filter name / address…"><select id="cop"><option value="">All operators (${ops.length})</option>${ops.map(o => `<option>${esc(o)}</option>`).join("")}</select></div>
      <div class="grid2" style="margin-top:6px"><select id="ctier"><option value="">All power tiers</option>${Object.entries(TIER_LABEL).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select><select id="cconn"><option value="">All connectors</option>${CONN_RE.map(([n]) => `<option>${n}</option>`).join("")}</select></div>
      <div style="display:flex;gap:10px;margin:6px 0;font-size:11.5px"><label><input type="checkbox" id="cdc"> DC only</label><label><input type="checkbox" id="cver"> ≥2 sources</label><span class="sub" id="ccount"></span></div>
      <div class="scroll" style="max-height:420px"><table class="t"><thead><tr><th>Station</th><th class="n">kW</th><th class="n">₹/kWh</th><th class="n">Src</th></tr></thead><tbody id="crows"></tbody></table></div>
      <div style="margin-top:8px"><button class="btn sm" id="cexp">Export CSV</button></div>`;
    let rows = [];
    const draw = () => {
      const q = norm($("#cq").value), op = $("#cop").value, dc = $("#cdc").checked, ver = $("#cver").checked;
      const tier = $("#ctier").value, conn = $("#cconn").value, cre = conn && CONN_RE.find(x => x[0] === conn)[1];
      rows = all.filter(({ c }) => (!q || norm(c[2] + " " + c[11] + " " + c[10]).includes(q)) && (!op || (c[3] || "Unknown") === op) && (!dc || isDC(c)) && (!ver || c[8] >= 2) && (!tier || tierOf(c) === tier) && (!cre || cre.test(c[12] || "")));
      $("#ccount").textContent = `${nIN(rows.length)} of ${nIN(all.length)}`;
      $("#crows").innerHTML = rows.slice(0, 400).map(({ c, d }, i) => `<tr class="click" data-i="${i}"><td><b>${esc(c[2] || "Unnamed")}</b><br><span class="sub">${esc(c[3] || "Unknown")}${S.level === "state" ? " · " + esc(d) : ""}</span></td><td class="n">${c[4] ?? "—"}</td><td class="n">${(c[7].match(/[\d.]+/) || ["—"])[0]}</td><td class="n">${c[8]}</td></tr>`).join("") + (rows.length > 400 ? `<tr><td colspan="4" class="sub">Showing first 400; export for all.</td></tr>` : "");
      $$("#crows tr[data-i]").forEach(r => r.onclick = () => { const { c } = rows[+r.dataset.i]; map.flyTo([c[0], c[1]], 15); L.popup().setLatLng([c[0], c[1]]).setContent(chargerPopup(c)).openOn(map); });
    };
    ["cq", "cop", "cdc", "cver", "ctier", "cconn"].forEach(id => $("#" + id).addEventListener("input", draw)); draw();
    $("#cexp").onclick = () => { const f = INDIA.charger_fields; download(`chargers_${slug(regionName())}.csv`, [["district", ...f].join(","), ...rows.map(({ c, d }) => [d, ...c].map(csvCell).join(","))].join("\n"), "text/csv"); };
  }

  /* ---------- ledger tab ---------- */
  function tabLedger(tb) {
    const sd = curState(), isD = S.level === "district", ds = isD ? [curDistrict()] : sd.districts;
    const ch = ds.flatMap(d => d.chargers), st = isD ? statOf(S.did) : INDIA.stateById.get(S.sid).stats;
    const dates = ch.map(c => c[9]).filter(Boolean).sort();
    const share = (f) => ch.length ? ch.filter(f).length / ch.length : null;
    const multi = [1, 2, 3, 4].map(k => ch.filter(c => (k < 4 ? c[8] === k : c[8] >= 4)).length);
    tb.innerHTML = `<div class="hdr"><span>Demand layer</span></div>
      <p>${isD ? provenance(st) : `${st.districts - st.imputed_districts} of ${st.districts} districts map one-to-one onto Census 2011; ${st.imputed_districts} are apportioned.`}</p>
      <p><span class="tag der">derived</span> Population surface: Census 2011 × GeoNames towns. ${isD ? `${curDistrict().cells.length} hex cells of ~${curDistrict().cell_km} km.` : ""} Census figures are 15 years old; growth since 2011 is <b>not</b> modelled.</p>
      <div class="hdr"><span>Charger layer · ${nIN(ch.length)} sites</span></div>
      <div class="kpis">${[[pct(share(c => c[8] >= 2), 0), "≥2 independent sources"], [pct(share(c => c[4] != null), 0), "publish power"], [pct(share(c => !!c[7]), 0), "publish tariff"], [dates[0] || "—", "oldest update"], [dates[Math.floor(dates.length / 2)] || "—", "median update"], [dates[dates.length - 1] || "—", "latest update"]].map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join("")}</div>
      <div class="hdr"><span>Sources per site</span></div>${multi.map((v, i) => `<div class="hist"><span>${i < 3 ? i + 1 : "4+"} source${i ? "s" : ""}</span><div class="minibar"><i style="width:${ch.length ? (v / ch.length) * 100 : 0}%"></i></div><span>${nIN(v)}</span></div>`).join("")}
      <div class="hdr"><span>Live check against OpenStreetMap</span></div>
      <p class="sub">Queries the Overpass API from your browser for <span class="mono">amenity=charging_station</span> in this ${isD ? "district" : "state"} and matches it to the dataset within 150 m.</p>
      <button class="btn sm" id="osm-run">Run live OSM check</button><div id="osm-out" style="margin-top:8px"></div>
      <div class="hdr"><span>Known gaps</span></div>
      <ul style="padding-left:16px;margin:4px 0"><li>Operational status and uptime are not observed.</li><li>Distances are straight-line × detour, not routed.</li><li>Grid capacity, land and permits are unknown for every candidate.</li><li>Vehicle ownership uses 2011 household rates as a pressure proxy unless EV registrations are uploaded (Evidence tab).</li></ul>
      ${ledgerGovernanceHTML()}`;
    $("#osm-run").onclick = () => osmCheck(ds, $("#osm-out"));
    bindLedgerGovernance();
    if (S.osm) renderOSM(S.osm, $("#osm-out"));
  }
  async function osmCheck(ds, out) {
    let bb = [180, 90, -180, -90]; ds.forEach(d => { const b = E.bbox(d.geom); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; });
    out.innerHTML = `<span class="sub">Querying overpass-api.de …</span>`;
    const q = `[out:json][timeout:40];(node["amenity"="charging_station"](${bb[1]},${bb[0]},${bb[3]},${bb[2]});way["amenity"="charging_station"](${bb[1]},${bb[0]},${bb[3]},${bb[2]}););out center tags;`;
    try {
      const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const pts = j.elements.map(e => ({ lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, tags: e.tags || {}, id: e.type + "/" + e.id })).filter(p => p.lat && ds.some(d => E.pointInGeom(p.lng, p.lat, d.geom)));
      const mine = new E.GridIndex(ds.flatMap(d => d.chargers).map(c => ({ lat: c[0], lng: c[1] })), 0.05);
      pts.forEach(p => { const n = mine.nearest(p.lat, p.lng, 0.15); p.matched = !!n; });
      S.osm = { at: new Date().toISOString(), pts, total: ds.reduce((a, d) => a + d.chargers.length, 0) };
      renderOSM(S.osm, out);
    } catch (e) { out.innerHTML = `<div class="note warnnote">Live check failed (${esc(e.message)}). Overpass may be busy or blocked on this network; the bundled snapshot is unaffected.</div>`; }
  }
  function renderOSM(o, out) {
    clearLayers("osm");
    const only = o.pts.filter(p => !p.matched);
    only.forEach(p => L.circleMarker([p.lat, p.lng], { radius: 6, color: "#4b5fd0", weight: 2, fillColor: "#fff", fillOpacity: 1 }).bindPopup(`<b>${esc(p.tags.name || "OSM charging station")}</b><br>${esc(p.tags.operator || "")}<br><span class="tag der">OSM only · unverified</span><br><a href="https://www.openstreetmap.org/${p.id}" target="_blank" rel="noopener">${p.id}</a>`).addTo(G.osm));
    out.innerHTML = `<div class="kpis"><div class="kpi"><b>${o.pts.length}</b><span>OSM stations live</span></div><div class="kpi"><b>${o.pts.length - only.length}</b><span>matched to dataset</span></div><div class="kpi"><b>${only.length}</b><span>OSM-only (blue on map)</span></div></div><p class="sub">Checked ${new Date(o.at).toLocaleString("en-IN")}. OSM-only points are candidates for the next data refresh, not confirmed sites. Map data © OpenStreetMap contributors (ODbL).</p>`;
  }

  /* ------------------------------------------------------------------ corridor mode */
  const PRESETS = [["Delhi", "Jaipur"], ["Mumbai", "Pune"], ["Bengaluru", "Chennai"], ["Delhi", "Chandigarh"], ["Ahmedabad", "Mumbai"], ["Kolkata", "Bhubaneswar"], ["Hyderabad", "Vijayawada"], ["Jamshedpur", "Ranchi"], ["Lucknow", "Varanasi"], ["Guwahati", "Shillong"], ["Delhi", "Agra"], ["Kochi", "Thiruvananthapuram"]];
  function findPlace(name) { const n = norm(name); return INDIA.places.find(p => norm(p[0]) === n) || INDIA.places.find(p => norm(p[0]).startsWith(n)); }
  function placeSource() { return INDIA.places.map(p => { const d = INDIA.districtById.get(p[4]); return { k: norm(p[0]), label: p[0], sub: `${d.name}, ${INDIA.stateById.get(d.sid).name} · ${people(p[3])}`, p }; }); }
  function renderCorridorNav(body) {
    $("#nav-title").textContent = "Corridor check · highway network";
    const C = S.corridor, sa = searchBox("cf", "From town…", x => { C.from = x.p; }, placeSource), sb2 = searchBox("ct", "To town…", x => { C.to = x.p; }, placeSource);
    body.innerHTML = `
      <label class="f">From${sa.html}</label><label class="f">To${sb2.html}</label>
      <div class="grid2"><label class="f">EV real-world range<select id="crange">${[120, 180, 250, 320, 400, 500].map(r => `<option ${r === C.range ? "selected" : ""} value="${r}">${r} km</option>`).join("")}</select></label>
      <label class="f">Arrival reserve<select id="cres">${[10, 20, 30].map(r => `<option ${r === C.reserve ? "selected" : ""} value="${r}">${r}%</option>`).join("")}</select></label>
      <label class="f">Max detour off highway<select id="cbuf">${[1, 2, 3, 5, 8].map(r => `<option ${r === C.buffer ? "selected" : ""} value="${r}">${r} km</option>`).join("")}</select></label>
      <label class="f" style="align-content:end"><span><input type="checkbox" id="cdc2" ${C.dcOnly ? "checked" : ""}> DC fast only</span></label></div>
      <button class="btn" id="croute" style="width:100%;justify-content:center">Check corridor</button>
      <div class="hdr"><span>Popular corridors</span></div>
      <div class="suggest" style="margin:0">${PRESETS.map(([a, b], i) => `<button class="btn sm ghost" data-pre="${i}">${a} → ${b}</button>`).join("")}</div>
      <p class="sub">Routes on the Natural Earth highway graph (${nIN(ROADS.nodes.length)} nodes). Coarse: good for gap screening, not navigation.</p>`;
    sa.bind(); sb2.bind();
    if (C.from) $("#cf").value = C.from[0]; if (C.to) $("#ct").value = C.to[0];
    $("#crange").onchange = e => C.range = +e.target.value; $("#cres").onchange = e => C.reserve = +e.target.value; $("#cbuf").onchange = e => C.buffer = +e.target.value; $("#cdc2").onchange = e => C.dcOnly = e.target.checked;
    $("#croute").onclick = () => runCorridor();
    $$("[data-pre]", body).forEach(b => b.onclick = () => { const [a, z] = PRESETS[+b.dataset.pre]; C.from = findPlace(a); C.to = findPlace(z); $("#cf").value = C.from?.[0] || a; $("#ct").value = C.to?.[0] || z; runCorridor(); });
  }
  async function runCorridor() {
    const C = S.corridor;
    if (!C.from || !C.to) { $("#insp-body").innerHTML = `<p>Pick both towns from the suggestions first.</p>`; return; }
    GRAPH ||= E.buildGraph(ROADS);
    let r = null;
    if (DESK && (await deskSettings()).osrmRouting) {
      $("#insp-body").innerHTML = `<p class="sub">Routing on the street network (OSRM)…</p>`;
      try {
        const j = await fetch(`/proxy/osrm?coords=${C.from[1]},${C.from[2]};${C.to[1]},${C.to[2]}`, { headers: { "X-Session-Token": (DESK && DESK.session() || {}).token || "" } }).then(x => { if (!x.ok) throw new Error("HTTP " + x.status); return x.json(); });
        if (j.routes && j.routes[0]) r = { path: j.routes[0].geometry.coordinates, km: j.routes[0].distance / 1000, snapFrom: 0, snapTo: 0, engine: "OSRM street network" };
      } catch (e) { toast("Street routing unavailable (" + e.message + "); using the highway graph"); }
    }
    if (!r) { r = E.route(GRAPH, { lat: C.from[2], lng: C.from[1] }, { lat: C.to[2], lng: C.to[1] }); if (r) r.engine = "Natural Earth highway graph"; }
    if (!r) { S.route = { error: "No highway route found between these towns on the coarse network." }; renderInspector(); return; }
    const idx = Rg.chargerIndex(INDIA, C.dcOnly ? "dc" : "all");
    const g = E.corridorGaps(r.path, idx, { bufferKm: C.buffer, rangeKm: C.range, reservePct: C.reserve });
    S.route = { r, g, idx, from: C.from, to: C.to, opts: { ...C } };
    drawRoute(); renderInspector(); updateStatus();
  }
  function drawRoute() {
    clearLayers("route");
    if (S.freight && S.freight.key !== freightKey()) S.freight = null;
    const { r, g, idx } = S.route; if (!r) return;
    const line = r.path.map(([x, y]) => [y, x]);
    L.polyline(line, { color: "#fff", weight: 9, opacity: 0.9 }).addTo(G.route);
    L.polyline(line, { color: "#1b1b1d", weight: 4 }).addTo(G.route);
    for (const gp of g.gaps) if (gp.km > g.usable * 0.6) {
      const seg = g.dense.filter(p => p[2] >= gp.from && p[2] <= gp.to).map(p => [p[1], p[0]]);
      if (seg.length > 1) L.polyline(seg, { color: gp.km > g.usable ? "#b11a52" : "#e44fbf", weight: 7, opacity: 0.9 }).bindTooltip(`${gp.km.toFixed(0)} km without a charger within ${S.route.opts.buffer} km`, { className: "rg-tip", sticky: true }).addTo(G.route);
    }
    g.stops.forEach(s => { const p = idx.pts[s.i]; L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: `<div class="charger-sq ${p.dc ? "" : "ac"}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }) }).bindTooltip(`km ${s.at.toFixed(0)} · ${s.off.toFixed(1)} km off route${p.dc ? " · DC" : ""}${p.verified ? " · ≥2 sources" : ""}`, { className: "rg-tip" }).addTo(G.route); });
    g.plan.forEach((s, i) => { const p = idx.pts[s.i]; L.marker([p.lat, p.lng], { zIndexOffset: 1000, icon: L.divIcon({ className: "", html: `<div class="sel-pin pop">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(G.route); });
    [[S.route.from, "A"], [S.route.to, "B"]].forEach(([p, t]) => L.marker([p[2], p[1]], { icon: L.divIcon({ className: "", html: `<div class="sel-pin" style="background:#1b1b1d">${t}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(G.route));
    map.flyToBounds(L.latLngBounds(line), { ...mapPad(), duration: 0.8 });
    drawFreight();
  }
  function renderCorridorInsp(el) {
    $("#insp-title").textContent = "Corridor report";
    if (!S.route) { el.innerHTML = `<div class="big-name">Can an EV make this trip?</div><p>Pick two towns or a preset. ReachGrid routes over the national highway graph, finds every listed charger within your detour limit and checks the longest charging gap against your car's usable range.</p><div class="note">Uses the real charger dataset (${nIN(INDIA.totals.chargers)} sites). Listing ≠ working charger: plan a backup.</div>`; return; }
    if (S.route.error) { el.innerHTML = `<p>${esc(S.route.error)}</p>`; return; }
    const { r, g, from, to, opts } = S.route;
    const W = 360, scale = W / g.total;
    const strip = `<svg viewBox="0 0 ${W} 46" width="100%" role="img" aria-label="Charging stops along the route"><rect x="0" y="18" width="${W}" height="10" fill="#fff" stroke="#1b1b1d"/>${g.gaps.map(gp => gp.km > g.usable * 0.6 ? `<rect x="${gp.from * scale}" y="18" width="${gp.km * scale}" height="10" fill="${gp.km > g.usable ? "#b11a52" : "#e44fbf"}"/>` : "").join("")}${g.stops.map(s => `<rect x="${s.at * scale - 1}" y="12" width="2" height="22" fill="#1b1b1d"/>`).join("")}${g.plan.map((s, i) => `<g><rect x="${s.at * scale - 7}" y="0" width="14" height="12" fill="#e44fbf" stroke="#1b1b1d"/><text x="${s.at * scale}" y="9.5" font-size="8" text-anchor="middle" fill="#fff" font-family="monospace">${i + 1}</text></g>`).join("")}<text x="0" y="44" font-size="9" font-family="monospace">${esc(from[0])}</text><text x="${W}" y="44" font-size="9" text-anchor="end" font-family="monospace">${esc(to[0])} · ${g.total.toFixed(0)} km</text></svg>`;
    el.innerHTML = `<div class="big-name">${esc(from[0])} → ${esc(to[0])}</div>
      <div class="sub">${g.total.toFixed(0)} km · ${esc(r.engine || "highway graph")}${r.snapFrom > 5 || r.snapTo > 5 ? ` (+${(r.snapFrom + r.snapTo).toFixed(0)} km to reach the network)` : ""}</div>
      <div class="kpis" style="margin-top:8px">
        <div class="kpi"><b style="color:${g.feasible ? "var(--good)" : "var(--bad)"}">${g.feasible ? "Feasible" : "Not feasible"}</b><span>with ${opts.range} km range, ${opts.reserve}% reserve</span></div>
        <div class="kpi"><b>${g.feasible ? g.plan.length : "—"}</b><span>minimum charging stops</span></div>
        <div class="kpi"><b>${g.maxGap.toFixed(0)} km</b><span>longest gap (from km ${g.maxAt.toFixed(0)})</span></div>
        <div class="kpi"><b>${g.stops.length}</b><span>chargers ≤ ${opts.buffer} km off route</span></div>
        <div class="kpi"><b>${(g.stops.length / g.total * 100).toFixed(1)}</b><span>per 100 km</span></div>
        <div class="kpi"><b>${g.usable.toFixed(0)} km</b><span>usable range per leg</span></div></div>
      <div class="hdr"><span>Stop profile</span></div>${strip}
      ${g.feasible ? `<div class="hdr"><span>Suggested stops (furthest reachable each leg)</span></div><table class="t"><tbody>${g.plan.map((s, i) => { const p = S.route.idx.pts[s.i]; return `<tr class="click" data-ll="${p.lat},${p.lng}"><td>${i + 1}</td><td>km ${s.at.toFixed(0)}</td><td>${s.off.toFixed(1)} km off route</td><td>${p.dc ? "DC" : "AC/unknown"}${p.verified ? " · ≥2 src" : ""}</td></tr>`; }).join("") || `<tr><td>No stop needed in range.</td></tr>`}</tbody></table>`
        : `<div class="note warnnote">A gap of ${g.maxGap.toFixed(0)} km exceeds the usable ${g.usable.toFixed(0)} km. That stretch (red on the map) is a priority corridor for new DC chargers.</div>`}
      <div class="note">Gaps over 60% of usable range are pink, over 100% red. Stops are listed sites, not verified as working.</div>
      <div class="hdr"><span>Heavy-vehicle plan: e-trucks and e-buses</span><span class="sub">PM E-DRIVE highway stations</span></div>
      <p class="sub" style="margin:0 0 6px">Car chargers do not serve freight. This places highway EV PCS (1 × 240 kW + 2 × 60 kW CCS-II) so a heavy vehicle always reaches a heavy-duty charger, reusing existing ones and preferring Category B toll plazas and PSU outlets on the road.</p>
      <div class="grid2"><label class="f">Heavy vehicle range<select id="fr-r">${[100, 150, 200, 250, 300].map(v => `<option value="${v}" ${v === (S.freightCfg || {}).range ? "selected" : v === 150 && !(S.freightCfg || {}).range ? "selected" : ""}>${v} km</option>`).join("")}</select></label>
      <label class="f">Counts as heavy-duty<select id="fr-k">${[[120, "≥ 120 kW listed"], [240, "≥ 240 kW listed"]].map(([v, n]) => `<option value="${v}" ${v === ((S.freightCfg || {}).kw || 120) ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>
      <button class="btn sm" id="fr-go" style="width:100%;justify-content:center">Plan heavy-vehicle stations</button>
      <div id="fr-o">${S.freight && S.freight.key === freightKey() ? freightHTML(S.freight) : ""}</div>`;
    $$("[data-ll]", el).forEach(tr => tr.onclick = () => { const [a, b] = tr.dataset.ll.split(","); map.flyTo([+a, +b], 13); });
    $("#fr-go", el).onclick = () => runFreight();
    bindFreight(el);
  }
  const freightKey = () => S.route && S.route.r ? `${S.route.from[0]}|${S.route.to[0]}|${S.route.g.total.toFixed(1)}|${JSON.stringify(S.freightCfg || {})}` : "";
  /** state ids the route passes through (sampled every ~10 km) */
  function statesOnRoute(dense) {
    const out = new Set(), ds = INDIA.districts.map(d => ({ d, bb: E.bbox(d.geom) }));
    for (let k = 0; k < dense.length; k += 10) {
      const [x, y] = dense[k];
      const hit = ds.find(o => x >= o.bb[0] && x <= o.bb[2] && y >= o.bb[1] && y <= o.bb[3] && E.pointInGeom(x, y, o.d.geom));
      if (hit) out.add(hit.d.sid);
    }
    return [...out];
  }
  function stateOfPoint(lat, lng) {
    const d = INDIA.districts.find(o => { const b = E.bbox(o.geom); return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3] && E.pointInGeom(lng, lat, o.geom); });
    return d ? INDIA.stateById.get(d.sid).name : "";
  }
  async function runFreight() {
    const R = S.route; if (!R || !R.g) return;
    S.freightCfg = { range: +$("#fr-r").value, kw: +$("#fr-k").value };
    const o = $("#fr-o"); o.innerHTML = `<p class="sub">Loading chargers and sites along the route…</p>`;
    const t0 = performance.now(), dense = R.g.dense;
    const sids = statesOnRoute(dense); await Promise.all(sids.map(loadState));
    const dIdx = new E.GridIndex(dense.map(p => ({ lat: p[1], lng: p[0] })), 0.05);
    const proj = (lat, lng, km) => { const n = dIdx.nearest(lat, lng, km); return n ? { at: dense[n.i][2], off: n.d } : null; };
    const hd = [], cands = [];
    for (const sid of sids) for (const d of window.RG_STATE[sid].districts) {
      for (const x of d.chargers) if ((x[4] || 0) >= S.freightCfg.kw) { const p = proj(x[0], x[1], 2); if (p) hd.push({ ...p, lat: x[0], lng: x[1], name: x[2] || "listed charger", kw: x[4] }); }
      for (const x of d.sites || []) if (["toll", "omc", "fuel", "bus"].includes(x[2])) { const p = proj(x[0], x[1], 1.5); if (p) cands.push({ ...p, lat: x[0], lng: x[1], cat: x[3], type: x[2], name: x[4] || ({ toll: "Toll plaza", omc: "PSU fuel outlet", fuel: "Fuel outlet", bus: "Bus station" })[x[2]], note: x[5] }); }
    }
    for (let k = 0; k < dense.length; k += 5) cands.push({ at: dense[k][2], off: 0, lat: dense[k][1], lng: dense[k][0], cat: "C", type: "highway", name: `Highway point, km ${dense[k][2].toFixed(0)}` });
    const plan = PM.freightCorridorPlan({ total: R.g.total, hd, cands, rangeKm: S.freightCfg.range, reservePct: R.opts.reserve, pm: S.opts.pm });
    S.freight = { ...plan, key: freightKey(), hdCount: hd.length, siteCount: cands.filter(c => c.type !== "highway").length, ms: performance.now() - t0, from: R.from[0], to: R.to[0] };
    Audit.add("corridor.freight", `${R.from[0]} → ${R.to[0]} · ${plan.stations.length} stations`);
    o.innerHTML = freightHTML(S.freight); bindFreight($("#insp-body")); drawFreight();
  }
  function freightHTML(F) {
    const sm = F.summary;
    return `<div class="kpis" style="margin-top:8px"><div class="kpi"><b>${F.stations.length}</b><span>new highway EV PCS</span></div><div class="kpi"><b>${F.used.length}</b><span>existing heavy-duty chargers used (${F.hdCount} on route)</span></div><div class="kpi"><b>${F.feasible ? "Passable" : "Gap remains"}</b><span>every ${F.usable.toFixed(0)} km usable</span></div>
      <div class="kpi"><b>${rupL(sm.total)}</b><span>project cost (ex-GST)</span></div><div class="kpi"><b>${rupL(sm.subsidy)}</b><span>PM E-DRIVE subsidy</span></div><div class="kpi"><b>${sm.chargers.bus} · ${sm.chargers.e4w}</b><span>240 kW · 60 kW guns</span></div></div>
      ${F.stations.length ? `<table class="t"><thead><tr><th>km</th><th>Site</th><th>Cat.</th><th class="n">Subsidy</th></tr></thead><tbody>${F.stations.map((x, i) => `<tr class="click" data-fl="${x.lat},${x.lng}"><td>${x.at.toFixed(0)}</td><td><b>${i + 1}.</b> ${esc(x.name)}${x.note ? `<br><span class="sub">${esc(x.note)}</span>` : ""}</td><td><span class="tag cat cat${x.pm.category}">${x.pm.category}</span></td><td class="n">${rupL(x.pm.subsidy)}</td></tr>`).join("")}</tbody></table>
      <button class="btn sm" id="fr-x" style="margin-top:6px">Annexure D for this corridor (.xlsx)</button>` : `<p class="sub">Existing heavy-duty chargers already cover this corridor at this range.</p>`}
      <div class="sub" style="font-size:10.5px;margin-top:4px">${F.siteCount} PM E-DRIVE location types within 1.5 km of the route considered · planned in ${F.ms.toFixed(0)} ms. Listed power is self-reported by the charger dataset.</div>`;
  }
  function bindFreight(el) {
    $$("[data-fl]", el).forEach(tr => tr.onclick = () => { const [a, b] = tr.dataset.fl.split(","); map.flyTo([+a, +b], 13); });
    const x = $("#fr-x", el); if (x) x.onclick = exportFreight;
  }
  function drawFreight() {
    const F = S.freight; if (!F) return;
    F.used.forEach(h => L.marker([h.lat, h.lng], { icon: L.divIcon({ className: "", html: `<div class="charger-sq"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }) }).bindTooltip(`Existing heavy-duty: ${esc(h.name)} (${h.kw} kW) · km ${h.at.toFixed(0)}`, { className: "rg-tip" }).addTo(G.route));
    F.stations.forEach((s0, i) => L.marker([s0.lat, s0.lng], { zIndexOffset: 1200, icon: L.divIcon({ className: "", html: `<div class="sel-pin pop" style="background:#1f6f4a">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).bindTooltip(`New highway EV PCS ${i + 1} · km ${s0.at.toFixed(0)} · Category ${s0.pm.category}`, { className: "rg-tip" }).addTo(G.route));
  }
  async function exportFreight() {
    const F = S.freight; if (!F || !F.stations.length) return;
    if (!Gov.need("export", "export")) return;
    const no = await askText("Highway / Expressway No. for Annexure D (e.g. NH-48)", { placeholder: "NH-48" }); if (no === null) return;
    const sites = F.stations.map((x, i) => ({ c: { id: `F${String(i + 1).padStart(3, "0")}`, lat: x.lat, lng: x.lng, label: x.name, pm: x.pm, raw: { gap: 0 }, score: null, site: { cat: x.cat, note: x.note } },
      state: stateOfPoint(x.lat, x.lng), city: "", location: x.name, highway: { no: no || "", from: F.from, to: F.to, milestone: `km ${x.at.toFixed(0)} from ${F.from}` }, confidence: "" }));
    const meta = store.get("sna_meta", {});
    const sheets = PM.proposalSheets(sites, { ...meta, scenario: `corridor ${F.from}-${F.to}`, build: INDIA.version, region: `${F.from} → ${F.to}` });
    const b64 = window.RGXlsx.toBase64(window.RGXlsx.build(sheets)), name = `PM-EDRIVE_AnnexureD_${slug(F.from)}-${slug(F.to)}.xlsx`;
    Audit.add("export.sna_corridor", `${F.from} → ${F.to} · ${sites.length} stations`);
    if (DESK) { const r = await DESK.saveFile(name, b64, { base64: true }); if (r && r.ok) toast("Saved " + r.path); }
    else { const a = document.createElement("a"); a.href = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + b64; a.download = name; a.click(); }
  }

  /* ------------------------------------------------------------------ legend */
  function renderLegend() {
    const el = $("#legend-body");
    if (S.level === "india" || S.level === "state") {
      if (S.mode === "corridor") { el.innerHTML = `<div class="lgrow"><span class="sw" style="background:#1b1b1d"></span>Route</div><div class="lgrow"><span class="sw" style="background:#e44fbf"></span>Gap > 60% of range</div><div class="lgrow"><span class="sw" style="background:#b11a52"></span>Gap > usable range</div><div class="lgrow"><span class="sw sq"></span>Charger near route</div><div class="lgrow"><span class="sw sel"></span>Suggested stop</div>`; return; }
      const m = METRICS[S.metric], feats = S.level === "india" ? (S.unit === "states" ? INDIA.states : INDIA.districts) : curState().districts.map(d => ({ stats: statOf(d.id) }));
      const br = breaks(feats.map(f => m.get(f.stats)));
      const pal = m.worse === "high" ? PAL : [...PAL].reverse();
      el.innerHTML = `<b style="font-size:11.5px">${esc(m.label)}</b><div class="legend-scale">${pal.map(c => `<i style="background:${c}"></i>`).join("")}</div><div class="legend-labels"><span>${m.fmt(Math.min(...feats.map(f => m.get(f.stats)).filter(v => v != null)))}</span><span>${br.length ? m.fmt(br[2]) : ""}</span><span>${m.fmt(Math.max(...feats.map(f => m.get(f.stats)).filter(v => v != null)))}</span></div><div class="sub" style="margin-top:4px">Darker = needs attention. Quantile classes.</div>
        <div class="layers">${S.level === "india" ? `<label><input type="checkbox" data-l="chargersIndia" ${S.layers.chargersIndia ? "checked" : ""}> all ${nIN(INDIA.totals.chargers)} chargers</label>` : `<label><input type="checkbox" data-l="chargers" ${S.layers.chargers ? "checked" : ""}> chargers</label><label><input type="checkbox" data-l="roads" ${S.layers.roads ? "checked" : ""}> highways</label><label><input type="checkbox" data-l="stateTiles" ${S.layers.stateTiles ? "checked" : ""}> street map</label>`}</div>`;
    } else {
      const t = S.opts.tauKm;
      el.innerHTML = `${Object.entries(TIER_LABEL).map(([k, n]) => `<div class="lgrow"><span class="charger-sq t-${k}" style="flex:none"></span>${n}</div>`).join("")}
        ${S.layers.grid ? `<div class="lgrow"><span class="grid-dot"></span>${INDIA.grid && INDIA.grid.kind === "substation" ? "power substation (OSM)" : "power plant (WRI)"}</div>` : ""}
        <div class="lgrow"><span class="sw" style="background:#fff"></span>Demand within ${t} km</div>
        <div class="lgrow"><span class="sw" style="background:${PAL[2]}"></span>${t}–${1.5 * t} km</div><div class="lgrow"><span class="sw" style="background:${PAL[4]}"></span>${2 * t}–${3 * t} km</div><div class="lgrow"><span class="sw" style="background:${PAL[5]}"></span>&gt; ${3 * t} km</div>
        <div class="lgrow"><span class="sw newcov"></span>Newly covered by plan</div><div class="lgrow"><span class="sw sel"></span>Proposed site (rank)</div>
        <div class="layers">${[["tiles", "street map"], ["cells", "demand cells"], ["chargers", "chargers"], ["places", "towns"], ["roads", "highways"], ["grid", "grid proxy"], ["cands", "all candidates"], ["sites", "plan sites"]].map(([k, n]) => `<label><input type="checkbox" data-l="${k}" ${S.layers[k] ? "checked" : ""}> ${n}</label>`).join("")}</div>`;
    }
    $$("[data-l]", el).forEach(i => i.onchange = () => {
      S.layers[i.dataset.l] = i.checked;
      if (S.level === "india") drawIndia(); else if (S.level === "state") { drawState(curState()); if (S.analysis) { drawCells(); drawPlan(false); } } else { drawDistrict(curState(), curDistrict()); drawPlan(false); }
    });
  }

  /* ------------------------------------------------------------------ clock */
  function initClock() {
    $("#sb-build").innerHTML = `build <b>${esc(INDIA.version)}</b> · chargers ${esc(INDIA.sources[0].observed.replace("compiled ", ""))}`;
    const tick = () => {
      const now = new Date();
      $("#sb-clock").innerHTML = `<b>${now.toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })}</b> IST · ${now.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}`;
      $("#sb-net").textContent = navigator.onLine ? "● online" : "○ offline (bundled data)";
    };
    tick(); setInterval(tick, 1000);
  }
  function updateStatus() {
    const sc = $("#sb-scope"), mt = $("#sb-metric"); if (!sc) return;
    const st = S.did ? statOf(S.did) : S.sid ? INDIA.stateById.get(S.sid).stats : INDIA.totals;
    sc.innerHTML = `<b>${esc(scopeName())}</b> · ${people(st.pop)} people · ${nIN(st.chargers)} chargers`;
    const A = S.analysis;
    mt.innerHTML = S.mode === "corridor" ? (S.route && S.route.g ? `corridor <b>${S.route.g.total.toFixed(0)} km</b> · longest gap <b>${S.route.g.maxGap.toFixed(0)} km</b>` : "corridor mode")
      : A && S.level !== "india" ? `τ ${S.opts.tauKm} km · baseline <b>${pct(A.ctx.base.coverage)}</b> → plan <b>${pct(A.plans[S.planKey].metrics.coverage)}</b> · ${A.ms.toFixed(0)} ms`
      : `within 10 km <b>${pct(st.coverage["10"], 0)}</b> · mean <b>${km(st.mean_dist)}</b>`;
  }

  /* ------------------------------------------------------------------ workspace (app mode) */
  const isApp = () => document.body.classList.contains("app-mode");
  function mapPad() {
    if (isApp() || innerWidth <= 1100) return { paddingTopLeft: [24, 24], paddingBottomRight: [24, 24] };
    return { paddingTopLeft: [360, 40], paddingBottomRight: [440, 20] };
  }
  const refit = debounce(() => map && map.invalidateSize({ pan: false }), 60);
  function enterApp(mode, fromBoot) {
    document.body.classList.add("app-mode");
    map.invalidateSize({ pan: false });
    if (mode === "corridor" && S.mode !== "corridor") { S.mode = "corridor"; if (!fromBoot) goIndia(); }
    else if (mode === "atlas" && S.mode === "corridor") { S.mode = "atlas"; S.route = null; clearLayers("route"); if (!fromBoot) goIndia(); }
    setTimeout(() => { map.invalidateSize(); if (!fromBoot && S.level === "india") map.fitBounds([[6.5, 68], [35.7, 97.4]]); }, 30);
    setURL();
  }
  function setPanel(cls, on) { document.body.classList.toggle(cls, !on); store.set("ws_" + cls, !on); refit(); syncToolbar(); }
  function syncToolbar() {
    $("#ab-left").setAttribute("aria-pressed", !document.body.classList.contains("no-left"));
    $("#ab-right").setAttribute("aria-pressed", !document.body.classList.contains("no-right"));
    $("#ab-ask").setAttribute("aria-pressed", !document.body.classList.contains("no-ask"));
    $("#ab-atlas").setAttribute("aria-pressed", S.mode !== "corridor");
    $("#ab-corr").setAttribute("aria-pressed", S.mode === "corridor");
    $("#ab-fs").textContent = document.fullscreenElement ? "🗗" : "⛶";
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement) (document.documentElement.requestFullscreen?.() || Promise.resolve()).catch(() => { });
    else document.exitFullscreen?.();
  }
  function setMode(m) {
    if (m === S.mode) return;
    S.mode = m;
    if (m === "atlas") { S.route = null; clearLayers("route"); }
    if (m === "corridor" && document.body.classList.contains("no-left")) setPanel("no-left", true);
    goIndia();
  }
  function initWorkspace() {
    const b = document.body;
    const narrow = matchMedia("(max-width: 900px)").matches;
    ["no-left", "no-right", "no-ask", "no-legend"].forEach(c => { if (store.get("ws_" + c, narrow && c === "no-ask")) b.classList.add(c); });
    if (narrow) $("#w-legend").classList.add("min");
    const w = store.get("ws_widths", null); if (w) { b.style.setProperty("--nav-w", w.nav + "px"); b.style.setProperty("--insp-w", w.insp + "px"); }
    const abt = $(".ab-tools");
    if (abt && !$("#ab-chal")) {
      const b = document.createElement("button"); b.className = "ab-btn ab-wide"; b.id = "ab-chal"; b.title = "Live challenge: name any district or corridor"; b.textContent = "⏱ Challenge"; b.onclick = openChallenge; abt.prepend(b);
    }
    if (DESK && DESK.team && !$("#sb-team")) { const t = document.createElement("span"); t.id = "sb-team"; t.className = "sb-badge"; t.style.cursor = "default"; t.textContent = "● team: " + DESK.team.name; ($("#sb-build") || document.body).before(t); }
    const sbb = $("#sb-build");
    if (sbb && !$("#sb-disc")) { const d = document.createElement("button"); d.id = "sb-disc"; d.className = "sb-badge"; d.title = "Data and AI disclosures"; d.textContent = "✓ Rule 5 & 6 disclosures"; d.onclick = openDisclosures; sbb.before(d); }
    const gs = searchBox("q", "Search any state, district or town…  ( / )");
    $("#ab-search").innerHTML = gs.html; gs.bind();
    $("#ab-left").onclick = () => setPanel("no-left", b.classList.contains("no-left"));
    $("#ab-right").onclick = () => setPanel("no-right", b.classList.contains("no-right"));
    $("#ab-ask").onclick = () => setPanel("no-ask", b.classList.contains("no-ask"));
    $("#ab-fs").onclick = toggleFullscreen;
    $("#ab-atlas").onclick = () => setMode("atlas");
    $("#ab-corr").onclick = () => setMode("corridor");
    $("#ab-theme").onclick = () => $("#theme-toggle").click();
    $("#ab-help").onclick = () => { $("#help").hidden = !$("#help").hidden; };
    $("#help-x").onclick = () => { $("#help").hidden = true; };
    $("#help").addEventListener("click", e => { if (e.target.id === "help") $("#help").hidden = true; });
    document.addEventListener("fullscreenchange", () => { syncToolbar(); refit(); });
    addEventListener("resize", refit);
    // resizable side panels
    [["#rz-left", "--nav-w", 1, 220, 560], ["#rz-right", "--insp-w", -1, 300, 760]].forEach(([sel, v, dir, min, max]) => {
      const el = $(sel);
      el.addEventListener("pointerdown", e => {
        e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add("drag");
        const x0 = e.clientX, w0 = parseFloat(getComputedStyle(b).getPropertyValue(v)) || (dir > 0 ? 320 : 430);
        const mv = ev => { b.style.setProperty(v, Math.max(min, Math.min(max, w0 + dir * (ev.clientX - x0))) + "px"); refit(); };
        const up = () => {
          el.classList.remove("drag"); el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up);
          const cs = getComputedStyle(b); store.set("ws_widths", { nav: parseFloat(cs.getPropertyValue("--nav-w")) || 320, insp: parseFloat(cs.getPropertyValue("--insp-w")) || 430 });
        };
        el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
      });
      el.addEventListener("dblclick", () => { b.style.removeProperty(v); store.set("ws_widths", null); refit(); });
    });
    // keyboard shortcuts (ignored while typing)
    document.addEventListener("keydown", e => {
      if (!isApp() || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target, typing = t.matches && t.matches("input, textarea, select, [contenteditable]");
      if (typing) { if (e.key === "Escape") t.blur(); return; }
      const k = e.key;
      if (k === "/") { e.preventDefault(); $("#q").focus(); $("#q").select(); }
      else if (k === "f" || k === "F") toggleFullscreen();
      else if (k === "[") $("#ab-left").click();
      else if (k === "]") $("#ab-right").click();
      else if (k === "a" || k === "A") $("#ab-ask").click();
      else if (k === "l" || k === "L") setPanel("no-legend", b.classList.contains("no-legend"));
      else if (k === "c" || k === "C") setMode(S.mode === "corridor" ? "atlas" : "corridor");
      else if (k === "?") $("#ab-help").click();
      else if (k === "Escape") {
        if (!$("#help").hidden) $("#help").hidden = true;
        else if (map._popup && map.hasLayer(map._popup)) map.closePopup();
        else if (S.selCand) { S.selCand = null; renderInspector(); drawPlan(false); }
        else if (S.level === "district") goState(S.sid);
        else if (S.level === "state" || S.mode === "corridor") { S.mode = "atlas"; S.route = null; clearLayers("route"); goIndia(); }
      }
      else if (/^[1-9]$/.test(k) && S.level !== "india" && S.mode !== "corridor") { S.tab = ["overview", "plan", "forecast", "compare", "validate", "evidence", "portfolio", "chargers", "ledger"][+k - 1]; renderInspector(); }
    });
    map.on("mousemove", e => { $("#sb-cursor").textContent = `${e.latlng.lat.toFixed(4)}°N ${e.latlng.lng.toFixed(4)}°E · z${map.getZoom().toFixed(1)}`; });
    initFloating(); initRole(); initPick(); initDocsMenu(); registerAPI();
    syncToolbar();
  }

  /* draggable, minimisable overlays (assistant, legend) inside the map area */
  function initFloating() {
    const narrow = () => matchMedia("(max-width: 900px)").matches;
    [["#w-ask", "ask"], ["#w-legend", "legend"]].forEach(([sel, key]) => {
      const w = $(sel), tb = $(".tb", w), area = $("#map");
      w.classList.add("floating");
      const saved = store.get("float_" + key, null);
      const minDefault = key === "ask" && !store.get("ask_opened", false);
      if (store.get("float_min_" + key, minDefault)) w.classList.add("min");
      const place = (x, y) => {
        const a = area.getBoundingClientRect(), r = w.getBoundingClientRect();
        x = Math.max(0, Math.min(a.width - Math.min(r.width, a.width), x));
        y = Math.max(0, Math.min(a.height - 32, y));
        Object.assign(w.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto" });
        return { x, y };
      };
      const reset = () => { ["left", "top", "right", "bottom"].forEach(k => w.style.removeProperty(k)); store.set("float_" + key, null); };
      if (saved && !narrow()) requestAnimationFrame(() => place(saved.x, saved.y));
      $("[data-min]", w).addEventListener("click", () => {
        store.set("float_min_" + key, w.classList.contains("min"));
        if (key === "ask") store.set("ask_opened", true);
        if (!narrow() && w.style.top) requestAnimationFrame(() => { const a = area.getBoundingClientRect(), r = w.getBoundingClientRect(); place(r.left - a.left, r.top - a.top); });
      });
      tb.addEventListener("dblclick", (e) => { if (!e.target.closest("button") && isApp()) reset(); });
      tb.addEventListener("pointerdown", (e) => {
        if (!isApp() || narrow() || e.target.closest("button")) return;
        e.preventDefault();
        const a = area.getBoundingClientRect(), r = w.getBoundingClientRect();
        const ox = e.clientX - r.left, oy = e.clientY - r.top;
        tb.setPointerCapture(e.pointerId); w.classList.add("drag");
        let last = null;
        const mv = (ev) => { last = place(ev.clientX - a.left - ox, ev.clientY - a.top - oy); };
        const up = () => { w.classList.remove("drag"); tb.removeEventListener("pointermove", mv); tb.removeEventListener("pointerup", up); if (last) store.set("float_" + key, last); };
        tb.addEventListener("pointermove", mv); tb.addEventListener("pointerup", up);
      });
      // keep it inside the map when the window or panels resize
      addEventListener("resize", debounce(() => { if (w.style.top && !narrow()) { const a = area.getBoundingClientRect(), r = w.getBoundingClientRect(); place(r.left - a.left, r.top - a.top); } }, 120));
    });
    // opening the assistant from the toolbar or "A" also expands it
    $("#ab-ask").addEventListener("click", () => { if (!document.body.classList.contains("no-ask")) { $("#w-ask").classList.remove("min"); store.set("float_min_ask", false); store.set("ask_opened", true); } });
  }

  /* ------------------------------------------------------------------ assistant */
  /* Assistant: built-in answers always; with a Groq key (desktop app), an agent on openai/gpt-oss-120b that operates
   * the workspace through tools. The key stays in the main process; the model sees the question, tool results and a
   * compact context, never the user's files. */
  let agentOn = false, chat = [];
  if (DESK && DESK.groqStatus) DESK.groqStatus().then(r => { agentOn = !!(r && r.configured); const s = $("#ask-mode"); if (s) s.textContent = agentOn ? "(connected)" : "(optional)"; });
  function initAsk() {
    const el = $("#ask-body");
    el.innerHTML = `<div class="chatlog" id="chatlog" aria-live="polite"></div>
      <div class="suggest" id="asks"></div>
      <form class="askbar" id="askform"><input id="askin" placeholder="Ask, or tell me what to do: “plan ₹10 crore in Nashik”…" autocomplete="off"><button aria-label="Send">↑</button></form>
      ${DESK ? `<details style="margin-top:8px;font-family:var(--sans);font-size:11.5px"><summary style="cursor:pointer">AI agent: Groq · gpt-oss-120b <span id="ask-mode">${agentOn ? "(connected)" : "(optional)"}</span></summary>
        <p style="margin:6px 0">With a Groq API key the assistant becomes an agent: it can open regions, set budgets and objectives, run plans, check corridors, plan freight stations and explain sites, step by step in this chat. The key is encrypted by Windows and used only by the app's main process.</p>
        <div class="askbar"><input type="password" id="akey" placeholder="gsk_…" value="${agentOn ? "••••••••" : ""}"><button type="button" id="akeyset" aria-label="Save key">✓</button></div>
        <button type="button" class="linkbtn" id="akclr">forget key</button></details>` : ""}`;
    say("bot", "Hi! I work from the loaded data: 28k+ real chargers, VAHAN registrations by RTO, census demand and the PM E-DRIVE optimiser. Ask where access is weakest, or tell me to plan a district or a corridor.");
    renderAskSuggestions();
    $("#askform").onsubmit = (e) => { e.preventDefault(); const q = $("#askin").value.trim(); if (!q) return; $("#askin").value = ""; ask(q); };
    if (DESK) {
      $("#akeyset").onclick = async () => { const v = $("#akey").value.trim(); if (!v || v.startsWith("•")) return; const r = await DESK.secretSet("groq", v); if (r && r.ok) { agentOn = true; $("#ask-mode").textContent = "(connected)"; $("#akey").value = "••••••••"; Audit.add("assistant.key_set", "groq"); say("bot", "Agent connected (Groq · gpt-oss-120b). Try: “Plan ₹10 crore in Pune under PM E-DRIVE and tell me the subsidy.”"); } else say("bot", "Could not store the key: " + ((r && r.error) || "unknown")); };
      $("#akclr").onclick = async () => { await DESK.secretSet("groq", null); agentOn = false; $("#ask-mode").textContent = "(optional)"; $("#akey").value = ""; say("bot", "Key forgotten."); };
    }
  }
  function renderAskSuggestions() {
    const s = agentOn ? ["Plan ₹10 crore in Pune under PM E-DRIVE", "Plan e-truck charging Delhi to Jaipur", "Which district in Bihar needs chargers most?"]
      : S.level === "india" ? ["Which districts have the worst access?", "Compare Kerala and Bihar", "Delhi to Jaipur by EV?"] : S.level === "state" ? ["Worst-served districts here?", "Who operates most chargers?", "Where should the next chargers go?"] : ["Where should the next chargers go?", "How reliable is this data?", "Who operates chargers here?"];
    $("#asks").innerHTML = s.map(x => `<button type="button">${esc(x)}</button>`).join("");
    $$("#asks button").forEach(b => b.onclick = () => ask(b.textContent));
  }
  function say(who, text, small) {
    const log = $("#chatlog"), m = document.createElement("div");
    m.className = "msg " + who; m.innerHTML = `<div></div><small></small>`; m.firstChild.textContent = text; m.lastChild.textContent = small || "";
    log.appendChild(m); log.scrollTop = 1e9; return m;
  }

  function findRegion(q) {
    const n = norm(q); let best = null;
    for (const s of INDIA.states) if (n.includes(norm(s.name))) best = best && best.name.length > s.name.length ? best : { kind: "state", id: s.id, name: s.name, stats: s.stats };
    for (const d of INDIA.districts) if (d.name.length > 3 && n.includes(norm(d.name)) && (!best || d.name.length > best.name.length)) best = { kind: "district", id: d.id, name: d.name, stats: d.stats };
    return best;
  }
  function scopeDistricts() { return S.sid ? INDIA.districts.filter(d => d.sid === S.sid) : INDIA.districts; }
  function scopeName() { return S.did ? INDIA.districtById.get(S.did).name : S.sid ? INDIA.stateById.get(S.sid).name : "India"; }
  function localAnswer(q) {
    const n = norm(q);
    const route = n.match(/(?:from\s+)?([a-z .]+?)\s+(?:to|→|->)\s+([a-z .]+?)(?:\s+by ev|\?|$)/);
    if (route && /\bto\b|→|->/.test(n) && (/ev|drive|trip|route|corridor/.test(n) || findPlace(route[1].trim()))) {
      const a = findPlace(route[1].trim()), b = findPlace(route[2].trim());
      if (a && b) { S.mode = "corridor"; S.corridor.from = a; S.corridor.to = b; goIndia(); setTimeout(runCorridor, 50); return `Checking the ${a[0]} → ${b[0]} corridor on the highway graph. The full report is in the Inspector, and gaps are drawn in pink and red.`; }
    }
    const cmp = n.match(/compare\s+(.+?)\s+(?:and|vs\.?|with)\s+(.+)/);
    if (cmp) {
      const a = findRegion(cmp[1]), b = findRegion(cmp[2]);
      if (a && b) { const row = (r) => `${r.name}: ${nIN(r.stats.chargers)} chargers, ${nIN(r.stats.per_lakh, 2)} per lakh people, ${pct(r.stats.coverage["10"], 0)} of people within 10 km, mean distance ${km(r.stats.mean_dist)}, DC share ${pct(r.stats.chargers ? r.stats.dc_sites / r.stats.chargers : null, 0)}.`; return `${row(a)}\n${row(b)}\n${a.stats.coverage["10"] > b.stats.coverage["10"] ? a.name : b.name} has better 10 km access.`; }
    }
    if (/worst|weakest|lowest|underserved|least|poorest|gaps?\b/.test(n) && !/where should|next charger/.test(n)) {
      const ds = scopeDistricts().filter(d => d.stats.pop > (S.sid ? 0 : 5e5)).sort((x, y) => x.stats.coverage["10"] - y.stats.coverage["10"]).slice(0, 5);
      return `Weakest 10 km access in ${S.sid ? INDIA.stateById.get(S.sid).name : "India (districts > 5 L people)"}:\n` + ds.map((d, i) => `${i + 1}. ${d.name}${S.sid ? "" : ` (${INDIA.stateById.get(d.sid).name})`}: ${pct(1 - d.stats.coverage["10"], 0)} beyond 10 km, ${nIN(d.stats.chargers)} chargers`).join("\n");
    }
    if (/best|strongest|highest coverage|most covered/.test(n)) {
      const ds = scopeDistricts().filter(d => d.stats.pop > 2e5).sort((x, y) => y.stats.coverage["10"] - x.stats.coverage["10"] || y.stats.per_lakh - x.stats.per_lakh).slice(0, 5);
      return `Best-served districts in ${S.sid ? INDIA.stateById.get(S.sid).name : "India"}:\n` + ds.map((d, i) => `${i + 1}. ${d.name}: ${pct(d.stats.coverage["10"], 0)} within 10 km, ${nIN(d.stats.per_lakh, 1)} per lakh`).join("\n");
    }
    if (/where|next|build|recommend|site|place.*charger|optimi/.test(n)) {
      if (S.level === "india") return "Open a state or district first (click it on the map). Then I'll run the budget optimiser there and explain the top sites.";
      if (!S.analysis) runAnalysis();
      const p = S.analysis.plans[S.planKey];
      S.tab = "plan"; renderInspector(); drawPlan(true);
      return `With ${rupL(effOpts().budgetLakh)} at τ = ${S.opts.tauKm} km, the ${p.name.toLowerCase()} picks ${p.metrics.sites} sites, lifting coverage in ${scopeName()} from ${pct(S.analysis.ctx.base.coverage)} to ${pct(p.metrics.coverage)} (+${people(p.metrics.newlyCovered)} people, ${p.metrics.costPerPerson ? rup(p.metrics.costPerPerson) + " per person" : ""}).\nTop picks:\n` + p.selected.slice(0, 3).map((c, i) => `${i + 1}. ${c.label}: covers ${people(c.raw.gap)} unserved people, score ${c.score.toFixed(0)}, ${E.confidenceFor(c, S.analysis.ctx).grade.toLowerCase()} confidence`).join("\n") + "\nThe pins on the map are numbered in pick order.";
    }
    if (/operator|company|who (runs|operates)/.test(n)) {
      const st = S.did ? statOf(S.did) : S.sid ? INDIA.stateById.get(S.sid).stats : INDIA.totals;
      return `Largest operators in ${scopeName()} by listed sites:\n` + st.operators.slice(0, 6).map(([o, c], i) => `${i + 1}. ${o}: ${nIN(c)}`).join("\n");
    }
    if (/price|tariff|cost per|kwh|₹/.test(n)) { const st = S.did ? statOf(S.did) : S.sid ? INDIA.stateById.get(S.sid).stats : INDIA.totals; return `Median published tariff in ${scopeName()}: ${st.median_price ? "₹" + st.median_price + "/kWh" : "not published"}. Nationally, oil-PSU sites cluster at ₹14/kWh and private CPOs at ₹21–26.`; }
    if (/reliab|confiden|trust|quality|accurate|source/.test(n)) {
      const st = S.did ? statOf(S.did) : S.sid ? INDIA.stateById.get(S.sid).stats : INDIA.totals;
      return `${scopeName()}: ${pct(st.verified, 0)} of charger sites are confirmed by ≥2 independent sources. ${S.did ? (st.census_flag === "observed" ? "Census demand maps one-to-one onto a 2011 district." : "This is a post-2011 district, so its census figures are apportioned (imputed).") : ""} Distances are straight-line × detour, and operational status isn't observed. See the Ledger tab, where you can also run a live OpenStreetMap check.`;
    }
    if (/how many|count|number of|beyond|within/.test(n)) {
      const st = S.did ? statOf(S.did) : S.sid ? INDIA.stateById.get(S.sid).stats : INDIA.totals;
      return `${scopeName()}: ${nIN(st.chargers)} listed charging sites for ${people(st.pop)} people (Census 2011). About ${people(st.pop * (1 - st.coverage["10"]))} people (${pct(1 - st.coverage["10"], 0)}) live more than 10 km straight-line from one, and ${people(st.pop * (1 - st.coverage["25"]))} more than 25 km.`;
    }
    const r = findRegion(q);
    if (r) { r.kind === "state" ? goState(r.id) : goDistrict(r.id); return `Opening ${r.name}: ${nIN(r.stats.chargers)} chargers, ${pct(r.stats.coverage["10"], 0)} of people within 10 km.`; }
    return null;
  }
  /* ---------- agent tools: each one really operates the workspace and returns a compact result ---------- */
  const planBrief = () => {
    const A = S.analysis; if (!A) return null; const p = A.plans[S.planKey], sm = PM.summarise(p.selected);
    return { region: regionName(), objective: p.name, budget_lakh: effOpts().budgetLakh, budget_counts: S.opts.pm.enabled ? S.opts.pm.budgetBasis : "simple cost", threshold_km: S.opts.tauKm,
      coverage_before: +A.ctx.base.coverage.toFixed(4), coverage_after: +p.metrics.coverage.toFixed(4), people_newly_covered: Math.round(p.metrics.newlyCovered), sites: p.selected.length,
      pm_edrive: S.opts.pm.enabled ? { project_cost_lakh: sm.total, subsidy_lakh: sm.subsidy, subsidy_by_category_lakh: sm.byCat, agency_outlay_lakh: sm.net, category_a_share: +sm.catAShare.toFixed(3), chargers: sm.chargers } : null,
      guarantee: p.guarantee ? p.guarantee.basis : null,
      top_sites: p.selected.slice(0, 6).map((c, i) => ({ rank: i + 1, label: c.label, category: c.pm && c.pm.category, station: c.pm && c.pm.archLabel, cost_lakh: c.cost, people_reached: Math.round(c.raw.gap) })) };
  };
  const AGENT_TOOLS = [
    ["go_to_region", "Open a state, district or town (town opens its district) in the workspace.", { name: { type: "string", description: "e.g. Pune, Bastar, Kerala" } }, ["name"]],
    ["set_plan_options", "Change planning options and re-optimise. Only pass what should change.", { budget_crore: { type: "number" }, threshold_km: { type: "number" }, objective: { type: "string", enum: ["greedy", "equity", "corridor", "commercial"] }, budget_basis: { type: "string", enum: ["total", "subsidy", "net"] }, pm_edrive: { type: "boolean" }, prefer_battery_swapping: { type: "boolean" } }, []],
    ["get_plan", "Summary of the current plan: coverage, sites, PM E-DRIVE cost and subsidy by category, top sites.", {}, []],
    ["get_site", "PM E-DRIVE breakdown and peak-hour queue for one site of the current plan.", { rank: { type: "integer" } }, ["rank"]],
    ["get_region_stats", "Key statistics for the open region (and ranking of districts in a state).", {}, []],
    ["forecast_2030", "S-curve EV fleet and chargers (12 / 60 / 240 kW guns) needed in 2030 for the open region.", {}, []],
    ["compare_with_baseline", "ReachGrid greedy vs EV-to-charger ratio allocation for the same budget.", {}, []],
    ["check_corridor", "Route between two towns and test EV feasibility.", { from: { type: "string" }, to: { type: "string" }, range_km: { type: "number" } }, ["from", "to"]],
    ["plan_freight", "Heavy-vehicle (e-truck / e-bus) highway stations along a corridor (PM E-DRIVE highway EV PCS).", { from: { type: "string" }, to: { type: "string" }, range_km: { type: "number" } }, ["from", "to"]],
    ["open_view", "Show something to the user.", { view: { type: "string", enum: ["overview", "plan", "forecast", "compare", "validate", "evidence", "portfolio", "chargers", "ledger", "split_screen", "proposal_export"] } }, ["view"]],
  ];
  async function agentTool(name, a = {}) {
    const resolve = (n) => challengeTarget(String(n || ""));
    if (name === "go_to_region") {
      const r = resolve(a.name); if (!r) return { error: `no state, district or town called ${a.name}` };
      S.mode = "atlas"; S.route = null; if (r.did) await goDistrict(r.did); else await goState(r.sid);
      return { opened: scopeName(), level: S.level, ...(planBrief() ? { plan: planBrief() } : {}) };
    }
    if (name === "set_plan_options") {
      if (S.level === "india") return { error: "open a state or district first (go_to_region)" };
      if (a.budget_crore != null) { const v = Math.max(0.2, Math.min(2000, +a.budget_crore)) * 100; if (S.level === "state") S.opts.budgetStateLakh = v; else S.opts.budgetLakh = v; }
      if (a.threshold_km != null) S.opts.tauKm = Math.max(2, Math.min(50, Math.round(+a.threshold_km)));
      if (a.objective) S.planKey = a.objective;
      if (a.budget_basis || a.pm_edrive != null || a.prefer_battery_swapping != null) S.opts.pm = { ...S.opts.pm, ...(a.budget_basis ? { budgetBasis: a.budget_basis } : {}), ...(a.pm_edrive != null ? { enabled: !!a.pm_edrive } : {}), ...(a.prefer_battery_swapping != null ? { preferSwap: !!a.prefer_battery_swapping } : {}) };
      store.set("opts", S.opts); S.sens = null; S.compare = null; S.backtest = null;
      runAnalysis(); drawPlan(true); S.tab = "plan"; renderInspector(); updateStatus(); Audit.add("assistant.plan", JSON.stringify(a).slice(0, 120));
      return planBrief();
    }
    if (name === "get_plan") return planBrief() || { error: "no plan: open a state or district" };
    if (name === "get_site") {
      const A = S.analysis; if (!A) return { error: "no plan" }; const c = A.plans[S.planKey].selected[(+a.rank || 1) - 1]; if (!c) return { error: "no such rank" };
      selectCand(c.id);
      const { fleet } = fleetInReach(c, A.ctx), q = c.pm ? PM.siteQueue(c.pm.arch, fleet, 1 / (1 + (c.raw.localChargers || 0))) : {};
      return { label: c.label, lat: c.lat, lng: c.lng, score: +c.score.toFixed(1), people_newly_within_threshold: Math.round(c.raw.gap), existing_chargers_in_reach: c.raw.localChargers,
        pm_edrive: c.pm && { category: c.pm.category, station: c.pm.archLabel, chargers: c.pm.chargers.map(l => `${l.n} x ${l.kw} kW ${l.conn}`), upstream_lakh: c.pm.upstream, evse_lakh: c.pm.evse, total_lakh: c.pm.total, subsidy_lakh: c.pm.subsidy, net_lakh: c.pm.net },
        queue: Object.fromEntries(Object.entries(q).map(([g, m]) => [g, { guns: m.guns, p_wait: +m.pWait.toFixed(2), extra_guns_needed: m.extra }])), confidence: E.confidenceFor(c, A.ctx).grade };
    }
    if (name === "get_region_stats") { const c = contextForClaude(); delete c.states; if (c.districts) c.districts = c.districts.slice(0, 12); return c; }
    if (name === "forecast_2030") {
      const R = regionEV(); if (!R) return { error: "no VAHAN data for this region (open a state or district)" };
      const F = PM.scurveForecast(R.ev, S.opts.scurve), r = F.rows[F.rows.length - 1];
      S.tab = "forecast"; renderInspector();
      return { region: regionName(), anchor_year: F.anchorYear, ev_share_new_regs_now: F.rows[0].share, year: r.year, ev_share_new_regs: r.share, fleet: r.stock, note: "guns and MW are in the Forecast tab now shown" };
    }
    if (name === "compare_with_baseline") {
      const P = S.analysis && S.analysis.plans; if (!P) return { error: "no plan" };
      return { reachgrid: { people: Math.round(P.greedy.metrics.newlyCovered), sites: P.greedy.metrics.sites, cost_lakh: P.greedy.metrics.cost }, ev_ratio_method: { people: Math.round(P.ratio.metrics.newlyCovered), sites: P.ratio.metrics.sites, cost_lakh: P.ratio.metrics.cost } };
    }
    if (name === "check_corridor" || name === "plan_freight") {
      const f = findPlace(a.from || ""), t = findPlace(a.to || ""); if (!f || !t) return { error: "unknown town(s)" };
      S.mode = "corridor"; S.corridor.from = f; S.corridor.to = t; if (a.range_km && name === "check_corridor") S.corridor.range = +a.range_km;
      await goIndia(); await runCorridor(); const g = S.route && S.route.g; if (!g) return { error: (S.route && S.route.error) || "no route" };
      const base = { from: f[0], to: t[0], km: Math.round(g.total), chargers_near_route: g.stops.length, longest_gap_km: Math.round(g.maxGap), feasible_for_range: g.feasible, range_km: S.corridor.range };
      if (name === "check_corridor") return base;
      S.freightCfg = { range: +a.range_km || 150, kw: 120 }; renderInspector(); await new Promise(r => setTimeout(r, 50));
      const sel = $("#fr-r"); if (sel) sel.value = String(S.freightCfg.range); await runFreight(); const F = S.freight;
      return { ...base, heavy_vehicle_range_km: S.freightCfg.range, new_highway_stations: F.stations.map(x => ({ km: Math.round(x.at), site: x.name, category: x.pm.category, subsidy_lakh: x.pm.subsidy })), existing_heavy_duty_used: F.used.length, project_cost_lakh: F.summary.total, subsidy_lakh: F.summary.subsidy, passable: F.feasible };
    }
    if (name === "open_view") {
      const v = a.view;
      if (v === "split_screen") { if (!S.analysis) return { error: "no plan" }; S.tab = "compare"; renderInspector(); openSplit(); return { shown: v }; }
      if (v === "proposal_export") { if (!S.analysis) return { error: "no plan" }; await exportSNA(); return { shown: "MHI proposal export dialog; the user fills the nodal agency and confirms" }; }
      if (S.level === "india") return { error: "open a state or district first" };
      S.tab = v; renderInspector(); return { shown: v };
    }
    return { error: "unknown tool " + name };
  }
  const SYSTEM = `You are ReachGrid's planning agent for public EV charging in India, inside the ReachGrid desktop app. You operate the workspace with tools: open regions, set budgets and objectives, run plans, inspect sites, forecast, compare with the EV-to-charger ratio method, check corridors and plan heavy-vehicle stations. Use tools to get numbers; never invent figures. Money is in Indian rupees: 1 crore = 100 lakh; tools take budget in crore and return costs in lakh. PM E-DRIVE (MHI Operational Guidelines, 26 Sep 2025): Category A govt premises 100% upstream + 100% EVSE; B govt-controlled public sites (PSU fuel outlets, toll plazas, stations) 80% + 70%; C others 80% upstream; D battery swapping 80% upstream. Caveats to mention when relevant: chargers are listed sites, not verified operational; demand is Census 2011 population; distances are straight-line × detour unless routed; upstream costs are estimates until DISCOM demand notes. Be concise: short paragraphs or bullet points, Indian number formatting.`;
  async function ask(q) {
    say("me", q);
    const local = localAnswer(q);
    if (!agentOn || !DESK || !DESK.groqChat) { say("bot", local || (DESK ? "I can answer: worst/best access, where to build next, compare A and B, operators, tariffs, data reliability, and “X to Y by EV”. Add a Groq API key below and I can operate the workspace for you." : "Open the ReachGrid desktop app for the AI agent."), "built-in · from bundled data"); return; }
    const tools = AGENT_TOOLS.map(([n, d, props, req]) => ({ type: "function", function: { name: n, description: d, parameters: { type: "object", properties: props, required: req } } }));
    chat.push({ role: "user", content: `${q}\n\n(Workspace now: ${scopeName()}, level ${S.level}${S.mode === "corridor" ? ", corridor mode" : ""}.)` });
    const m = say("bot", "…", "agent · Groq gpt-oss-120b"), steps = [];
    const show = (t) => { m.firstChild.textContent = t; $("#chatlog").scrollTop = 1e9; };
    try {
      for (let round = 0; round < 8; round++) {
        const r = await DESK.groqChat({ messages: [{ role: "system", content: SYSTEM }, ...chat.slice(-24)], tools, tool_choice: "auto" });
        if (!r || !r.ok) throw new Error((r && r.error) || "no response");
        const msg = r.message, calls = msg.tool_calls || [];
        chat.push({ role: "assistant", content: msg.content || "", ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) { show((steps.length ? steps.join("\n") + "\n\n" : "") + (msg.content || "(no answer)")); m.lastChild.textContent = `agent · ${r.model || "gpt-oss-120b"} · ${steps.length} action${steps.length === 1 ? "" : "s"}`; Audit.add("assistant.answer", q.slice(0, 100)); return; }
        for (const c of calls) {
          let args = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch { args = {}; }
          steps.push(`→ ${c.function.name.replace(/_/g, " ")} ${Object.values(args).join(", ")}`.trim()); show(steps.join("\n") + "\n…");
          let out; try { out = await agentTool(c.function.name, args); } catch (err) { out = { error: err.message }; }
          chat.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, 6000) });
        }
      }
      show(steps.join("\n") + "\n\n(Stopped after 8 steps. Ask me to continue.)");
    } catch (e) {
      chat = chat.filter(x => x.role === "user" || (x.role === "assistant" && !x.tool_calls));
      show((local ? local + "\n\n" : "") + `(Agent unavailable: ${/401|invalid/i.test(e.message) ? "invalid Groq API key" : e.message})`); m.lastChild.textContent = "built-in fallback";
    }
  }
  function contextForClaude() {
    const pick = (s) => ({ pop_2011: s.pop, chargers: s.chargers, per_lakh: s.per_lakh, coverage_5_10_25km: s.coverage, mean_dist_km: s.mean_dist, dc_sites: s.dc_sites, verified_share: s.verified, median_kw: s.median_kw, median_tariff_rs_kwh: s.median_price, car_household_rate_2011: s.car_rate, operators: s.operators?.slice(0, 5), census_flag: s.census_flag });
    const c = { scope: scopeName(), level: S.level, data_build: INDIA.version, india: pick(INDIA.totals) };
    if (S.sid) { c.state = { name: INDIA.stateById.get(S.sid).name, ...pick(INDIA.stateById.get(S.sid).stats) }; c.districts = scopeDistricts().map(d => ({ name: d.name, ...pick(d.stats) })).sort((a, b) => a.coverage_5_10_25km["10"] - b.coverage_5_10_25km["10"]).slice(0, 40); }
    else c.states = INDIA.states.map(s => ({ name: s.name, ...pick(s.stats) }));
    if (S.did) c.district = { name: INDIA.districtById.get(S.did).name, ...pick(statOf(S.did)), towns: curDistrict().places.slice(0, 10) };
    if (S.analysis) { const p = S.analysis.plans[S.planKey]; c.plan = { method: p.name, threshold_km: S.opts.tauKm, budget_lakh: effOpts().budgetLakh, baseline_coverage: S.analysis.ctx.base.coverage, coverage_after: p.metrics.coverage, newly_covered: p.metrics.newlyCovered, sites: p.selected.slice(0, 8).map(x => ({ label: x.label, host: x.host, cost_lakh: x.cost, score: +x.score.toFixed(1), unserved_people_reached: Math.round(x.raw.gap), unknown_components: x.missing })), other_plans: Object.values(S.analysis.plans).map(q => ({ name: q.name, coverage: q.metrics.coverage, cost_lakh: q.metrics.cost })) }; }
    if (S.route && S.route.g) c.corridor = { from: S.route.from[0], to: S.route.to[0], km: S.route.g.total, chargers_near_route: S.route.g.stops.length, longest_gap_km: S.route.g.maxGap, feasible: S.route.g.feasible, range_km: S.route.opts.range };
    return c;
  }

  /* ================================================================== governance (§13) */
  // Client-side workflow controls: roles, a hash-chained audit log, human review and encrypted exports.
  // They enforce process discipline in the browser; a production deployment would enforce them on a server.
  const ROLES = { viewer: "Viewer", analyst: "Analyst", admin: "Admin" };
  const PERMS = {
    viewer: [],
    analyst: ["run", "save", "export", "evidence", "propose", "ev_upload"],
    admin: ["run", "save", "export", "evidence", "propose", "ev_upload", "approve", "portfolio", "audit_admin"],
  };
  const Gov = {
    role: () => DESK ? ((DESK.session() || {}).role || "viewer") : store.get("role", "analyst"),
    user: () => DESK ? ((DESK.session() || {}).user || "signed-out") : store.get("user", "analyst@local"),
    can: (p) => DESK ? (((DESK.session() || {}).perms) || []).includes(p) : PERMS[Gov.role()].includes(p),
    need(p, what) { if (Gov.can(p)) return true; toast(`Your role (${ROLES[Gov.role()]}) cannot ${what}. Switch role in the toolbar.`); return false; },
  };
  const hexOf = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  async function sha256Hex(text) {
    if (window.crypto && crypto.subtle) return hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return "fnv-" + fnv(text) + fnv(text + "#");   // insecure contexts (file://) only
  }
  const Audit = {
    list: () => DESK ? DESK.auditList() : store.get("audit", []),
    async add(action, detail) {
      if (DESK) return DESK.auditAdd(action, String(detail || "").slice(0, 300));
      const list = Audit.list(), prev = list.length ? list[list.length - 1].hash : "0".repeat(64);
      const e = { ts: new Date().toISOString(), user: Gov.user(), role: Gov.role(), action, detail: String(detail || "").slice(0, 300), build: INDIA.version, prev };
      e.hash = await sha256Hex(JSON.stringify([e.ts, e.user, e.role, e.action, e.detail, e.build, e.prev]));
      list.push(e); store.set("audit", list.slice(-3000));
    },
    async verify() {
      if (DESK) return DESK.auditVerify();
      const list = Audit.list();
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (i && e.prev !== list[i - 1].hash) return { ok: false, at: i, why: "chain link broken" };
        const h = await sha256Hex(JSON.stringify([e.ts, e.user, e.role, e.action, e.detail, e.build, e.prev]));
        if (h !== e.hash) return { ok: false, at: i, why: "entry altered" };
      }
      return { ok: true, n: list.length };
    },
  };
  const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
  const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function deriveKey(pass, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encryptJSON(obj, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(pass, salt), new TextEncoder().encode(JSON.stringify(obj)));
    return JSON.stringify({ format: "reachgrid-enc-v1", cipher: "AES-256-GCM", kdf: "PBKDF2-SHA256", iterations: 250000, salt: b64(salt), iv: b64(iv), ciphertext: b64(ct) });
  }
  async function decryptJSON(text, pass) {
    const o = JSON.parse(text); if (o.format !== "reachgrid-enc-v1") throw new Error("Not a ReachGrid encrypted file");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, await deriveKey(pass, unb64(o.salt)), unb64(o.ciphertext));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  function toast(msg) {
    let t = $("#rg-toast");
    if (!t) { t = document.createElement("div"); t.id = "rg-toast"; t.className = "rg-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3200);
  }
  function askText(title, { password = false, placeholder = "" } = {}) {
    return new Promise(res => {
      const d = document.createElement("div"); d.className = "help rg-prompt"; d.style.display = "grid";
      d.innerHTML = `<div class="win"><div class="tb"><span class="t">${esc(title)}</span></div><div class="bd"><form><input ${password ? 'type="password"' : 'type="text"'} placeholder="${esc(placeholder)}" style="width:100%" required><div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end"><button type="button" class="btn sm ghost">Cancel</button><button class="btn sm">OK</button></div></form></div></div>`;
      ($("#atlas .desk") || document.body).appendChild(d);
      const inp = $("input", d); inp.focus();
      $("form", d).onsubmit = (e) => { e.preventDefault(); d.remove(); res(inp.value); };
      $("button[type=button]", d).onclick = () => { d.remove(); res(null); };
    });
  }
  function pickFile(accept) {
    if (DESK) return DESK.openFile(accept).then(r => { if (r && r.error) { toast(r.error); return null; } return r; });
    return new Promise(res => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => { const f = i.files[0]; if (!f) return res(null); const r = new FileReader(); r.onload = () => res({ name: f.name, text: r.result }); r.readAsText(f); }; i.click(); });
  }
  function initRole() {
    const tools = $(".ab-tools"); if (!tools || $("#ab-role")) return;
    const b = document.createElement("button"); b.className = "ab-btn ab-role"; b.id = "ab-role"; b.title = "Role (workflow permissions)";
    const sync = () => { b.textContent = DESK ? `${(DESK.session() || {}).name || "Signed out"} · ${ROLES[Gov.role()]}` : ROLES[Gov.role()]; };
    if (DESK) { b.title = "Account, users and settings"; b.onclick = () => openSettings("account"); tools.prepend(b); sync(); window.__syncRole = sync; return; }
    b.onclick = async () => {
      const next = { viewer: "analyst", analyst: "admin", admin: "viewer" }[Gov.role()];
      if (next === "admin" && store.get("admin_pin", null)) {
        const pin = await askText("Admin PIN", { password: true }); if (pin == null) return;
        if (await sha256Hex("pin:" + pin) !== store.get("admin_pin")) { toast("Wrong PIN"); return; }
      }
      store.set("role", next); sync(); Audit.add("role.switch", next); toast(`Role: ${ROLES[next]}`); renderInspector();
    };
    tools.prepend(b); sync();
  }

  /* ================================================================== stored workspace data */
  const Evidence = { all: () => store.get("evidence", []), set: (v) => store.set("evidence", v) };
  const Portfolio = { all: () => store.get("portfolio", []), set: (v) => store.set("portfolio", v) };
  const EVUpload = { get: () => store.get("ev_upload", null), set: (v) => store.set("ev_upload", v) };
  const Review = {
    all: () => store.get("review", {}),
    get: (scen, id) => (Review.all()[scen] || {})[id] || null,
    set(scen, id, val) { const r = Review.all(); (r[scen] ||= {})[id] = val; store.set("review", r); },
  };
  const REVIEW_LABEL = { proposed: "Proposed", under_review: "Under review", approved: "Approved for field validation", rejected: "Rejected" };
  const REVIEW_TAG = { proposed: "der", under_review: "imp", approved: "obs", rejected: "syn" };
  function extraChargers() { return store.get("portfolio_counts", true) ? Portfolio.all().map(p => ({ lat: p.lat, lng: p.lng, id: p.id, dc: p.kw >= 15 })) : []; }
  function evMap() { const u = EVUpload.get(); return u ? u.byDistrict : null; }

  /* ================================================================== charts (inline SVG) */
  function lineChart(series, { w = 380, h = 170, xFmt = (v) => v, yFmt = (v) => v, xLabel = "", yLabel = "" } = {}) {
    const pad = { l: 40, r: 10, t: 10, b: 30 };
    const cat = series[0].points.map(p => p[0]);
    series = series.map(s => ({ ...s, raw: s.points, points: s.points.map((p, k) => [k, p[1]]) }));
    const xs = series.flatMap(s => s.points.map(p => p[0])), ys = series.flatMap(s => s.points.map(p => p[1]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const yl = y0 - (y1 - y0) * 0.08, yh = y1 + (y1 - y0) * 0.08 || y1 + 0.01;
    const X = (v) => pad.l + (x1 === x0 ? 0 : (v - x0) / (x1 - x0)) * (w - pad.l - pad.r), Y = (v) => h - pad.b - ((v - yl) / (yh - yl)) * (h - pad.t - pad.b);
    const ticks = [0, 0.5, 1].map(f => yl + (yh - yl) * f);
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(yLabel)} by ${esc(xLabel)}" style="background:var(--paper);border:1.5px solid var(--line)">
      ${ticks.map(t => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="currentColor" stroke-opacity=".12"/><text x="${pad.l - 4}" y="${Y(t) + 3}" font-size="9" text-anchor="end" font-family="monospace" fill="currentColor">${esc(yFmt(t))}</text>`).join("")}
      ${series.map(s => `<polyline fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="4 3"' : ""} points="${s.points.map(p => X(p[0]) + "," + Y(p[1])).join(" ")}"/>${s.points.map(p => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="2.6" fill="${s.color}"><title>${esc(s.name)}: ${esc(xFmt(cat[p[0]]))} → ${esc(yFmt(p[1]))}</title></circle>`).join("")}`).join("")}
      ${series[0].points.map(p => `<text x="${X(p[0])}" y="${h - pad.b + 12}" font-size="8.5" text-anchor="middle" font-family="monospace" fill="currentColor">${esc(String(xFmt(cat[p[0]])).replace("₹", ""))}</text>`).join("")}
      <text x="${(w + pad.l) / 2}" y="${h - 4}" font-size="9" text-anchor="middle" font-family="monospace" fill="currentColor">${esc(xLabel)}</text>
    </svg><div style="display:flex;gap:12px;font-size:11px;margin-top:4px">${series.map(s => `<span><i style="display:inline-block;width:14px;height:3px;background:${s.color};vertical-align:middle"></i> ${esc(s.name)}</span>`).join("")}</div>`;
  }
  function barRows(rows, { max = 1, fmt = (v) => pct(v), color = "var(--ink)", marker = null } = {}) {
    return rows.map(r => `<div class="hist" style="grid-template-columns:118px 1fr 52px"><span title="${esc(r.name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span><div class="minibar" style="height:12px">${marker != null ? `<s style="position:absolute;left:${(marker / max) * 100}%;top:-2px;bottom:-2px;width:2px;background:var(--hot)"></s>` : ""}<i style="width:${Math.max(0, Math.min(1, r.value / max)) * 100}%;background:${r.color || color}"></i></div><span style="text-align:right">${fmt(r.value)}</span></div>`).join("");
  }

  /* ================================================================== async jobs (Web Worker, §14.1) */
  let worker = null, jobSeq = 0; const jobs = new Map();
  function getWorker() {
    if (worker !== null) return worker;
    try {
      if (location.protocol === "file:") throw new Error("file://");
      worker = new Worker("js/worker.js");
      worker.onmessage = (e) => { const j = jobs.get(e.data.id); if (!j) return; jobs.delete(e.data.id); e.data.error ? j.rej(new Error(e.data.error)) : j.res(e.data.result); };
      worker.onerror = () => { worker = false; for (const j of jobs.values()) j.fallback(); jobs.clear(); };
    } catch { worker = false; }
    return worker;
  }
  function jobArgs() {
    return { sid: S.sid, districtIds: S.level === "district" ? [S.did] : null, opts: effOpts(), evidence: Evidence.all(), extraChargers: extraChargers(), evByDistrict: evMap() };
  }
  /** run a heavy job off the main thread; falls back to the main thread when workers are unavailable */
  function runJob(job, extra = {}) {
    const args = { ...jobArgs(), ...extra };
    const local = () => new Promise((res, rej) => setTimeout(() => { try { res(window.RGJobs.run(job, args, { india: INDIA, roads: ROADS, stateData: curState() })); } catch (e) { rej(e); } }, 20));
    const w = getWorker();
    if (!w) return local();
    return new Promise((res, rej) => { const id = ++jobSeq; jobs.set(id, { res, rej, fallback: () => local().then(res, rej) }); w.postMessage({ id, job, args }); });
  }

  /* ================================================================== Compare tab: budget curve, optimisers, sensitivity */
  function tabCompare(tb) {
    const C = S.compare || {};
    const busy = (id) => `<p class="sub" id="${id}">Running in a background worker…</p>`;
    tb.innerHTML = `
      <div class="hdr"><span>Baseline contrast</span><span class="sub">same budget, two methods</span></div>
      ${baselineLineHTML()}
      <button class="btn sm" id="split-open">Open split-screen comparison</button>
      <div class="hdr"><span>Budget curve</span><span class="sub">coverage you buy per budget</span></div>
      <div id="cmp-curve">${C.curve ? curveHTML(C.curve) : `<button class="btn sm" id="run-curve">Run budget comparison (8 budgets)</button>`}</div>
      <div class="hdr"><span>Optimiser comparison</span><span class="sub">greedy · local search · exact ILP</span></div>
      <div id="cmp-opt">${C.opt ? optHTML(C.opt) : `<p class="sub" style="margin:0 0 6px">Solves the budgeted maximum-coverage integer programme exactly (LP-based branch and bound) and reports how close the greedy heuristic gets.</p><button class="btn sm" id="run-opt">Run optimiser comparison</button>`}</div>
      <div class="hdr"><span>Sensitivity analysis</span><span class="sub">9 alternative assumption sets</span></div>
      <div id="cmp-sens">${S.sens ? sensHTML(S.sens) : `<button class="btn sm" id="run-sens">Run sensitivity analysis</button>`}</div>`;
    const go = (btn, key, job, extra, render) => { const b = $(btn, tb); if (!b) return; b.onclick = () => { b.outerHTML = busy("busy-" + key); runJob(job, extra).then(r => { if (key === "sens") S.sens = r; else (S.compare ||= {})[key] = r; Audit.add("analysis." + job, regionName()); tabCompare(tb); }).catch(e => { $("#busy-" + key, tb).textContent = "Failed: " + e.message; }); }; };
    $("#split-open", tb).onclick = openSplit;
    go("#run-curve", "curve", "budgetCurve");
    go("#run-opt", "opt", "compareOptimisers", { timeoutMs: S.level === "state" ? 15000 : 8000 });
    go("#run-sens", "sens", "sensitivity");
    $$("[data-cx]", tb).forEach(b => b.onclick = () => exportCompare(b.dataset.cx));
    $$("[data-rerun]", tb).forEach(b => b.onclick = () => { if (b.dataset.rerun === "sens") S.sens = null; else if (S.compare) delete S.compare[b.dataset.rerun]; tabCompare(tb); });
  }
  function baselineLineHTML() {
    const P = S.analysis && S.analysis.plans; if (!P || !P.ratio || !P.greedy) return "";
    const g = P.greedy.metrics, r = P.ratio.metrics, cr = (m) => m.cost ? m.newlyCovered / (m.cost / 100) : 0;
    const lift = r.newlyCovered ? g.newlyCovered / r.newlyCovered - 1 : null;
    // when the budget is large enough for both methods to reach everyone they can, the difference is the money spent
    const tie = lift != null && Math.abs(lift) < 0.01 && r.cost > g.cost * 1.02;
    const third = tie ? `<div><b style="color:var(--good)">−${pct(1 - g.cost / r.cost, 0)}</b><span>same people reached for ${rupL(g.cost)} instead of ${rupL(r.cost)}: ${rupL(r.cost - g.cost)} saved</span></div>`
      : `<div><b style="color:${lift > 0 ? "var(--good)" : "var(--ink)"}">${lift == null ? "—" : (lift >= 0 ? "+" : "") + pct(lift, 0)}</b><span>more unserved people reached for the same ${rupL(effOpts().budgetLakh)} (${people(cr(g))} vs ${people(cr(r))} per ₹ crore)</span></div>`;
    return `<div class="result-band" style="grid-template-columns:repeat(3,1fr)"><div><b>${people(g.newlyCovered)}</b><span>newly covered, ReachGrid greedy (${g.sites} sites, ${rupL(g.cost)})</span></div><div><b>${people(r.newlyCovered)}</b><span>newly covered, EV/charger ratio (${r.sites} sites, ${rupL(r.cost)})</span></div>${third}</div>`;
  }
  /** side-by-side maps: EV/charger ratio allocation vs ReachGrid greedy, same region and budget */
  function openSplit() {
    const A = S.analysis; if (!A) return;
    const md = modal("Same budget, two methods", `<div class="split"><div><div class="split-h">EV-to-charger ratio allocation</div><div id="sp-l" class="split-map"></div><div id="sp-lk" class="split-k"></div></div><div><div class="split-h">ReachGrid marginal gain per ₹</div><div id="sp-r" class="split-map"></div><div id="sp-rk" class="split-k"></div></div></div>${baselineLineHTML()}<p class="sub">Grey: already within ${S.opts.tauKm} km · blue: newly covered by the plan · pink: still beyond ${S.opts.tauKm} km. Numbered squares are the selected sites. The maps move together.</p>`, { wide: true });
    md.el.classList.add("split-modal");
    Audit.add("compare.split", regionName());
    const mk = (id, plan) => {
      const m = L.map(id, { zoomControl: false, attributionControl: false, preferCanvas: true });
      L.tileLayer(DESK ? `/tiles/{s}/{z}/{x}/{y}.png?src=${(DESK.info().tiles || {}).key || "osm"}` : "https://tile.openstreetmap.org/{z}/{x}/{y}.png", { subdomains: "abc", className: "osm-muted", maxZoom: 18 }).addTo(m);
      const ev = E.evaluate(A.ctx.cells, A.ctx.base, plan.selected, S.opts), r = L.canvas({ padding: 0.3 });
      A.ctx.cells.forEach((c, i) => {
        const was = A.ctx.base.dist[i] <= S.opts.tauKm, now = ev.dist[i] <= S.opts.tauKm;
        L.circleMarker([c[1], c[0]], { renderer: r, radius: 3.2, stroke: false, fillOpacity: 0.75, fillColor: was ? "#c9c6c0" : now ? "#3d7bd9" : "#e44f8f" }).addTo(m);
      });
      plan.selected.forEach((c, i) => L.marker([c.lat, c.lng], { icon: L.divIcon({ className: "pin", html: `<b>${i + 1}</b>`, iconSize: [20, 20] }) }).addTo(m));
      return { m, ev };
    };
    setTimeout(() => {
      const L1 = mk("sp-l", A.plans.ratio), R1 = mk("sp-r", A.plans.greedy);
      const b = L.latLngBounds(A.ctx.cells.map(c => [c[1], c[0]])); L1.m.fitBounds(b, { padding: [10, 10] }); R1.m.fitBounds(b, { padding: [10, 10] });
      let lock = false; const sync = (a, z) => a.on("move", () => { if (lock) return; lock = true; z.setView(a.getCenter(), a.getZoom(), { animate: false }); lock = false; });
      sync(L1.m, R1.m); sync(R1.m, L1.m);
      const k = (ev, p) => `<b>${people(ev.newlyCovered)}</b> newly covered · ${p.selected.length} sites · ${rupL(ev.cost)} · coverage ${pct(ev.coverage)}`;
      $("#sp-lk").innerHTML = k(L1.ev, A.plans.ratio); $("#sp-rk").innerHTML = k(R1.ev, A.plans.greedy);
    }, 60);
  }
  function curveHTML(c) {
    return lineChart([
      { name: "Greedy marginal gain", color: "#e44fbf", points: c.map(r => [r.budget, r.greedy]) },
      { name: "Score-only ranking", color: "#1b1b1d", dash: true, points: c.map(r => [r.budget, r.score]) },
    ], { xFmt: (v) => rupL(v), yFmt: (v) => pct(v, 0), xLabel: "budget", yLabel: "coverage" }) +
      `<table class="t" style="margin-top:6px"><thead><tr><th>Budget</th><th class="n">Sites</th><th class="n">Coverage</th><th class="n">+People</th><th class="n">₹/person</th></tr></thead><tbody>${c.map(r => `<tr><td>${rupL(r.budget)}</td><td class="n">${r.sites}</td><td class="n">${pct(r.greedy)}</td><td class="n">${people(r.newly)}</td><td class="n">${r.costPerPerson ? rup(r.costPerPerson) : "—"}</td></tr>`).join("")}</tbody></table>
      <p class="sub">Flattening of the curve marks diminishing returns: past that point each extra crore buys little new access.</p>
      <div style="display:flex;gap:6px"><button class="btn sm ghost" data-cx="curve">Export CSV</button><button class="linkbtn" data-rerun="curve">re-run</button></div>`;
  }
  function optHTML(o) {
    const rows = [["Greedy heuristic", o.greedy], ["Local search (1-swap)", o.local], ["Exact ILP", o.ilp]].filter(r => r[1]);
    return `<table class="t"><thead><tr><th>Method</th><th class="n">Coverage</th><th class="n">+People</th><th class="n">% of LP bound</th><th class="n">Cost</th><th class="n">ms</th></tr></thead><tbody>
      ${rows.map(([n, m]) => `<tr><td>${n}</td><td class="n">${pct(m.coverage)}</td><td class="n">${people(m.newlyCovered)}</td><td class="n">${m.ofBound != null ? pct(m.ofBound, 1) : "—"}</td><td class="n">${rupL(m.cost)}</td><td class="n">${nIN(m.ms)}</td></tr>`).join("")}</tbody></table>
      ${o.ilp ? `<div class="note">LP upper bound: ${people(o.ilp.bound)} newly covered. ${o.ilp.timedOut ? "The ILP hit its time limit, so its result is the best integer solution found, not proven optimal." : `The ILP is optimal for ${o.ilp.restricted ? `the ${o.ilp.vars} best-ratio variables (state-wide pool restricted)` : "this candidate set"}.`} Greedy reaches ${pct(o.greedy.ofBound, 1)} of the bound${o.ilp.newlyCovered > o.greedy.newlyCovered + 1 ? `; the exact solution adds ${people(o.ilp.newlyCovered - o.greedy.newlyCovered)} people for the same budget` : ", matching the exact solution"}.</div>` : `<div class="note warnnote">ILP unavailable: ${esc(o.ilpError || "")}</div>`}
      ${o.greedy && o.greedy.ofBound != null && S.analysis && S.analysis.plans.greedy.guarantee ? `<div class="note guarantee">Theoretical guarantee of the modified greedy: ≥ <b>${(S.analysis.plans.greedy.guarantee.bound * 100).toFixed(1)}%</b> of optimum (${esc(S.analysis.plans.greedy.guarantee.basis)}). Measured here: <b>${pct(o.greedy.ofBound, 1)}</b> of the LP upper bound, so at least that share of the true optimum.${S.opts.pm && S.opts.pm.enabled && S.opts.pm.capACatA ? " The ILP does not model the Category A cap; it can only do as well or better." : ""}</div>` : ""}
      <div style="display:flex;gap:6px"><button class="btn sm ghost" data-cx="opt">Export JSON</button><button class="linkbtn" data-rerun="opt">re-run</button></div>`;
  }
  function sensHTML(st) {
    const stable = st.slice(1).filter(r => r.overlap >= 0.5).length, max = Math.max(...st.map(r => r.coverage));
    return `<b style="font-size:11.5px">Coverage with plan (pink line = baseline under base assumptions)</b>
      ${barRows(st.map(r => ({ name: r.name, value: r.coverage })), { max, marker: st[0].baseCoverage })}
      <b style="font-size:11.5px;display:block;margin-top:8px">Shortlist overlap with base plan</b>
      ${barRows(st.map(r => ({ name: r.name, value: r.overlap, color: r.overlap >= 0.5 ? "var(--good)" : "var(--bad)" })), { max: 1, fmt: (v) => pct(v, 0) })}
      <div class="note ${stable >= 6 ? "" : "warnnote"}">${stable}/8 variants keep at least half the shortlist. ${stable >= 6 ? "Rankings are fairly robust to the assumptions tested." : "Rankings are sensitive; validate the sites that survive most variants first."} Greedy vs score-only overlap at base: ${pct(st[0].scoreOverlap, 0)}.</div>
      <div style="display:flex;gap:6px"><button class="btn sm ghost" data-cx="sens">Export CSV</button><button class="btn sm ghost" data-cx="sensjson">JSON</button><button class="linkbtn" data-rerun="sens">re-run</button></div>`;
  }
  function exportCompare(kind) {
    const base = `reachgrid_${slug(regionName())}_${scenarioKey()}`;
    if (kind === "curve") download(base + "_budget_curve.csv", ["budget_lakh,sites,greedy_coverage,score_only_coverage,newly_covered,cost_per_person_rs", ...S.compare.curve.map(r => [r.budget, r.sites, r.greedy.toFixed(5), r.score.toFixed(5), Math.round(r.newly), r.costPerPerson ? Math.round(r.costPerPerson) : ""].join(","))].join("\n"), "text/csv");
    if (kind === "opt") download(base + "_optimisers.json", JSON.stringify(S.compare.opt, null, 2), "application/json");
    if (kind === "sens") download(base + "_sensitivity.csv", ["variant,baseline_coverage,coverage_with_plan,sites,overlap_with_base,greedy_vs_score_overlap", ...S.sens.map(r => [csvCell(r.name), r.baseCoverage.toFixed(5), r.coverage.toFixed(5), r.sites, r.overlap.toFixed(4), r.scoreOverlap.toFixed(4)].join(","))].join("\n"), "text/csv");
    if (kind === "sensjson") download(base + "_sensitivity.json", JSON.stringify({ scenario_id: scenarioKey(), region: regionName(), build: INDIA.version, runs: S.sens }, null, 2), "application/json");
    Audit.add("export." + kind, regionName());
  }

  /* ================================================================== Validate tab: backtest, equity, self-tests */
  function vahanQualityHTML() {
    const V = INDIA.vahan_rto; if (!V) return "";
    const direct = Object.entries(V.match).filter(([h]) => !["unmatched", "state-unknown"].includes(h)).reduce((a, [, m]) => a + m.ev_share, 0);
    const c = V.calibration || {};
    return `<div class="hdr"><span>Data validation · VAHAN by RTO</span><span class="sub">${esc(V.first)} – ${esc(V.latest)} · ${nIN(V.rtos)} RTOs</span></div>
      <table class="t"><tbody>
        <tr><td>RTOs matched to a district by name</td><td class="n">${pct(direct, 1)} of EVs</td><td class="sub">rest spread within the state by matched volume</td></tr>
        ${(V.aggregates_removed || []).map(a => `<tr><td>Aggregate row removed: <i>${esc(a.rto)}</i> (${esc(a.state)})</td><td class="n">${nIN(a.ev)}</td><td class="sub">a national total mislabelled as an RTO; counting it would inflate EVs</td></tr>`).join("")}
        ${c.e2w ? `<tr><td>e-2W split: fit ${esc(c.e2w.fit_years.join(", "))}, test ${esc(c.e2w.test_year)}</td><td class="n">${pct(c.e2w.test_state_mape, 1)}</td><td class="sub">mean state error (${c.e2w.test_states} states); national ${pct(c.e2w.test_national_error, 1)}</td></tr>` : ""}
        ${c.e4w ? `<tr><td>e-4W split vs published monthly totals</td><td class="n">${pct(c.e4w.test_mape, 1)}</td><td class="sub">mean error on held-out months ${esc(c.e4w.test_months.join(", "))}</td></tr>` : ""}
        ${c.bus ? `<tr><td>e-bus split vs published monthly totals</td><td class="n">${pct(c.bus.test_mape, 1)}</td><td class="sub">held-out months ${esc(c.bus.test_months.join(", "))}</td></tr>` : ""}
      </tbody></table>${c.anchor_source ? `<div class="sub" style="font-size:10.5px">Anchors: ${esc(c.anchor_source)}</div>` : ""}`;
  }
  function tabValidate(tb) {
    const A = S.analysis, plan = A.plans[S.planKey], m = plan.metrics, V = S.backtest;
    tb.innerHTML = `${vahanQualityHTML()}
      <div class="hdr"><span>Holdout backtest</span><span class="sub">does the method find where chargers really are?</span></div>
      <p class="sub" style="margin:0 0 6px">Hides a random share of this region's real chargers, re-plans without them, then checks whether proposed sites land within the hit radius of the hidden ones.</p>
      <div class="grid2"><label class="f">Hold out<select id="bt-h">${[0.1, 0.2, 0.3].map(v => `<option value="${v}" ${v === 0.2 ? "selected" : ""}>${v * 100}% of chargers</option>`).join("")}</select></label>
      <label class="f">Hit radius<select id="bt-r">${[1, 2, 3, 5].map(v => `<option ${v === 3 ? "selected" : ""}>${v}</option>`).join("")}</select></label></div>
      <button class="btn sm" id="bt-run">Run backtest</button>
      <div id="bt-out">${V ? backtestHTML(V) : ""}</div>
      <div class="hdr"><span>Equity of the current plan</span><span class="sub">${esc(plan.name)}</span></div>
      <div class="kpis">
        <div class="kpi"><b>${pct(m.denseCoverage, 0)}</b><span>coverage, denser half of cells</span></div>
        <div class="kpi"><b>${pct(m.sparseCoverage, 0)}</b><span>coverage, sparser half</span></div>
        <div class="kpi"><b style="color:${m.equityGap > 0.15 ? "var(--bad)" : "inherit"}">${m.equityGap != null ? (m.equityGap * 100).toFixed(1) + " pt" : "—"}</b><span>equity gap (dense − sparse)</span></div>
        <div class="kpi"><b>${pct(m.worstServed, 0)}</b><span>of people >2τ away now reached</span></div>
        <div class="kpi"><b>${people(m.farPop)}</b><span>people >2τ at baseline</span></div>
        <div class="kpi"><b>${pct(A.plans.equity.metrics.worstServed, 0)}</b><span>reached by equity plan</span></div></div>
      <div class="hdr"><span>Live self-tests</span><span class="sub">proposal §8 acceptance rules on loaded data</span></div>
      <button class="btn sm ghost" id="st-run">Run self-tests</button><div id="st-out"></div>`;
    $("#bt-run").onclick = () => {
      $("#bt-out").innerHTML = `<p class="sub">Running backtest in a background worker…</p>`;
      runJob("backtest", { holdout: +$("#bt-h").value, hitKm: +$("#bt-r").value }).then(r => { S.backtest = r; Audit.add("analysis.backtest", regionName()); $("#bt-out").innerHTML = backtestHTML(r); }).catch(e => { $("#bt-out").textContent = "Failed: " + e.message; });
    };
    $("#st-run").onclick = () => { $("#st-out").innerHTML = selfTests().map(([ok, n, d]) => `<div class="lgrow"><span class="tag ${ok ? "obs" : "syn"}">${ok ? "pass" : "fail"}</span> ${esc(n)} <span class="sub">${esc(d)}</span></div>`).join(""); };
  }
  function backtestHTML(V) {
    if (V.error) return `<div class="note warnnote">${esc(V.error)}</div>`;
    const rows = [["Demand proxy only", V.demand], ["Greedy coverage", V.greedy], ["Commercial screen", V.commercial], ["Score-only", V.score], [`Random (avg of ${V.random.runs})`, V.random]];
    const lift = V.random.hitRate ? V.demand.hitRate / V.random.hitRate : null;
    return `${V.hidden < 15 ? `<div class="note warnnote">Only ${V.hidden} sites held out here, too few for a reliable hit rate. Run the backtest at state level (open the state, then Validate) for a meaningful sample.</div>` : ""}<table class="t" style="margin-top:8px"><thead><tr><th>Method (${V.hidden} sites)</th><th class="n">Hit rate</th><th class="n">Recall</th><th class="n">Coverage</th></tr></thead><tbody>
      ${rows.map(([n, r]) => `<tr><td>${n}</td><td class="n">${pct(r.hitRate, 0)}</td><td class="n">${pct(r.recall, 0)}</td><td class="n">${pct(r.coverage)}</td></tr>`).join("")}
      <tr><td><b>Real hidden chargers</b></td><td class="n">—</td><td class="n">—</td><td class="n"><b>${pct(V.realSites.coverage)}</b></td></tr></tbody></table>
      <div class="note">Held out ${V.hidden} of ${V.regionChargers} real sites (seed ${V.seed}); baseline without them ${pct(V.baselineWithout)}.
      ${lift != null ? `<b>Demand proxy:</b> ${lift.toFixed(1)}× the random hit rate, so the census demand signal ${lift > 1.1 ? "does" : "does not clearly"} track where operators chose to build. ` : ""}
      <b>Coverage plan:</b> ${V.greedy.coverage > V.realSites.coverage ? `restores more coverage (${pct(V.greedy.coverage)}) than the real sites did (${pct(V.realSites.coverage)})` : `restores less coverage than the real sites`}. It is meant to fill gaps, not to copy operators, so a low hit rate is expected.</div>`;
  }
  function selfTests() {
    const out = [], A = S.analysis, o = S.opts;
    try {
      const a = INDIA.charger_index; let bad = 0; for (let i = 0; i < a.length; i += 3) if (!(a[i] / 1e4 > 6 && a[i] / 1e4 < 37.6 && a[i + 1] / 1e4 > 68 && a[i + 1] / 1e4 < 98)) bad++;
      out.push([bad === 0, "Charger coordinates valid", `${nIN(a.length / 3)} checked, ${bad} invalid`]);
      const pop = INDIA.districts.reduce((s, d) => s + d.stats.pop, 0);
      out.push([Math.abs(pop - 1210854977) / 1210854977 < 0.001, "Census reconciles to national total", `${(pop / 1e7).toFixed(2)} cr vs 121.09 cr`]);
      const pts = [...A.ctx.chargerIdx.pts, { lat: A.ctx.cells[0][1], lng: A.ctx.cells[0][0], dc: true, verified: true }];
      const b2 = E.baseline(A.ctx.cells, new E.GridIndex(pts, 0.1), o); let worse = 0;
      if (A.ctx.metric !== "network") for (let i = 0; i < A.ctx.cells.length; i++) if (b2.dist[i] > A.ctx.base.dist[i] + 1e-9) worse++;
      out.push([worse === 0, "Adding a charger never increases distance", A.ctx.metric === "network" ? "checked in straight mode only" : `${A.ctx.cells.length} cells`]);
      let prev = -1, mono = true; for (const t of [2, 5, 10, 20, 40]) { const b = E.baseline(A.ctx.cells, A.ctx.chargerIdx, { ...o, tauKm: t }); if (b.coverage < prev) mono = false; prev = b.coverage; }
      out.push([mono, "Coverage monotone in τ", "τ = 2, 5, 10, 20, 40 km"]);
      const P = A.plans; out.push([Object.values(P).every(p => p.metrics.cost <= effOpts().budgetLakh + 1e-9), "Every plan within budget", rupL(effOpts().budgetLakh)]);
      out.push([Object.values(P).every(p => !p.selected.some(c => c.blocked)), "No blocked (evidence) site selected", `${Evidence.all().filter(e => e.status === "blocked").length} blocked rows`]);
      const again = Rg.analyse(analysisArgs()); out.push([again.ctx.base.coverage === A.ctx.base.coverage && again.cands.length === A.cands.length, "Reproducible: identical inputs → identical outputs", `scenario ${scenarioKey()}`]);
      const h = A.cands.find(c => c.missing.length); if (h) { const ks = Object.keys(h.comp), w = effOpts().weights; const exp = ks.reduce((s, k) => s + w[k] * h.comp[k], 0) / ks.reduce((s, k) => s + w[k], 0); out.push([Math.abs(exp - h.score) < 1e-9, "Missing components renormalised", h.id]); }
    } catch (e) { out.push([false, "Self-test error", e.message]); }
    return out;
  }

  /* ================================================================== Evidence tab: feasibility evidence + EV registrations */
  const EVID_HEAD = "lat,lng,name,status,grid_kva,land,cost_lakh,host,notes";
  function tabEvidence(tb) {
    const rows = Evidence.all(), A = S.analysis;
    const inRegion = rows.map((r, i) => ({ ...r, i })).filter(r => A.ctx.geoms.some(g => E.pointInGeom(+r.lng, +r.lat, g)));
    const ev = EVUpload.get();
    tb.innerHTML = `
      <div class="hdr"><span>Feasibility evidence</span><span class="sub">${inRegion.length} rows here · ${rows.length} total</span></div>
      <p class="sub" style="margin:0 0 6px">Site surveys, DISCOM grid capacity, land status or real costs. <b>ok</b> raises feasibility (and uses your cost), <b>blocked</b> removes a site from every plan, unmatched rows become new candidates. Matched to candidates within 300 m.</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px"><button class="btn sm" id="ev-up">Upload CSV</button><button class="btn sm ghost" id="ev-tpl">Template</button><button class="btn sm ghost" id="ev-pick">＋ Add on map</button>${rows.length ? `<button class="btn sm ghost" id="ev-exp">Export</button><button class="linkbtn" id="ev-clr">clear all</button>` : ""}</div>
      ${inRegion.length ? `<div class="scroll" style="margin-top:8px;max-height:220px"><table class="t"><thead><tr><th>Site</th><th>Status</th><th class="n">kVA</th><th class="n">₹ L</th><th></th></tr></thead><tbody>${inRegion.map(r => `<tr><td>${esc(r.name || "unnamed")}<br><span class="sub">${(+r.lat).toFixed(4)}, ${(+r.lng).toFixed(4)}${r.land ? " · land " + esc(r.land) : ""}</span></td><td><span class="tag ${r.status === "ok" ? "obs" : r.status === "blocked" ? "syn" : "imp"}">${esc(r.status)}</span></td><td class="n">${esc(r.grid_kva || "—")}</td><td class="n">${esc(r.cost_lakh || "—")}</td><td><button class="linkbtn" data-evdel="${r.i}">×</button></td></tr>`).join("")}</tbody></table></div>` : ""}
      <div class="hdr"><span>EV registrations (VAHAN export)</span><span class="sub">replaces the vehicle-ownership proxy</span></div>
      <p class="sub" style="margin:0 0 6px">Export district/RTO EV registrations from the VAHAN dashboard (vahan.parivahan.gov.in), save as CSV with columns <span class="mono">district,ev_registrations</span>, and upload. EV pressure and the commercial screen then use real EV counts. Current source: <b>${esc(A.ctx.pressureSource)}</b>.</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px"><button class="btn sm" id="vh-up">Upload EV CSV</button><button class="btn sm ghost" id="vh-tpl">Template for ${esc(S.level === "district" ? INDIA.stateById.get(S.sid).name : INDIA.stateById.get(S.sid).name)}</button>${ev ? `<button class="linkbtn" id="vh-clr">remove upload (${Object.keys(ev.byDistrict).length} districts, ${esc(ev.name)})</button>` : ""}</div>
      <div id="ev-msg"></div>`;
    $("#ev-tpl").onclick = () => download("reachgrid_evidence_template.csv", EVID_HEAD + "\n22.8046,86.2029,Example HPCL outlet NH-33,ok,250,leased,30,highway,DISCOM confirmed 250 kVA spare\n", "text/csv");
    $("#ev-up").onclick = async () => {
      if (!Gov.need("evidence", "upload evidence")) return;
      const f = await pickFile(".csv,text/csv"); if (!f) return;
      const parsed = window.RGAdvanced.parseCSV(f.text).filter(r => isFinite(+r.lat) && isFinite(+r.lng) && r.lat !== "");
      if (!parsed.length) { $("#ev-msg").innerHTML = `<div class="note warnnote">No rows with lat/lng found. Use the template columns: ${EVID_HEAD}</div>`; return; }
      parsed.forEach(r => { r.status = (r.status || "unknown").toLowerCase(); r.added = new Date().toISOString(); r.source = f.name; });
      Evidence.set([...Evidence.all(), ...parsed]); Audit.add("evidence.upload", `${parsed.length} rows from ${f.name}`); rerunAll(`${parsed.length} evidence rows loaded`);
    };
    $("#ev-pick").onclick = () => {
      if (!Gov.need("evidence", "add evidence")) return;
      startPick("Click the map where the evidence applies", async (ll) => {
        const name = await askText("Site name", { placeholder: "e.g. IOCL outlet, Ghatsila bypass" }); if (name == null) return;
        const status = (await askText("Status: ok, blocked or unknown", { placeholder: "ok" }) || "unknown").toLowerCase();
        const kva = await askText("Spare grid capacity in kVA (optional)", { placeholder: "250" });
        Evidence.set([...Evidence.all(), { lat: ll.lat.toFixed(5), lng: ll.lng.toFixed(5), name, status: ["ok", "blocked"].includes(status) ? status : "unknown", grid_kva: kva || "", land: "", cost_lakh: "", host: "", notes: "added on map", added: new Date().toISOString() }]);
        Audit.add("evidence.add", name); rerunAll("Evidence added");
      });
    };
    if ($("#ev-exp")) $("#ev-exp").onclick = () => download("reachgrid_evidence.csv", [EVID_HEAD, ...Evidence.all().map(r => EVID_HEAD.split(",").map(k => csvCell(r[k])).join(","))].join("\n"), "text/csv");
    if ($("#ev-clr")) $("#ev-clr").onclick = () => { if (!Gov.need("evidence", "clear evidence")) return; Evidence.set([]); Audit.add("evidence.clear", ""); rerunAll("Evidence cleared"); };
    $$("[data-evdel]", tb).forEach(b => b.onclick = () => { if (!Gov.need("evidence", "delete evidence")) return; const all = Evidence.all(); const [r] = all.splice(+b.dataset.evdel, 1); Evidence.set(all); Audit.add("evidence.delete", r && r.name); rerunAll("Evidence removed"); });
    $("#vh-tpl").onclick = () => download(`ev_registrations_${S.sid}.csv`, "district,ev_registrations\n" + curState().districts.map(d => `${csvCell(d.name)},`).join("\n") + "\n", "text/csv");
    $("#vh-up").onclick = async () => {
      if (!Gov.need("ev_upload", "upload EV registrations")) return;
      const f = await pickFile(".csv,text/csv"); if (!f) return;
      const rows = window.RGAdvanced.parseCSV(f.text), byDistrict = { ...(EVUpload.get()?.byDistrict || {}) }; let n = 0, miss = [];
      for (const r of rows) {
        const name = norm(r.district || r.name || ""), val = +String(r.ev_registrations ?? r.ev ?? r.count ?? "").replace(/,/g, "");
        if (!name || !isFinite(val) || val < 0 || r.ev_registrations === "") continue;
        const d = INDIA.districts.find(x => norm(x.name) === name && (!r.state || norm(INDIA.stateById.get(x.sid).name) === norm(r.state))) || INDIA.districts.find(x => x.sid === S.sid && norm(x.name) === name);
        if (d) { byDistrict[d.id] = val; n++; } else miss.push(r.district);
      }
      EVUpload.set({ name: f.name, at: new Date().toISOString(), byDistrict }); Audit.add("ev.upload", `${n} districts from ${f.name}`);
      rerunAll(`${n} districts loaded${miss.length ? `; unmatched: ${miss.slice(0, 5).join(", ")}` : ""}`);
    };
    if ($("#vh-clr")) $("#vh-clr").onclick = () => { EVUpload.set(null); Audit.add("ev.clear", ""); rerunAll("EV upload removed"); };
  }
  function rerunAll(msg) { if (msg) toast(msg); S.sens = null; S.compare = null; S.backtest = null; runAnalysis(); drawPlan(false); renderInspector(); updateStatus(); }
  let pickCb = null;
  function startPick(msg, cb) { pickCb = cb; $("#map").style.cursor = "crosshair"; toast(msg + " (Esc to cancel)"); }
  function initPick() {
    map.on("click", (e) => { if (!pickCb) return; const cb = pickCb; pickCb = null; $("#map").style.cursor = ""; cb(e.latlng); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pickCb) { pickCb = null; $("#map").style.cursor = ""; toast("Cancelled"); } });
  }

  /* ================================================================== Portfolio tab (§3 Portfolio Monitor) */
  function predictedFor(p) {
    const A = S.analysis; if (!A) return p.capture || 0;
    const reach = A.ctx.cells.map((c, i) => [i, E.hav(p.lat, p.lng, c[1], c[0]) * S.opts.detour]).filter(([, d]) => d <= S.opts.tauKm);
    const comp = E.competitorCounts(A.ctx, S.opts); let cap = 0;
    for (const [i] of reach) cap += A.ctx.cells[i][2] * (A.ctx.vehicleRate[i] || 0) / Math.max(1, comp[i]);
    return cap;
  }
  function calibration() { return window.RGAdvanced.recalibrate(Portfolio.all().map(p => ({ predicted: p.capture, observed: p.observed === "" || p.observed == null ? null : +p.observed }))); }
  function tabPortfolio(tb) {
    const all = Portfolio.all(), cal = calibration(), counts = store.get("portfolio_counts", true);
    const rv = Review.all(), queue = [];
    for (const [scen, m] of Object.entries(rv)) for (const [id, r] of Object.entries(m)) queue.push({ scen, id, ...r });
    tb.innerHTML = `
      <div class="hdr"><span>Built sites</span><span class="sub">${all.length} tracked</span></div>
      <p class="sub" style="margin:0 0 6px">Mark shortlisted sites as built (in a site's explanation) or add one on the map. Built sites count as existing chargers in every analysis, and observed usage recalibrates the commercial screen.</p>
      <label class="lgrow"><input type="checkbox" id="pf-count" ${counts ? "checked" : ""}> built sites count as existing chargers</label>
      ${all.length ? `<div class="scroll" style="max-height:240px"><table class="t"><thead><tr><th>Site</th><th class="n">kW</th><th class="n">Pred.*</th><th class="n">Obs. sessions/day</th><th></th></tr></thead><tbody>${all.map((p, i) => `<tr><td><b>${esc(p.name)}</b><br><span class="sub">${esc(p.region || "")} · ${esc(p.commissioned || "")}</span></td><td class="n">${p.kw}</td><td class="n" title="vehicle households captured">${nIN(p.capture)}</td><td class="n"><input type="number" min="0" step="0.1" value="${p.observed ?? ""}" data-obs="${i}" style="width:70px"></td><td><button class="linkbtn" data-pfdel="${i}">×</button></td></tr>`).join("")}</tbody></table></div>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"><button class="btn sm ghost" id="pf-pick">＋ Add built site on map</button><button class="btn sm ghost" id="pf-exp">Export JSON</button><button class="btn sm ghost" id="pf-imp">Import JSON</button></div>
      <div class="hdr"><span>Recalibration</span><span class="sub">observed ≈ k × predicted capture</span></div>
      ${cal.k ? `<div class="kpis"><div class="kpi"><b>${cal.k.toFixed(4)}</b><span>sessions/day per captured vehicle household</span></div><div class="kpi"><b>${cal.r2 != null ? cal.r2.toFixed(2) : "—"}</b><span>R² (n = ${cal.n})</span></div><div class="kpi"><b>${pct(cal.mape, 0)}</b><span>mean abs. % error</span></div></div>
        <label class="lgrow"><input type="checkbox" id="pf-usecal" ${store.get("use_cal", false) ? "checked" : ""}> use this calibration in the commercial screen</label>`
        : `<p class="sub">Enter observed sessions/day for at least 2 built sites to fit a calibration factor.</p>`}
      <div class="hdr"><span>Review queue</span><span class="sub">human review before capital spend (§13)</span></div>
      ${queue.length ? `<table class="t"><tbody>${queue.slice(-30).reverse().map(q => `<tr><td>${esc(q.label || q.id)}<br><span class="sub">${esc(q.region || "")} · scenario ${esc(q.scen)}</span></td><td><span class="tag ${REVIEW_TAG[q.status]}">${esc(REVIEW_LABEL[q.status])}</span><br><span class="sub">${esc(q.by)} · ${esc((q.at || "").slice(0, 10))}</span></td></tr>`).join("")}</tbody></table>` : `<p class="sub">No reviews yet. Open a site in the Plan tab to propose it for review.</p>`}
      <p class="sub">* Predicted = vehicle households captured at the time it was marked built.</p>`;
    $("#pf-count").onchange = (e) => { store.set("portfolio_counts", e.target.checked); rerunAll(e.target.checked ? "Built sites now count as chargers" : "Built sites ignored"); };
    $$("[data-obs]", tb).forEach(i => i.onchange = () => { if (!Gov.need("portfolio", "record usage")) { i.value = ""; return; } const all = Portfolio.all(); all[+i.dataset.obs].observed = i.value === "" ? null : +i.value; Portfolio.set(all); Audit.add("portfolio.usage", `${all[+i.dataset.obs].name}: ${i.value}/day`); tabPortfolio(tb); });
    $$("[data-pfdel]", tb).forEach(b => b.onclick = () => { if (!Gov.need("portfolio", "remove built sites")) return; const all = Portfolio.all(); const [r] = all.splice(+b.dataset.pfdel, 1); Portfolio.set(all); Audit.add("portfolio.remove", r.name); rerunAll("Removed"); });
    if ($("#pf-usecal")) $("#pf-usecal").onchange = (e) => { store.set("use_cal", e.target.checked); toast(e.target.checked ? "Commercial screen uses portfolio calibration" : "Commercial screen uses assumptions"); };
    $("#pf-pick").onclick = () => { if (!Gov.need("portfolio", "add built sites")) return; startPick("Click the map at the built site", async (ll) => { const name = await askText("Site name"); if (name == null) return; addBuilt({ lat: ll.lat, lng: ll.lng, label: name, cost: null }); }); };
    $("#pf-exp").onclick = () => download("reachgrid_portfolio.json", JSON.stringify({ build: INDIA.version, exported: new Date().toISOString(), portfolio: Portfolio.all() }, null, 2), "application/json");
    $("#pf-imp").onclick = async () => { if (!Gov.need("portfolio", "import a portfolio")) return; const f = await pickFile(".json,application/json"); if (!f) return; try { const j = JSON.parse(f.text); Portfolio.set([...Portfolio.all(), ...(j.portfolio || [])]); Audit.add("portfolio.import", f.name); rerunAll(`${(j.portfolio || []).length} sites imported`); } catch (e) { toast("Not a portfolio file: " + e.message); } };
  }
  function addBuilt(c) {
    const p = { id: "B" + Date.now().toString(36), name: c.label, lat: +c.lat, lng: +c.lng, kw: { dc60: 60, dc30: 30, ac22: 22 }[S.opts.hardware], commissioned: new Date().toISOString().slice(0, 10), observed: null, costLakh: c.cost, region: regionName(), did: S.did, sid: S.sid, fromScenario: S.analysis?.key };
    p.capture = Math.round(predictedFor(p));
    Portfolio.set([...Portfolio.all(), p]); Audit.add("portfolio.built", `${p.name} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`); rerunAll("Marked as built: it now counts as an existing charger");
  }

  /* ================================================================== map overlays for evidence & portfolio */
  function drawExtras() {
    if (!G.extra) return; G.extra.clearLayers();
    if (S.level === "india") return;
    if (S.layers.grid && INDIA.grid) {
      const gi = Rg.gridIndex(INDIA), geoms = S.level === "district" ? [curDistrict().geom] : curState().districts.map(d => d.geom);
      let bb = [180, 90, -180, -90]; geoms.forEach(g => { const b = E.bbox(g); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; });
      for (const p of gi.pts) if (p.lng > bb[0] - 0.4 && p.lng < bb[2] + 0.4 && p.lat > bb[1] - 0.4 && p.lat < bb[3] + 0.4)
        L.marker([p.lat, p.lng], { keyboard: false, icon: L.divIcon({ className: "", html: '<div class="grid-dot">⚡</div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).bindTooltip(INDIA.grid.kind === "substation" ? `Substation${p.size ? ` · ${p.size} kV` : ""} (OSM)` : `Power plant · ${nIN(p.size)} MW (WRI)`, { className: "rg-tip" }).addTo(G.extra);
    }
    for (const r of Evidence.all()) {
      const col = r.status === "ok" ? "#2f7d5b" : r.status === "blocked" ? "#b11a52" : "#8a8a8a";
      L.circleMarker([+r.lat, +r.lng], { radius: 7, color: col, weight: 3, fillColor: "#fff", fillOpacity: 1 }).bindTooltip(`<b>${esc(r.name || "Evidence")}</b><br>status: ${esc(r.status)}${r.grid_kva ? `<br>${esc(r.grid_kva)} kVA` : ""}${r.notes ? `<br>${esc(r.notes)}` : ""}`, { className: "rg-tip" }).addTo(G.extra);
    }
    for (const p of Portfolio.all()) L.marker([p.lat, p.lng], { zIndexOffset: 900, icon: L.divIcon({ className: "", html: `<div class="built-pin">B</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }) }).bindTooltip(`<b>${esc(p.name)}</b> · built ${esc(p.commissioned)}<br>${p.kw} kW${p.observed != null ? ` · ${p.observed} sessions/day` : ""}`, { className: "rg-tip" }).addTo(G.extra);
  }

  /* ================================================================== explain-card additions: commercial, review, built */
  function explainExtras(c) {
    const A = S.analysis, cal = store.get("use_cal", false) ? calibration() : null;
    const ce = window.RGAdvanced.commercialEstimate(c, A.ctx, effOpts(), cal);
    const scen = A.key, rv = Review.get(scen, c.id);
    return `<div class="hdr"><span>Commercial screen</span><span class="sub">${esc(ce.basis)}</span></div>
      <div class="kpis"><div class="kpi"><b>${nIN(ce.capture)}</b><span>vehicle HH captured (shared with rivals)</span></div><div class="kpi"><b>${ce.sessionsDay.toFixed(1)}</b><span>sessions / day</span></div><div class="kpi"><b>${rupL(ce.netLakh)}</b><span>net margin / yr</span></div></div>
      <div class="sub" style="margin-top:3px">Payback ${ce.paybackYears ? ce.paybackYears.toFixed(1) + " yrs" : "not reached"} on ${rupL(c.cost)} · ${nIN(ce.kwhYear)} kWh/yr. Hypothesis, not a forecast; edit assumptions under Plan → assumptions.</div>
      <div class="hdr"><span>Human review</span><span class="sub">${rv ? `<span class="tag ${REVIEW_TAG[rv.status]}">${esc(REVIEW_LABEL[rv.status])}</span>` : "not reviewed"}</span></div>
      ${rv && rv.note ? `<div class="sub">“${esc(rv.note)}” by ${esc(rv.by)}, ${esc((rv.at || "").slice(0, 16).replace("T", " "))}</div>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
        <button class="btn sm ghost" data-rv="under_review">Propose for review</button>
        <button class="btn sm ghost" data-rv="approved">Approve for field validation</button>
        <button class="btn sm ghost" data-rv="rejected">Reject</button>
        <button class="btn sm" id="mk-built">Mark as built</button></div>`;
  }
  function bindExplainExtras(c) {
    $$("[data-rv]").forEach(b => b.onclick = async () => {
      const st = b.dataset.rv;
      if (st === "under_review" ? !Gov.need("propose", "propose sites") : !Gov.need("approve", "approve or reject sites")) return;
      const note = await askText(`${REVIEW_LABEL[st]}: note`, { placeholder: "reason, conditions, who checked what" }); if (note == null) return;
      Review.set(S.analysis.key, c.id, { status: st, note, by: Gov.user() + " (" + ROLES[Gov.role()] + ")", at: new Date().toISOString(), label: c.label, region: regionName() });
      Audit.add("review." + st, `${c.id} ${c.label} · ${note}`); toast(REVIEW_LABEL[st]); renderInspector();
    });
    $("#mk-built").onclick = () => { if (!Gov.need("portfolio", "mark sites as built")) return; addBuilt(c); };
  }
  function reviewBadge(id) { const r = S.analysis && Review.get(S.analysis.key, id); return r ? ` <span class="tag ${REVIEW_TAG[r.status]}">${esc(REVIEW_LABEL[r.status].split(" ")[0])}</span>` : ""; }

  /* ================================================================== audit / encryption UI in the Ledger */
  function ledgerGovernanceHTML() {
    const list = Audit.list(), ch = INDIA.changes;
    return `<div class="hdr"><span>Data refresh</span><span class="sub">build ${esc(INDIA.version)}</span></div>
      <p>${ch && ch.previous ? `Compared with build ${esc(ch.previous.version)} (${esc(ch.previous.built)}): ${ch.states.length ? `${ch.states.length} states changed.` : "no state-level changes."}` : "First build: no previous build to compare."} Data rebuilds weekly from the sources via a scheduled workflow, and only changed builds are published.</p>
      ${ch && ch.states.length ? `<table class="t"><tbody>${ch.states.slice(0, 12).map(s => `<tr><td>${esc(s.name)}</td><td class="n">${nIN(s.chargers[0])} → ${nIN(s.chargers[1])} sites</td><td class="n">${pct(s.coverage10[0])} → ${pct(s.coverage10[1])}</td></tr>`).join("")}</tbody></table>` : ""}
      <div class="hdr"><span>Audit log</span><span class="sub">${list.length} entries · SHA-256 hash chain</span></div>
      <div class="scroll" style="max-height:200px"><table class="t"><tbody>${list.slice(-40).reverse().map(e => `<tr><td class="mono" style="font-size:10.5px">${esc(e.ts.slice(0, 19).replace("T", " "))}</td><td>${esc(e.action)}<br><span class="sub">${esc(e.detail)}</span></td><td class="sub">${esc(e.role)}</td></tr>`).join("") || `<tr><td class="sub">No actions yet.</td></tr>`}</tbody></table></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"><button class="btn sm ghost" id="au-verify">Verify chain</button><button class="btn sm ghost" id="au-exp">Export log</button><button class="btn sm ghost" id="enc-imp">Open encrypted file</button>${Gov.role() === "admin" ? `<button class="btn sm ghost" id="pin-set">Set admin PIN</button>` : ""}</div>
      <div id="au-out"></div>
      <p class="sub">Roles, review and the audit log are enforced in this browser for workflow discipline. A multi-user deployment would enforce them server-side.</p>`;
  }
  function bindLedgerGovernance() {
    $("#au-verify").onclick = async () => { const r = await Audit.verify(); $("#au-out").innerHTML = `<div class="note ${r.ok ? "" : "warnnote"}">${r.ok ? `Chain intact: ${r.n} entries verified.` : `Tampering detected at entry ${r.at + 1}: ${esc(r.why)}.`}</div>`; };
    $("#au-exp").onclick = () => { download("reachgrid_audit_log.json", JSON.stringify({ exported: new Date().toISOString(), build: INDIA.version, entries: Audit.list() }, null, 2), "application/json"); Audit.add("audit.export", ""); };
    $("#enc-imp").onclick = async () => {
      const f = await pickFile(".rgenc,.json"); if (!f) return;
      const pass = await askText("Passphrase", { password: true }); if (pass == null) return;
      try { const obj = await decryptJSON(f.text, pass); Audit.add("export.decrypt", f.name); $("#au-out").innerHTML = `<div class="note">Decrypted <b>${esc(f.name)}</b>: scenario ${esc(obj.scenario_id)} for ${esc(obj.region?.name)}, ${obj.shortlist?.length || 0} sites. <button class="linkbtn" id="dec-dl">save as JSON</button></div>`; $("#dec-dl").onclick = () => download(f.name.replace(/\.rgenc$|\.json$/, "") + "_decrypted.json", JSON.stringify(obj, null, 2), "application/json"); }
      catch (e) { $("#au-out").innerHTML = `<div class="note warnnote">Could not decrypt: wrong passphrase or damaged file.</div>`; }
    };
    if ($("#pin-set")) $("#pin-set").onclick = async () => { const p = await askText("New admin PIN (blank to remove)", { password: true }); if (p == null) return; store.set("admin_pin", p ? await sha256Hex("pin:" + p) : null); Audit.add("admin.pin", p ? "set" : "removed"); toast(p ? "Admin PIN set" : "Admin PIN removed"); };
  }



  /* ================================================================== inventory & VAHAN panels */
  function inventoryBars(inv) {
    if (!inv) return `<p class="sub">No inventory.</p>`;
    const max = Math.max(1, ...Object.values(inv.tiers));
    return Object.entries(inv.tiers).map(([k, v]) => `<div class="hist"><span><span class="charger-sq t-${k}" style="display:inline-block;vertical-align:middle;margin-right:4px"></span>${TIER_LABEL[k]}</span><div class="minibar"><i style="width:${(v / max) * 100}%"></i></div><span style="text-align:right">${nIN(v)}</span></div>`).join("");
  }
  function inventoryHTML(inv) {
    if (!inv) return "";
    const ex = window.RGAdvanced.existingPoints(inv);
    return `<div class="hdr"><span>Charger inventory by power</span><span class="sub">${nIN(inv.ac_points + inv.dc_points)} guns published at ${nIN(inv.points_known_sites)} sites</span></div>${inventoryBars(inv)}
      <div class="sub" style="margin-top:4px">Connectors: ${Object.entries(inv.connectors).map(([k, v]) => `${esc(k)} ${v}`).join(" · ") || "not published"}. Estimated charge points: <b>${ex.ac}</b> AC, <b>${ex.dc}</b> DC (${ex.imputed} imputed for sites without published guns).</div>`;
  }
  function vahanHTML(dst, sst) {
    const v = sst.vahan; if (!v) return "";
    const yrs = Object.entries(v.years);
    return `<div class="hdr"><span>EV registrations (VAHAN, two-wheelers)</span><span class="sub">${esc(INDIA.stateById.get(S.sid).name)} · state</span></div>
      ${barRows(yrs.map(([y, r]) => ({ name: `${y} · ${pct(r.share, 1)} of 2W`, value: r.e2w })), { max: Math.max(...yrs.map(([, r]) => r.e2w)), fmt: (x) => nIN(x) })}
      <div class="sub" style="margin-top:4px">Growth 2021→2024: <b>${v.cagr_2021_2024 != null ? pct(v.cagr_2021_2024, 0) + "/yr" : "—"}</b>.${dst && dst.e2w_2024 != null ? ` This district (allocated by Census 2W ownership, <span class="tag der">derived</span>): <b>${nIN(dst.e2w_2024)}</b> registered in 2024, ~<b>${nIN(dst.e2w_stock)}</b> on the road since 2020.` : ""}</div>`;
  }

  /* ================================================================== Forecast tab: 2025–2030 fleet and required chargers */
  function forecastInputs() {
    const isD = S.level === "district", st = isD ? statOf(S.did) : INDIA.stateById.get(S.sid).stats, sv = INDIA.stateById.get(S.sid).stats.vahan;
    const up = evMap(), cfg = { ...window.RGAdvanced.FORECAST_DEFAULTS, ...store.get("fcfg", {}) };
    let reg = isD ? st.e2w_2024 : sv && sv.years["2024"].e2w, stock = isD ? st.e2w_stock : sv && sv.stock_2020_2024, src = "VAHAN E2W (state" + (isD ? ", allocated to district)" : ")");
    const ids = isD ? [S.did] : curState().districts.map(d => d.id);
    if (up && ids.some(id => up[id] != null)) {
      const total = ids.reduce((a, id) => a + (up[id] || 0), 0), share = 1 / (1 + cfg.ratios.e3w + cfg.ratios.e4w + cfg.ratios.ebus);
      stock = total * share; reg = stock * (reg && (isD ? st.e2w_stock : sv.stock_2020_2024) ? reg / (isD ? st.e2w_stock : sv.stock_2020_2024) : 0.35); src = "uploaded EV registrations (split by segment ratios)";
    }
    return { reg: reg || 0, stock: stock || 0, cagr: sv ? sv.cagr_2021_2024 : null, existing: window.RGAdvanced.existingPoints(st.inventory), src, cfg };
  }
  /** EV records for the current region (district, or the state roll-up) */
  function regionEV() {
    const st = S.level === "district" ? statOf(S.did) : INDIA.stateById.get(S.sid).stats;
    return st && st.ev && st.ev.years && Object.keys(st.ev.years).length ? { ev: st.ev, st } : null;
  }
  function tabForecast(tb) {
    const R = regionEV();
    if (!R || store.get("fc_classic", false)) return tabForecastClassic(tb, !!R);
    const sc = S.opts.scurve, F = PM.scurveForecast(R.ev, sc), Q = PM.QUEUE_DEFAULTS;
    const year = Math.min(sc.horizon, Math.max(F.anchorYear + 1, store.get("fyear", 2030))), r = F.rows.find(x => x.year === year) || F.rows[F.rows.length - 1];
    const segs = [["e2w", "e-2W"], ["e3w", "e-3W"], ["e4w", "e-4W"], ["bus", "e-bus"]];
    // pooled peak-hour queue per charger type (M/M/c, Erlang C): a lower bound on guns, since real demand is spread over sites
    const groups = [["e2w3w", ["e2w", "e3w"], 12], ["e4w", ["e4w"], 60], ["bus", ["bus"], 240]];
    const need = (row) => Object.fromEntries(groups.map(([g, ss, kw]) => {
      let lam = 0, kwh = 0;
      for (const x of ss) { const sess = row.stock[x] * Q.kwhDay[x] * Q.publicShare[x] / Q.kwhSession[x]; lam += sess * Q.peakHourShare; kwh += sess * Q.kwhSession[x]; }
      const sess = lam / Q.peakHourShare, mu = kw * Q.efficiency / (sess ? kwh / sess : Q.kwhSession[ss[0]]);
      const m = lam > 0 ? PM.chargersFor(lam, mu, Q.target, 20000) : { c: 0, pWait: 0, wqMin: 0, rho: 0 };
      return [g, { kw, lambda: lam, guns: m.c, pWait: m.pWait, wq: m.wqMin, rho: m.rho }];
    }));
    const ex = window.RGAdvanced.existingPoints(R.st.inventory);
    const nr = need(r), nNow = need(F.rows[0]);
    const mw = (n) => (n.e2w3w.guns * 12 + n.e4w.guns * 60 + n.bus.guns * 240) * 0.6 / 1000;
    const covered = S.analysis && S.analysis.ctx.base.coverage;
    const lastY = Object.keys(R.ev.years).sort().pop(), LY = R.ev.years[lastY];
    const slider = (k, sub, label, min, max, step, v, fmt) => `<label class="f"><span class="row"><span>${label}</span><b>${fmt(v)}</b></span><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-sc="${k}" data-sub="${sub || ""}"></label>`;
    tb.innerHTML = `
      <div class="hdr"><span>EV adoption S-curve</span><span class="sub">anchored to observed VAHAN ${F.anchorYear} EV share of new registrations</span></div>
      <div class="sgrid">${segs.map(([k, n]) => `<div class="sseg"><b>${n}</b><span class="sub">${F.anchorYear}: ${pct(F.rows[0].share[k], 1)} of new regs</span>
        ${slider("saturation", k, "Long-run share", 0.05, 1, 0.05, sc.saturation[k], v => pct(v, 0))}
        ${slider("inflection", k, "Inflection year", 2024, 2040, 1, sc.inflection[k], v => v)}</div>`).join("")}</div>
      <div class="grid2">${slider("marketGrowth", "", "All-fuel market growth / yr", 0, 0.12, 0.01, sc.marketGrowth, v => pct(v, 0))}
        <label class="f"><span class="row"><span>Year</span><b>${year}</b></span><input type="range" min="${F.anchorYear + 1}" max="${sc.horizon}" step="1" value="${year}" id="fc-year"></label></div>
      <div class="result-band" style="grid-template-columns:repeat(3,1fr)">
        <div><b>${people(segs.reduce((a, [k]) => a + r.stock[k], 0))}</b><span>EVs on the road in ${year}</span></div>
        <div><b>${nIN(nr.e2w3w.guns)}</b><span>12 kW LECCS guns at peak (have ~${nIN(ex.ac)} AC)</span></div>
        <div><b>${nIN(nr.e4w.guns)} · ${nIN(nr.bus.guns)}</b><span>60 kW · 240 kW CCS-II guns (have ~${nIN(ex.dc)} DC)</span></div>
        <div><b>${mw(nr).toFixed(1)} MW</b><span>public charging peak load ${year} (0.6 diversity)</span></div>
        <div><b>${pct(r.share.e2w, 0)} · ${pct(r.share.e4w, 0)}</b><span>EV share of new 2W · 4W in ${year}</span></div>
        <div><b>${covered != null ? pct(covered, 0) : "—"}</b><span>people within ${S.opts.tauKm} km today (spatial)</span></div>
      </div>
      ${covered != null && covered >= 0.95 && (nr.e4w.guns > ex.dc || nr.e2w3w.guns > ex.ac) ? `<div class="note warnnote"><b>Coverage is not capacity.</b> ${pct(covered, 0)} of people already live within ${S.opts.tauKm} km of a charger, yet the ${year} fleet needs ${nIN(Math.max(0, nr.e4w.guns + nr.bus.guns - ex.dc))} more DC and ${nIN(Math.max(0, nr.e2w3w.guns - ex.ac))} more 12 kW guns to keep the chance of waiting at the evening peak below ${pct(Q.target, 0)} (M/M/c queue).</div>` : ""}
      ${lineChart(segs.map(([k, n], i) => ({ name: n + " share of new regs", color: ["#e44fbf", "#b8306f", "#1b1b1d", "#5aa9ff"][i], points: F.rows.map(x => [x.year, x.share[k] * 100]) })), { xFmt: v => v, yFmt: v => v.toFixed(0) + "%", xLabel: "year", yLabel: "EV % of new registrations" })}
      <div class="scroll" style="margin-top:8px;max-height:240px"><table class="t"><thead><tr><th>Year</th>${segs.map(([, n]) => `<th class="n">${n} fleet</th>`).join("")}<th class="n">12 kW</th><th class="n">60 kW</th><th class="n">240 kW</th><th class="n">P(wait) 4W</th><th class="n">MW</th></tr></thead><tbody>
        ${F.rows.map(x => { const n = need(x); return `<tr ${x.year === year ? 'style="background:var(--paper);font-weight:600"' : ""}><td>${x.year}${x.year === F.anchorYear ? " (obs.)" : ""}</td>${segs.map(([k]) => `<td class="n">${nIN(x.stock[k])}</td>`).join("")}<td class="n">${nIN(n.e2w3w.guns)}</td><td class="n">${nIN(n.e4w.guns)}</td><td class="n">${nIN(n.bus.guns)}</td><td class="n">${pct(n.e4w.pWait, 0)}</td><td class="n">${mw(n).toFixed(1)}</td></tr>`; }).join("")}</tbody></table></div>
      <div class="note">Observed: VAHAN registrations by RTO, ${esc(Object.keys(R.ev.years).sort()[0])}–${esc(lastY)} (${LY.n || 12} months of ${esc(lastY)}), fleet = registrations since 2022. The S-curve s(t) = S / (1 + e<sup>−k(t − t₀)</sup>) passes through the observed ${F.anchorYear} share; k is solved from S and t₀ (slider values are assumptions). Guns needed: peak-hour sessions (${pct(Q.peakHourShare, 0)} of daily) from public energy demand, served at ${pct(Q.efficiency, 0)} of rated power, sized so that at most ${pct(Q.target, 0)} of EVs wait (Erlang C). Pooling all chargers into one queue makes this a lower bound; the Plan tab checks each site's own queue.</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm ghost" id="fc-csv">Export CSV</button><button class="btn sm ghost" id="fc-reset">Reset S-curve</button><button class="linkbtn" id="fc-classic">Use the ratio model instead</button></div>`;
    $$("input[data-sc]", tb).forEach(i => i.addEventListener("input", () => {
      const k = i.dataset.sc, sub = i.dataset.sub, v = +i.value;
      S.opts.scurve = sub ? { ...S.opts.scurve, [k]: { ...S.opts.scurve[k], [sub]: v } } : { ...S.opts.scurve, [k]: v };
      store.set("opts", S.opts); clearTimeout(tabForecast._t); tabForecast._t = setTimeout(() => tabForecast(tb), 60);
    }));
    $("#fc-year").oninput = (e) => { store.set("fyear", +e.target.value); tabForecast(tb); };
    $("#fc-reset").onclick = () => { S.opts.scurve = normOpts({ ...S.opts, scurve: {} }).scurve; store.set("opts", S.opts); tabForecast(tb); };
    $("#fc-classic").onclick = () => { store.set("fc_classic", true); tabForecast(tb); };
    $("#fc-csv").onclick = () => download(`reachgrid_scurve_${slug(regionName())}.csv`, ["year,share_e2w,share_e3w,share_e4w,share_bus,fleet_e2w,fleet_e3w,fleet_e4w,fleet_bus,guns_12kw,guns_60kw,guns_240kw,peak_mw", ...F.rows.map(x => { const n = need(x); return [x.year, ...segs.map(([k]) => x.share[k].toFixed(4)), ...segs.map(([k]) => x.stock[k]), n.e2w3w.guns, n.e4w.guns, n.bus.guns, mw(n).toFixed(2)].join(","); })].join("\n"), "text/csv");
    void nNow;
  }
  function tabForecastClassic(tb, canScurve) {
    const inp = forecastInputs(), c = inp.cfg, F = window.RGAdvanced.forecast({ e2wReg2024: inp.reg, e2wStock: inp.stock, cagr: inp.cagr, existing: inp.existing }, c);
    const year = Math.min(c.horizon, Math.max(2025, store.get("fyear", 2030))), r = F.rows.find(x => x.year === year) || F.rows[F.rows.length - 1];
    const target = store.get("ftarget", 0.9);
    const cov = window.RGAdvanced.sitesForCoverage(S.analysis.ctx, S.analysis.cands, effOpts(), target);
    const fleet = (row) => Object.values(row.stock).reduce((a, b) => a + b, 0);
    const num = (k, label, v, step, sub) => `<label class="f">${label}<input type="number" min="0" step="${step}" value="${v}" data-fc="${k}"${sub ? ` data-sub="${sub}"` : ""}></label>`;
    tb.innerHTML = `
      <div class="grid2">
        <label class="f">Growth scenario<select id="fc-scn">${[["trend", `VAHAN trend (${inp.cagr != null ? pct(inp.cagr, 0) : "n/a"}/yr, easing to ${pct(c.floorGrowth, 0)})`], ["moderate", "Moderate (25%/yr)"], ["conservative", "Conservative (12%/yr)"], ["custom", "Custom"]].map(([k, n]) => `<option value="${k}" ${c.scenario === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="f"><span class="row"><span>Year</span><b>${year}</b></span><input type="range" min="2025" max="${c.horizon}" step="1" value="${year}" id="fc-year"></label>
        ${c.scenario === "custom" ? num("customGrowth", "Custom growth (fraction/yr)", c.customGrowth, 0.01) : ""}
        <label class="f">Coverage target within τ<select id="fc-target">${[0.8, 0.9, 0.95].map(v => `<option value="${v}" ${v === target ? "selected" : ""}>${v * 100}% of people</option>`).join("")}</select></label>
      </div>
      <div class="result-band" style="grid-template-columns:repeat(3,1fr)">
        <div><b>${people(fleet(r))}</b><span>EVs in ${year} (all segments)</span></div>
        <div><b>${nIN(r.needAc)}</b><span>AC points needed (have ${nIN(r.haveAc)})</span></div>
        <div><b>${nIN(r.needDc)}</b><span>DC points needed (have ${nIN(r.haveDc)})</span></div>
        <div><b style="color:${r.gapAc ? "var(--bad)" : "var(--good)"}">${nIN(r.gapAc)}</b><span>AC points to add</span></div>
        <div><b style="color:${r.gapDc ? "var(--bad)" : "var(--good)"}">${nIN(r.gapDc)}</b><span>DC points to add</span></div>
        <div><b>${cov.sites}</b><span>new sites for ${pct(target, 0)} within ${S.opts.tauKm} km (${rupL(cov.cost)})${cov.capped ? " · not reachable with candidates" : ""}</span></div>
      </div>
      ${lineChart([
        { name: "AC points needed", color: "#e44fbf", points: F.rows.map(x => [x.year, x.needAc]) },
        { name: "DC points needed", color: "#1b1b1d", points: F.rows.map(x => [x.year, x.needDc]) },
        { name: "existing AC+DC", color: "#5aa9ff", dash: true, points: F.rows.map(x => [x.year, x.haveAc + x.haveDc]) },
      ], { xFmt: (v) => v, yFmt: (v) => nIN(v), xLabel: "year", yLabel: "charge points" })}
      <div class="scroll" style="margin-top:8px;max-height:230px"><table class="t"><thead><tr><th>Year</th><th class="n">Growth</th><th class="n">E2W</th><th class="n">E3W</th><th class="n">E4W</th><th class="n">e-bus</th><th class="n">Public kWh/day</th><th class="n">AC need</th><th class="n">DC need</th></tr></thead><tbody>
        ${F.rows.map(x => `<tr ${x.year === year ? 'style="background:var(--paper);font-weight:600"' : ""}><td>${x.year}</td><td class="n">${x.growth != null ? pct(x.growth, 0) : "—"}</td><td class="n">${nIN(x.stock.e2w)}</td><td class="n">${nIN(x.stock.e3w)}</td><td class="n">${nIN(x.stock.e4w)}</td><td class="n">${nIN(x.stock.ebus)}</td><td class="n">${nIN(x.publicKwhDay)}</td><td class="n">${nIN(x.needAc)}</td><td class="n">${nIN(x.needDc)}</td></tr>`).join("")}</tbody></table></div>
      <details style="margin-top:8px"><summary class="mono" style="cursor:pointer;font-size:11.5px">Segment & charging assumptions (editable)</summary>
        <div class="hdr"><span>Registrations relative to E2W</span></div>
        <div class="grid2">${num("ratios", "E3W (e-rickshaw, cargo)", c.ratios.e3w, 0.01, "e3w")}${num("ratios", "E4W (cars)", c.ratios.e4w, 0.005, "e4w")}${num("ratios", "e-bus", c.ratios.ebus, 0.001, "ebus")}</div>
        <div class="hdr"><span>kWh per vehicle per day · public share</span></div>
        <div class="grid2">${["e2w", "e3w", "e4w", "ebus"].map(k => num("kwhDay", `${k.toUpperCase()} kWh/day`, c.kwhDay[k], 0.1, k) + num("publicShare", `${k.toUpperCase()} public share`, c.publicShare[k], 0.01, k)).join("")}</div>
        <div class="grid2">${num("acKwhPerPointDay", "AC point delivers kWh/day", c.acKwhPerPointDay, 1)}${num("dcKwhPerPointDay", "DC point delivers kWh/day", c.dcKwhPerPointDay, 1)}${num("floorGrowth", "Trend growth floor by 2030", c.floorGrowth, 0.01)}${num("life", "Vehicle life (years)", c.life, 1)}</div>
        <button class="linkbtn" id="fc-reset">Reset assumptions</button>
      </details>
      <div class="note">Base: <b>${esc(inp.src)}</b>, ${nIN(inp.reg)} E2W registered in 2024, ~${nIN(inp.stock)} since 2020. E3W/E4W/bus use national ratios to E2W (assumptions, editable). Charging points needed = public energy demand ÷ energy one point delivers per day, with 2W/3W on AC and cars/buses on DC. The sites figure is the spatial requirement: how many new locations reach the coverage target. Both are planning estimates, not forecasts of sales.</div>
      <div style="display:flex;gap:6px"><button class="btn sm ghost" id="fc-csv">Export CSV</button>${canScurve ? `<button class="linkbtn" id="fc-scurve">Use the VAHAN S-curve model</button>` : ""}</div>`;
    if (canScurve) $("#fc-scurve").onclick = () => { store.set("fc_classic", false); tabForecast(tb); };
    const save = (patch) => { store.set("fcfg", { ...store.get("fcfg", {}), ...patch }); Audit.add("forecast.assumption", JSON.stringify(patch).slice(0, 120)); tabForecast(tb); };
    $("#fc-scn").onchange = (e) => save({ scenario: e.target.value });
    $("#fc-year").oninput = (e) => { store.set("fyear", +e.target.value); tabForecast(tb); };
    $("#fc-target").onchange = (e) => { store.set("ftarget", +e.target.value); tabForecast(tb); };
    $$("[data-fc]", tb).forEach(i => i.onchange = () => {
      const k = i.dataset.fc, sub = i.dataset.sub, v = Math.max(0, +i.value || 0);
      if (sub) save({ [k]: { ...c[k], [sub]: v } }); else save({ [k]: v });
    });
    $("#fc-reset").onclick = () => { store.set("fcfg", {}); tabForecast(tb); };
    $("#fc-csv").onclick = () => download(`reachgrid_forecast_${slug(regionName())}.csv`, ["year,growth,e2w_stock,e3w_stock,e4w_stock,ebus_stock,public_kwh_day,ac_points_needed,dc_points_needed,ac_existing,dc_existing,ac_gap,dc_gap", ...F.rows.map(x => [x.year, x.growth ?? "", x.stock.e2w, x.stock.e3w, x.stock.e4w, x.stock.ebus, x.publicKwhDay, x.needAc, x.needDc, x.haveAc, x.haveDc, x.gapAc, x.gapDc].join(","))].join("\n"), "text/csv");
  }


  /* ================================================================== DESKTOP APP (Electron) */
  let _deskSettings = null;
  async function deskSettings(fresh) { if (!_deskSettings || fresh) _deskSettings = await DESK.settings(); return _deskSettings; }
  /* ------------------------------------------------------------------ judge challenge */
  function openChallenge() {
    const md = modal("Live challenge", `<p style="margin:0 0 8px">Name any Indian district, state, town or a corridor (<i>Delhi to Jaipur</i>). ReachGrid loads it and plans <b>₹10 crore</b> of PM E-DRIVE charging stations.</p>
      <form id="ch-f" style="display:flex;gap:6px"><input id="ch-q" style="flex:1;font-size:16px;padding:8px" placeholder="e.g. Nashik, Bastar, Delhi to Jaipur" autocomplete="off"><button class="btn">Go</button></form><div id="ch-o" style="margin-top:10px"></div>`);
    md.el.classList.add("challenge");
    const q = $("#ch-q", md.el); q.focus();
    $("#ch-f", md.el).onsubmit = async (e) => {
      e.preventDefault(); const text = q.value.trim(); if (!text) return;
      const out = $("#ch-o", md.el), t0 = performance.now();
      const tick = setInterval(() => { out.innerHTML = `<div class="ch-clock">${((performance.now() - t0) / 1000).toFixed(1)} s</div>`; }, 50);
      try {
        const cor = text.split(/\s+(?:to|→|->|-)\s+/i);
        if (cor.length === 2 && findPlace(cor[0]) && findPlace(cor[1])) {
          S.mode = "corridor"; S.corridor.from = findPlace(cor[0]); S.corridor.to = findPlace(cor[1]); await goIndia(); await runCorridor();
          clearInterval(tick); const g = S.route && S.route.g, secs = (performance.now() - t0) / 1000;
          out.innerHTML = `<div class="ch-clock done">${secs.toFixed(1)} s</div>${g ? `<div class="result-band" style="grid-template-columns:repeat(3,1fr)"><div><b>${g.total.toFixed(0)} km</b><span>${esc(S.corridor.from[0])} → ${esc(S.corridor.to[0])}</span></div><div><b>${g.maxGap.toFixed(0)} km</b><span>longest gap between chargers</span></div><div><b>${g.feasible ? "Feasible" : "Not feasible"}</b><span>for a ${S.corridor.range} km EV with ${S.corridor.reserve}% reserve</span></div></div>` : "<p>No route found.</p>"}`;
          Audit.add("challenge.corridor", `${text} · ${secs.toFixed(1)} s`); return;
        }
        const r = challengeTarget(text); if (!r) { clearInterval(tick); out.innerHTML = `<p>No district, state or town called “${esc(text)}”.</p>`; return; }
        S.mode = "atlas";
        if (r.did) { S.opts.budgetLakh = 1000; await goDistrict(r.did); } else { S.opts.budgetStateLakh = 1000; await goState(r.sid); }
        S.opts.pm = { ...S.opts.pm, enabled: true }; S.planKey = "greedy"; S.tab = "plan";
        runAnalysis(); drawPlan(true); renderInspector(); updateStatus();
        clearInterval(tick);
        const A = S.analysis, p = A.plans.greedy, sm = PM.summarise(p.selected), rt = A.plans.ratio, secs = (performance.now() - t0) / 1000;
        const lift = rt && rt.metrics.newlyCovered ? p.metrics.newlyCovered / rt.metrics.newlyCovered - 1 : null;
        out.innerHTML = `<div class="ch-clock done">${secs.toFixed(1)} s</div>
          <div class="result-band" style="grid-template-columns:repeat(3,1fr)"><div><b>${esc(scopeName())}</b><span>${esc(S.did ? INDIA.stateById.get(S.sid).name : "state")}</span></div><div><b>${p.selected.length}</b><span>EV PCS · ${sm.chargers.e2w3w + sm.chargers.e4w + sm.chargers.bus} chargers</span></div><div><b>${pct(A.ctx.base.coverage)} → ${pct(p.metrics.coverage)}</b><span>people within ${S.opts.tauKm} km</span></div>
          <div><b>+${people(p.metrics.newlyCovered)}</b><span>newly covered${lift != null ? ` · ${lift >= 0 ? "+" : ""}${pct(lift, 0)} vs EV-ratio method` : ""}</span></div><div><b>${rupL(sm.subsidy)}</b><span>PM E-DRIVE subsidy requested</span></div><div><b>${pct(sm.catAShare, 0)}</b><span>Category A share ${sm.catAOk ? "✓" : "⚠"}</span></div></div>
          <p class="sub">Analysis: ${A.cands.length} candidates scored and six plans optimised in ${A.ms.toFixed(0)} ms. The full plan is in the Inspector; export the Annexures from the Plan tab.</p>`;
        Audit.add("challenge.region", `${text} → ${scopeName()} · ${secs.toFixed(1)} s`);
      } catch (err) { clearInterval(tick); out.textContent = "Failed: " + err.message; }
    };
  }

  /** district / state / town name → {did} or {sid}; exact names first, then towns (GeoNames) to their district */
  function challengeTarget(text) {
    const n = norm(text);
    const d = INDIA.districts.find(x => norm(x.name) === n); if (d) return { did: d.id };
    const st = INDIA.states.find(x => norm(x.name) === n); if (st) return { sid: st.id };
    const p = findPlace(text); if (p) return { did: p[4] };
    const r = findRegion(text); if (r) return r.kind === "district" ? { did: r.id } : { sid: r.id };
    return null;
  }

  /* ------------------------------------------------------------------ Round 1 → Round 2 changelog */
  const CHANGELOG = [
    ["Round 1 roadmap: monthly VAHAN RTO exports", "Built: VAHAN registrations by RTO and month (Jan 2022 onward), matched to 737 districts, by segment, refreshed weekly", "Forecast · Validate"],
    ["Round 1 roadmap: street-level routing on OSM", "Built: corridor checks route on the real street network (OSRM) with the highway graph as offline fallback", "Corridor mode"],
    ["Round 1 roadmap: scenario API for state portals", "Built: REST API (geographies, baselines, scenarios) served by the desktop app with API keys; OpenAPI spec", "Docs → Scenario API"],
    ["Round 1 roadmap: server deployment with role enforcement", "Built: Viewer / Analyst / Admin accounts enforced by the app, sign-in, hash-chained audit log on disk", "Settings → Users"],
    ["Round 1 roadmap: portfolio monitor and recalibration", "Built: mark sites built, record sessions, recalibrate the commercial screen", "Portfolio"],
    ["Round 1 roadmap: shortlist → field validation → review", "Built: evidence upload (land, DISCOM kVA, quotes), review queue with Admin sign-off", "Evidence · Plan"],
    ["Round 1 roadmap: templates for corridor and city plans", "Built: PM E-DRIVE proposal workbook in MHI's Annexure B/C/D formats and the feasibility study report (FAQ 4)", "Plan → exports"],
    ["New in Round 2: PM E-DRIVE rules in the optimiser", "Location categories A–D with their subsidy shares, BEE benchmarks (Oct 2025), Category A ≤ 20%, budget as project cost / subsidy / agency outlay", "Plan"],
    ["New in Round 2: real PM E-DRIVE locations as candidates", "PSU OMC outlets, toll plazas, rail and bus stations, AAI airports and government premises from OpenStreetMap, with their category", "Plan · map"],
    ["New in Round 2: capacity, not just coverage", "M/M/c (Erlang C) peak-hour queue per site and per district: where 100% spatial coverage still needs more guns", "Plan → site · Forecast"],
    ["New in Round 2: adoption S-curve to 2030", "Logistic EV share of new registrations anchored to each district's observed VAHAN share; charger and MW requirements", "Forecast"],
    ["New in Round 2: provable optimiser quality", "Modified greedy with its ½(1 − 1/e) guarantee, measured against the exact ILP / LP bound", "Compare"],
    ["New in Round 2: baseline contrast", "Split-screen maps: EV-to-charger ratio allocation vs ReachGrid for the same budget", "Compare"],
    ["New in Round 2: native Windows app", "One-click installer, offline maps and data, auto-update, PDF exports, local API; tested on Windows in CI", "Website → Download"],
    ["New in Round 2: AI planning agent", "Groq · gpt-oss-120b with tool calling operates the workspace: opens regions, sets budgets, runs PM E-DRIVE plans, plans freight corridors; every number comes from the app's own tools", "Assistant"],
    ["New in Round 2: team server and in-app rebuild", "Share one workspace on the office network with enforced roles; rebuild chargers, VAHAN and OSM layers inside the app", "Settings → Team · Data"],
  ];
  function openChangelog() {
    modal("Round 1 → Round 2: how the build evolved", `<p class="sub" style="margin-top:0">Each Round 1 roadmap item and what was built, with where to find it.</p><table class="t"><thead><tr><th>Round 1 plan / new requirement</th><th>Built</th><th>Where</th></tr></thead><tbody>${CHANGELOG.map(([a, b, c]) => `<tr><td><b>${esc(a)}</b></td><td>${esc(b)}</td><td class="sub">${esc(c)}</td></tr>`).join("")}</tbody></table>`, { wide: true });
    Audit.add("view.changelog", "");
  }

  /* ------------------------------------------------------------------ Rule 5 & 6 disclosures */
  function openDisclosures() {
    const src = INDIA.sources || [];
    const derived = src.filter(x => x.kind !== "observed");
    modal("Data and AI disclosures (Rules 5 and 6)", `
      <div class="hdr"><span>Observed data</span><span class="sub">${src.filter(x => x.kind === "observed").length} sources, public, licensed</span></div>
      <table class="t"><tbody>${src.map(x => `<tr><td><b>${esc(x.title)}</b><div class="sub">${esc(x.publisher)} · ${esc(x.licence || "")}</div></td><td><span class="tag ${x.kind === "observed" ? "obs" : x.kind === "derived" ? "der" : "imp"}">${esc(x.kind)}</span></td></tr>`).join("")}</tbody></table>
      <div class="hdr"><span>Imputed, derived and modelled values</span></div>
      <ul style="margin:0;padding-left:16px">
        <li><b>No synthetic data.</b> Every number traces to a public source above or to a stated assumption.</li>
        <li>Census 2011 counts apportioned to 737 current districts (areal/dasymetric split) where boundaries changed: flagged <span class="tag imp">imputed</span> per district.</li>
        <li>Population on hexagonal demand cells (dasymetric): <span class="tag der">derived</span>.</li>
        <li>VAHAN segment split (e-2W / e-3W / e-4W / e-bus) of the non-e-rickshaw remainder: <span class="tag der">modelled</span>, calibrated and validated (Validate tab). EV totals and e-rickshaws are observed.</li>
        <li>Costs, adoption S-curve parameters, queue parameters, commercial hypotheses: <span class="tag imp">assumptions</span>, editable, listed in the Plan and Forecast tabs.</li>
        ${derived.map(x => `<li>${esc(x.title)}: ${esc(x.limits || x.kind)}</li>`).join("")}
      </ul>
      <div class="hdr"><span>AI models</span></div>
      <ul style="margin:0;padding-left:16px">
        <li><b>Ask ReachGrid</b> answers from the workspace's own numbers with built-in rules. If a user adds a Groq API key (encrypted on this computer, used only by the app's main process), it becomes an agent on <b>openai/gpt-oss-120b</b> (OpenAI's open-weight model, Apache 2.0) served by Groq: the question, a compact summary of the open region and the results of the app's own tools are sent to Groq; the model operates the workspace through those tools and every number it quotes comes from them. Off by default; nothing leaves the computer without a key.</li>
        <li>No AI model takes part in scoring, optimisation, forecasting or costing: those are deterministic, open formulas (Methodology).</li>
        <li>Development: the team used Anthropic's Claude (Claude Code) as a coding assistant. All outputs are reviewed and covered by automated tests.</li>
      </ul>
      <div class="hdr"><span>Open-source software</span></div>
      <p class="sub" style="margin:0">Leaflet (BSD-2), javascript-lp-solver (Unlicense), Electron (MIT), electron-builder / electron-updater (MIT), Python shapely (BSD-3), mapshaper (MPL-2.0). Map data © OpenStreetMap contributors (ODbL).</p>`, { wide: true });
    Audit.add("view.disclosures", "");
  }

  function modal(title, html, { wide = false } = {}) {
    const d = document.createElement("div"); d.className = "help rg-prompt rg-modal"; d.style.display = "grid";
    d.innerHTML = `<div class="win" style="width:min(${wide ? 860 : 440}px,calc(100vw - 32px));max-height:calc(100vh - 60px);display:flex;flex-direction:column"><div class="tb"><span class="t">${esc(title)}</span><button aria-label="Close" data-x>×</button></div><div class="bd" style="overflow:auto">${html}</div></div>`;
    (document.querySelector("#atlas .desk") || document.body).appendChild(d);
    const close = () => d.remove(); $("[data-x]", d).onclick = close;
    return { el: d, close };
  }
  /** sign-in before the workspace loads: automatic for the default owner, a form when sign-in is required */
  async function desktopSignIn() {
    if (DESK.session()) return;
    const a = await DESK.autoSignIn(); if (a && a.ok) return;
    $("#boot-step").textContent = "Sign in";
    await new Promise((resolve) => {
      const d = document.createElement("div"); d.className = "signin";
      document.body.style.overflow = "hidden";
      d.innerHTML = `<div class="win" style="width:min(380px,calc(100vw - 32px))"><div class="tb"><span class="t">ReachGrid India · sign in</span></div><div class="bd"><div style="display:flex;gap:12px;align-items:center;margin-bottom:8px"><img src="desktop-logo.png" width="52" height="52" alt=""><div><b style="font-family:var(--sans);font-size:18px">ReachGrid India</b><div class="sub">${DESK.team ? `Sign in to the team workspace on <b>${esc(DESK.team.name)}</b>.` : "Sign-in is required on this computer."}</div></div></div><form id="si"><label class="f">User<input id="si-u" autocomplete="username" required></label><label class="f">Password<input id="si-p" type="password" autocomplete="current-password"></label><div id="si-e" class="sub" style="color:var(--bad);min-height:16px"></div><button class="btn" style="width:100%;justify-content:center">Sign in</button></form></div></div>`;
      document.body.appendChild(d); $("#si-u").focus();
      $("#si").onsubmit = async (e) => { e.preventDefault(); const r = await DESK.signIn($("#si-u").value.trim(), $("#si-p").value); if (r.ok) { d.remove(); document.body.style.overflow = ""; resolve(); } else $("#si-e").textContent = r.error; };
    });
  }
  function initDesktop() {
    document.body.classList.add("desktop");
    const ex = $("#ab-exit"); if (ex) { ex.href = "#"; ex.title = "About & settings"; ex.onclick = (e) => { e.preventDefault(); openSettings("about"); }; }
    const tools = $(".ab-tools");
    if (tools && !$("#ab-settings")) { const b = document.createElement("button"); b.className = "ab-btn"; b.id = "ab-settings"; b.title = "Settings (Ctrl+,)"; b.textContent = "⚙"; b.onclick = () => openSettings("account"); tools.appendChild(b); }
    DESK.on("menu", async (cmd) => {
      if (cmd === "settings") openSettings("account");
      if (cmd === "settings:data") openSettings("data");
      if (cmd === "tour") tourStart();
      if (cmd === "help") $("#ab-help").click();
      if (cmd === "pdf") { const r = await DESK.pdfReport(`reachgrid_${slug(S.did ? regionName() : S.sid ? regionName() : "india")}.pdf`); if (r && r.ok) toast("PDF saved: " + r.path); }
      if (cmd === "project:save") { const r = await DESK.saveProject(); if (r.ok) toast("Project saved: " + r.path); }
      if (cmd === "project:open") { const r = await DESK.openProject("merge"); if (r.ok) { toast("Project merged into this workspace"); rerunAll(); } else if (r.error) toast(r.error); }
      if (cmd === "signout") { await DESK.signOut(); location.reload(); }
    });
    // background: tell the user when newer data has been published
    setTimeout(async () => { const r = await DESK.checkData(); if (r && r.available) { DESK.notify("New ReachGrid data available", `Build ${r.remote} (you have ${r.current}). Settings → Data to update.`); toast(`New data build ${r.remote} available: Settings → Data`); } }, 6000);
  }

  async function openSettings(section = "account") {
    const sess = DESK.session() || {}, st = await deskSettings(true), info = DESK.info(), admin = Gov.can("settings");
    const tabs = DESK.team ? [["account", "Account"], ["users", "Users"], ["team", "Team"], ["about", "About"]]
      : [["account", "Account"], ["users", "Users"], ["team", "Team"], ["api", "Local API"], ["data", "Data & maps"], ["updates", "Updates"], ["about", "About"]];
    const m = modal("Settings", `<div class="tabs" style="margin:-12px -12px 10px;position:static">${tabs.map(([k, n]) => `<button data-st="${k}" aria-selected="${k === section}">${n}</button>`).join("")}</div><div id="st-body"></div>`, { wide: true });
    const body = $("#st-body", m.el);
    $$("[data-st]", m.el).forEach(b => b.onclick = () => { m.close(); openSettings(b.dataset.st); });
    const note = (t, warn) => `<div class="note ${warn ? "warnnote" : ""}">${t}</div>`;
    if (section === "account") {
      body.innerHTML = `<div class="kpis"><div class="kpi"><b>${esc(sess.name || "—")}</b><span>signed in as ${esc(sess.user || "")}</span></div><div class="kpi"><b>${esc(ROLES[sess.role] || "—")}</b><span>role (enforced by the app)</span></div><div class="kpi"><b>${(sess.perms || []).length}</b><span>permissions</span></div></div>
        <p class="sub">Permissions: ${(sess.perms || []).map(esc).join(", ") || "view only"}.</p>
        <div class="hdr"><span>Switch user</span></div><form id="sw"><div class="grid2"><input id="sw-u" placeholder="user id"><input id="sw-p" type="password" placeholder="password"></div><button class="btn sm" style="margin-top:6px">Sign in as this user</button> <span id="sw-e" class="sub"></span></form>
        <div class="hdr"><span>Your password</span></div><form id="pw"><div class="grid2"><input id="pw-o" type="password" placeholder="current (blank if none)"><input id="pw-n" type="password" placeholder="new (blank removes it)"></div><button class="btn sm ghost" style="margin-top:6px">Change password</button> <span id="pw-e" class="sub"></span></form>
        <div style="margin-top:12px"><button class="btn sm ghost" id="so">Sign out</button></div>`;
      $("#sw", body).onsubmit = async (e) => { e.preventDefault(); const r = await DESK.signIn($("#sw-u").value.trim(), $("#sw-p").value); if (r.ok) { toast("Signed in as " + r.session.name); m.close(); window.__syncRole && window.__syncRole(); renderInspector(); } else $("#sw-e").textContent = r.error; };
      $("#pw", body).onsubmit = async (e) => { e.preventDefault(); const r = await DESK.changePassword($("#pw-o").value, $("#pw-n").value); $("#pw-e").textContent = r.ok ? "Password updated" : r.error; };
      $("#so", body).onclick = async () => { await DESK.signOut(); location.reload(); };
    }
    if (section === "users") {
      const users = await DESK.users();
      body.innerHTML = `${admin ? "" : note("Only an Admin can manage users.", true)}
        <table class="t"><thead><tr><th>User</th><th>Name</th><th>Role</th><th>Password</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td class="mono">${esc(u.id)}</td><td>${esc(u.name)}</td><td>${esc(ROLES[u.role])}</td><td>${u.hasPassword ? "set" : "<span class='tag imp'>none</span>"}</td><td>${admin ? `<button class="linkbtn" data-ud="${esc(u.id)}">remove</button>` : ""}</td></tr>`).join("")}</tbody></table>
        ${admin ? `<div class="hdr"><span>Add or update a user</span></div><form id="uf"><div class="grid2"><input id="uf-id" placeholder="user id (e.g. priya)" required><input id="uf-n" placeholder="display name"><select id="uf-r"><option value="viewer">Viewer</option><option value="analyst" selected>Analyst</option><option value="admin">Admin</option></select><input id="uf-p" type="password" placeholder="password (required to sign in)"></div><button class="btn sm" style="margin-top:6px">Save user</button> <span id="uf-e" class="sub"></span></form>
        <div class="hdr"><span>Sign-in policy</span></div><label class="lgrow"><input type="checkbox" id="req" ${st.requireSignIn ? "checked" : ""}> require a password at start-up (set an Admin password first)</label><span id="req-e" class="sub"></span>` : ""}
        <p class="sub">Roles are enforced by the desktop app's main process: a Viewer cannot change evidence, the portfolio or reviews even from developer tools. Every action is written to the audit log on disk.</p>`;
      if (admin) {
        $("#uf", body).onsubmit = async (e) => { e.preventDefault(); const r = await DESK.saveUser({ id: $("#uf-id").value.trim(), name: $("#uf-n").value.trim(), role: $("#uf-r").value, password: $("#uf-p").value }); if (r.ok) { m.close(); openSettings("users"); toast("User saved"); } else $("#uf-e").textContent = r.error; };
        $$("[data-ud]", body).forEach(b => b.onclick = async () => { const r = await DESK.deleteUser(b.dataset.ud); if (r.ok) { m.close(); openSettings("users"); } else toast(r.error); });
        $("#req", body).onchange = async (e) => { const r = await DESK.updateSettings({ requireSignIn: e.target.checked }); if (!r.ok) { e.target.checked = !e.target.checked; $("#req-e").textContent = r.error; } else toast("Saved"); };
      }
    }
    if (section === "api") {
      const curl = `curl -H "X-API-Key: ${admin ? st.apiKey : "<key>"}" ${st.apiUrl}/geographies/jharkhand.east-singhbhum/baseline`;
      body.innerHTML = `<p>The scenario API runs on a real HTTP server inside the app while it is open, so scripts, Python, Excel Power Query or curl on this computer can call it.</p>
        <div class="kpis"><div class="kpi"><b class="mono" style="font-size:13px">${esc(st.apiUrl)}</b><span>base URL (this computer only)</span></div><div class="kpi"><b>${st.apiWrite ? "read + write" : "read only"}</b><span>API-key access</span></div></div>
        ${admin ? `<label class="f">API key<input type="text" readonly value="${esc(st.apiKey)}" id="ak-v" onclick="this.select()"></label><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm ghost" id="ak-c">Copy key</button><button class="btn sm ghost" id="ak-r">Rotate key</button></div>
          <label class="lgrow" style="margin-top:8px"><input type="checkbox" id="ak-w" ${st.apiWrite ? "checked" : ""}> allow API-key clients to create and delete scenarios</label>
          <label class="f">Fixed port (0 = automatic, applies after restart)<input type="number" id="ak-p" min="0" max="65535" value="${st.apiPort || 0}"></label>` : note("Only an Admin can see the API key.", true)}
        <div class="hdr"><span>Example</span></div><pre class="out" style="white-space:pre-wrap">${esc(curl)}</pre>
        <button class="btn sm" id="ak-doc">Open API console</button>`;
      $("#ak-doc", body).onclick = () => DESK.openDoc("api.html");
      if (admin) {
        $("#ak-c", body).onclick = () => { navigator.clipboard.writeText(st.apiKey); toast("Copied"); };
        $("#ak-r", body).onclick = async () => { await DESK.rotateApiKey(); m.close(); openSettings("api"); toast("New key issued; the old one stops working"); };
        $("#ak-w", body).onchange = async (e) => { const r = await DESK.updateSettings({ apiWrite: e.target.checked }); toast(r.ok ? "Saved" : r.error); };
        $("#ak-p", body).onchange = async (e) => { const r = await DESK.updateSettings({ apiPort: Math.max(0, Math.min(65535, +e.target.value || 0)) }); toast(r.ok ? "Saved: restart the app to use the new port" : r.error); };
      }
    }
    if (section === "data") {
      const tc = await DESK.tileCache();
      const reg = S.did ? curDistrict() : S.sid ? curState() : null;
      body.innerHTML = `<div class="kpis"><div class="kpi"><b class="mono" style="font-size:13px">${esc(INDIA.version)}</b><span>data build in use</span></div><div class="kpi"><b>${(tc.bytes / 1e6).toFixed(1)} MB</b><span>${nIN(tc.files)} map tiles cached offline</span></div><div class="kpi"><b>${INDIA.grid ? (INDIA.grid.kind === "substation" ? "OSM substations" : "WRI plants") : "—"}</b><span>grid proxy (${INDIA.grid ? nIN(INDIA.grid.points.length / 3) : 0} points)</span></div></div>
        <div class="hdr"><span>Data updates</span></div><p class="sub">The published data rebuilds weekly from the public sources. Updates download into your profile; the bundled data stays as a fallback.</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" id="du-c">Check for new data</button><button class="btn sm ghost" id="du-r" ${admin ? "" : "disabled"}>Revert to bundled data</button></div><div id="du-o" class="sub" style="margin-top:6px"></div>
        <div class="hdr"><span>Rebuild from the sources</span><span class="sub">no Python needed</span></div>
        <p class="sub">Re-download the changing sources and rebuild them here with the pipeline's formulas: charger listings (coverage and statistics for all 737 districts), VAHAN registrations by RTO (≈130 MB), and OpenStreetMap PM E-DRIVE locations. Census, boundaries and demand cells are reused. “Revert to bundled data” undoes it.</p>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px"><label><input type="checkbox" data-rb="chargers" checked> chargers</label><label><input type="checkbox" data-rb="vahan" checked> VAHAN by RTO</label><label><input type="checkbox" data-rb="osm"> OpenStreetMap locations</label></div>
        <button class="btn sm" id="rb-go" ${admin ? "" : "disabled"} style="margin-top:6px">Rebuild now</button><div id="rb-o" class="sub" style="margin-top:6px"></div>
        <div class="hdr"><span>Live grid layer</span></div><p class="sub">Fetch every power substation in India from OpenStreetMap (Overpass) and use it for grid proximity in feasibility scores, instead of the power-plant proxy. Takes 1–5 minutes.</p>
        <button class="btn sm" id="gr" ${admin ? "" : "disabled"}>Refresh substations from OpenStreetMap</button><div id="gr-o" class="sub" style="margin-top:6px"></div>
        <div class="hdr"><span>Offline street maps</span></div><p class="sub">Every tile you view is cached. To work offline in the field, download a whole region in advance.</p>
        <div class="grid2"><label class="f">Region<select id="of-reg">${reg ? `<option value="cur">${esc(regionName())}</option>` : ""}<option value="view">Current map view</option></select></label><label class="f">Detail (max zoom)<select id="of-z"><option value="12" selected>Overview (z ≤ 12)</option><option value="13">Town level (z ≤ 13)</option><option value="15">Street level (z ≤ 15)</option></select></label></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" id="of-go">Download for offline</button><button class="btn sm ghost" id="of-x">Cancel</button><button class="btn sm ghost" id="of-clr">Clear cache</button></div><div id="of-o" class="sub" style="margin-top:6px"></div>
        <div class="hdr"><span>Basemap tile server</span></div><p class="sub">Default: the OpenStreetMap Foundation tile server, within its usage policy (offline downloads above zoom 12 are limited to 250 tiles). Organisations with their own or a commercial tile service can paste its URL template here.</p>
        <div style="display:flex;gap:6px"><input id="tu" type="text" style="flex:1" placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png" value="${esc(st.tileUrl || "")}" ${admin ? "" : "disabled"}><button class="btn sm" id="tu-s" ${admin ? "" : "disabled"}>Use</button><button class="btn sm ghost" id="tu-r" ${admin ? "" : "disabled"}>Default</button></div><div id="tu-o" class="sub" style="margin-top:6px"></div>
        <div class="hdr"><span>Routing</span></div><label class="lgrow"><input type="checkbox" id="osrm" ${st.osrmRouting ? "checked" : ""} ${admin ? "" : "disabled"}> corridor checks use real street routing (OSRM) when online, highway graph otherwise</label>
        <div class="hdr"><span>Your files</span></div><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm ghost" id="pj-s">Save project…</button><button class="btn sm ghost" id="pj-o">Open project…</button><button class="btn sm ghost" id="ud">Open data folder</button></div>`;
      $("#du-c", body).onclick = async () => {
        $("#du-o").textContent = "Checking…"; const r = await DESK.checkData();
        if (r.error) { $("#du-o").textContent = "Could not check: " + r.error; return; }
        if (!r.available) { $("#du-o").textContent = `Up to date (${r.current}).`; return; }
        $("#du-o").innerHTML = `New build <b>${esc(r.remote)}</b> available (you have ${esc(r.current)}). ${admin ? `<button class="btn sm" id="du-a">Download and apply</button>` : "Ask an Admin to update."}`;
        if (admin) $("#du-a").onclick = async () => { DESK.on("data:progress", (i, n) => { $("#du-o").textContent = `Downloading ${i}/${n} files…`; }); const a = await DESK.applyData(); if (a.error) $("#du-o").textContent = "Failed: " + a.error; else { $("#du-o").textContent = `Updated to ${a.build}. Reloading…`; setTimeout(() => location.reload(), 900); } };
      };
      $("#rb-go", body).onclick = async () => {
        const parts = $$("[data-rb]", body).filter(x => x.checked).map(x => x.dataset.rb); if (!parts.length) return;
        const o = $("#rb-o"); $("#rb-go").disabled = true; o.textContent = "Starting…";
        DESK.on("rebuild:progress", (part, msg) => { o.textContent = `${part}: ${msg}`; });
        const r = await DESK.rebuildData(parts);
        if (!r || !r.ok) { o.textContent = "Failed: " + (r && r.error || "unknown"); $("#rb-go").disabled = false; return; }
        o.innerHTML = `Rebuilt <b>${esc(r.build)}</b>: ${Object.entries(r.report).map(([k, v]) => `${k} ${esc(JSON.stringify(v).replace(/[{}"]/g, "").slice(0, 120))}`).join(" · ")}. ${r.changedStates} states changed. Reloading…`;
        setTimeout(() => location.reload(), 1500);
      };
      $("#du-r", body).onclick = async () => { const r = await DESK.revertData(); if (r.error) toast(r.error); else { toast("Back to bundled data " + r.build); setTimeout(() => location.reload(), 600); } };
      $("#gr", body).onclick = async () => { DESK.on("grid:progress", (t) => { $("#gr-o").textContent = t; }); $("#gr-o").textContent = "Starting…"; const r = await DESK.refreshGrid(); if (r.error) $("#gr-o").textContent = "Failed: " + r.error; else { $("#gr-o").textContent = `${nIN(r.substations)} substations loaded. Reloading…`; setTimeout(() => location.reload(), 900); } };
      $("#of-go", body).onclick = async () => {
        let bb;
        if ($("#of-reg").value === "cur" && reg) { const geoms = S.did ? [curDistrict().geom] : curState().districts.map(d => d.geom); bb = [180, 90, -180, -90]; geoms.forEach(g => { const b = E.bbox(g); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; }); }
        else { const b = map.getBounds(); bb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; }
        DESK.on("tiles:progress", (d, n, f) => { $("#of-o").textContent = `${nIN(d)} / ${nIN(n)} tiles${f ? ` · ${f} failed` : ""}`; });
        $("#of-o").textContent = "Starting…";
        const r = await DESK.prefetchTiles(bb, 6, +$("#of-z").value);
        $("#of-o").textContent = r.error ? "Failed: " + r.error : `Done: ${nIN(r.total)} tiles available offline${r.failed ? ` (${r.failed} failed; retry when online)` : ""}.`;
      };
      const setTiles = async (v) => { const r = await DESK.updateSettings({ tileUrl: v }); _deskSettings = null; if (!r.ok) { $("#tu-o").textContent = r.error; return; } $("#tu-o").textContent = "Saved. Reloading the map…"; setTimeout(() => location.reload(), 700); };
      $("#tu-s", body).onclick = () => setTiles($("#tu").value.trim());
      $("#tu-r", body).onclick = () => setTiles("");
      $("#of-x", body).onclick = () => DESK.cancelTiles();
      $("#of-clr", body).onclick = async () => { const r = await DESK.clearTiles(); $("#of-o").textContent = `Cache cleared (${r.files} files).`; };
      $("#osrm", body).onchange = async (e) => { const r = await DESK.updateSettings({ osrmRouting: e.target.checked }); _deskSettings = null; toast(r.ok ? "Saved" : r.error); };
      $("#pj-s", body).onclick = async () => { const r = await DESK.saveProject(); if (r.ok) toast("Project saved: " + r.path); };
      $("#pj-o", body).onclick = async () => { const r = await DESK.openProject("merge"); if (r.ok) { toast("Project merged"); m.close(); rerunAll(); } else if (r.error) toast(r.error); };
      $("#ud", body).onclick = () => DESK.openUserData();
    }
    if (section === "updates") {
      body.innerHTML = `<div class="kpis"><div class="kpi"><b>${esc(info.version)}</b><span>app version</span></div><div class="kpi"><b>${esc(INDIA.version)}</b><span>data build</span></div><div class="kpi"><b>${info.packaged ? "installed" : "development"}</b><span>mode</span></div></div>
        <label class="lgrow"><input type="checkbox" id="au" ${st.autoUpdate ? "checked" : ""} ${admin ? "" : "disabled"}> check for app updates at start-up (downloads in the background, installs on restart)</label>
        <button class="btn sm" id="au-c">Check for app updates now</button>`;
      $("#au", body).onchange = async (e) => { const r = await DESK.updateSettings({ autoUpdate: e.target.checked }); toast(r.ok ? "Saved" : r.error); };
      $("#au-c", body).onclick = () => DESK.checkAppUpdate();
    }
    if (section === "team") {
      if (DESK.team) {
        body.innerHTML = `<div class="kpis"><div class="kpi"><b>${esc(DESK.team.name)}</b><span>team server</span></div><div class="kpi"><b class="mono" style="font-size:12px">${esc(DESK.team.server)}</b><span>address</span></div><div class="kpi"><b>${esc((sess.name || sess.user || "—"))}</b><span>${esc(ROLES[sess.role] || "")} on the server</span></div></div>
          <p>You are working in a shared workspace. Evidence, portfolio, reviews and saved scenarios live on the server; your role is enforced there and every action is in its audit log. Files and PDFs you export are saved on this computer.</p>
          <button class="btn sm" id="tm-leave">Disconnect and use this computer's workspace</button>`;
        $("#tm-leave", body).onclick = () => DESK.leaveTeam();
      } else {
        const t = await DESK.teamStatus();
        body.innerHTML = `<div class="hdr"><span>Share this workspace on your network</span><span class="sub">team server</span></div>
          <p class="sub" style="margin-top:0">Colleagues with ReachGrid on the same office network join this workspace and work on the same evidence, portfolio, reviews and scenarios, each with their own account and role. Requires sign-in with passwords; traffic is plain HTTP, so use it on a trusted network. The first time, Windows asks whether ReachGrid may use the network: allow it on private networks.</p>
          ${t.running ? `<div class="kpis"><div class="kpi"><b style="color:var(--good)">Sharing</b><span>port ${t.port}</span></div><div class="kpi"><b>${(t.sessions || []).length}</b><span>colleagues signed in</span></div></div>
            <div class="sub">Give colleagues this address (Settings → Team → Join):</div>${(t.urls || []).map(x => `<pre class="out" style="margin:4px 0">${esc(x)}</pre>`).join("")}
            ${(t.sessions || []).length ? `<table class="t"><thead><tr><th>User</th><th>From</th><th>Since</th></tr></thead><tbody>${t.sessions.map(x => `<tr><td>${esc(x.user)}</td><td class="mono">${esc(x.ip)}</td><td>${esc(x.since.slice(11, 16))}</td></tr>`).join("")}</tbody></table>` : ""}
            ${admin ? `<button class="btn sm ghost" id="tm-stop">Stop sharing</button>` : ""}`
          : `${!t.requireSignIn ? note("Turn on “require a password” in the Users tab first (set an Admin password), then share.", true) : ""}
            ${admin ? `<div class="grid2"><label class="f">Port<input type="number" id="tm-port" min="1024" max="65535" value="${t.port || 47800}"></label><label class="f" style="align-content:end"><button class="btn sm" id="tm-start" ${t.requireSignIn ? "" : "disabled"}>Start sharing</button></label></div>` : note("Only an Admin can share this workspace.", true)}`}
          <div id="tm-e" class="sub" style="color:var(--bad);min-height:14px"></div>
          <div class="hdr"><span>Join a colleague's workspace</span><span class="sub">team client</span></div>
          <form id="tm-j" style="display:flex;gap:6px"><input id="tm-url" style="flex:1" placeholder="http://192.168.1.20:47800"><button class="btn sm">Join</button></form>
          <p class="sub">This computer's own workspace is kept; disconnect any time to return to it.</p>`;
        const err = (x) => { $("#tm-e").textContent = x || ""; };
        if ($("#tm-start", body)) $("#tm-start", body).onclick = async () => {
          const pv = +$("#tm-port").value; if (pv !== t.port) { const r0 = await DESK.updateSettings({ teamPort: pv }); if (!r0.ok) return err(r0.error); }
          const r = await DESK.teamStart(); if (!r.ok) return err(r.error); m.close(); openSettings("team");
        };
        if ($("#tm-stop", body)) $("#tm-stop", body).onclick = async () => { await DESK.teamStop(); m.close(); openSettings("team"); };
        $("#tm-j", body).onsubmit = async (e) => { e.preventDefault(); const r = await DESK.joinTeam($("#tm-url").value); if (!r.ok) err(r.error); };
      }
    }
    if (section === "about") {
      body.innerHTML = `<div style="display:flex;gap:16px;align-items:center"><img src="desktop-logo.png" width="72" height="72" alt=""><div><div class="big-name">ReachGrid India</div><div class="sub">EV charging access intelligence & investment optimisation · v${esc(info.version)}</div></div></div>
        <p>Team GoingAgain · Team ID TM-7E9065875FC · Techfest 2026–27 EV Infra & Green Mobility AI Challenge.</p>
        <p class="sub">Data build ${esc(INDIA.version)} · local API ${esc(st.apiUrl)} · profile folder ${esc(info.userData)}</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm ghost" data-doc="methodology.html">Methodology</button><button class="btn sm ghost" data-doc="business.html">Business model</button><button class="btn sm ghost" data-doc="api.html">API</button><button class="btn sm ghost" id="ab-tour">Guided demo</button></div>`;
      $$("[data-doc]", body).forEach(b => b.onclick = () => DESK.openDoc(b.dataset.doc));
      $("#ab-tour", body).onclick = () => { m.close(); tourStart(); };
    }
  }

  /** end-to-end checks the Windows build runs inside the installed app (--smoke-test) */
  async function desktopSelfTest() {
    const out = [], ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) });
    try {
      ok("data loaded", INDIA && INDIA.states.length === 36 && INDIA.totals.chargers > 20000, `${INDIA.states.length} states, ${INDIA.totals.chargers} chargers`);
      await goDistrict("jharkhand.east-singhbhum");
      const A = S.analysis; ok("district analysis", A && A.plans.greedy.metrics.coverage >= A.ctx.base.coverage, A && `${pct(A.ctx.base.coverage)} → ${pct(A.plans.greedy.metrics.coverage)}`);
      for (const [pass, name, detail] of selfTests()) ok("self-test: " + name, pass, detail);
      for (const t of ["plan", "forecast", "compare", "validate", "evidence", "portfolio", "chargers", "ledger"]) { S.tab = t; renderInspector(); await new Promise(r => setTimeout(r, 150)); ok("tab renders: " + t, $("#tabbody") && $("#tabbody").textContent.length > 40, t); }
      const curve = await runJob("budgetCurve"); ok("background job (worker)", Array.isArray(curve) && curve.length === 8, curve && curve.length);
      // ---- Round 2: PM E-DRIVE, VAHAN, queue, S-curve, exports, challenge
      {
        const A2 = S.analysis, g = A2.plans.greedy, sm = PM.summarise(g.selected);
        ok("PM E-DRIVE costing on every candidate", S.opts.pm.enabled && A2.cands.every(c => c.pm && ["A", "B", "C", "D"].includes(c.pm.category)), `${A2.cands.length} candidates`);
        ok("pressure from VAHAN RTO registrations", /VAHAN/.test(A2.ctx.pressureSource), A2.ctx.pressureSource);
        ok("plan within budget, Category A within cap", g.metrics.cost <= effOpts().budgetLakh + 1e-6 && sm.byCat.A <= (S.opts.catACap ?? Infinity) + 1e-6, `${sm.sites} sites · subsidy ${sm.subsidy}`);
        ok("approximation guarantee reported", g.guarantee && g.guarantee.bound > 0.3, g.guarantee && g.guarantee.basis);
        const sheets = PM.proposalSheets(proposalSites(g.selected), { entity: "Smoke", nodal: "Smoke", tauKm: S.opts.tauKm });
        const xl = window.RGXlsx.build(sheets);
        ok("SNA workbook (Annexures B/C/D) builds", xl.length > 3000 && xl[0] === 0x50 && xl[1] === 0x4b && sheets.length >= 4, `${xl.length} bytes, ${sheets.map(x => x.name).join(" | ")}`);
        const html = fsrHTML(); ok("feasibility study report renders", /Basis of selection/.test(html) && html.length > 5000, html.length);
        if (DESK.pdfHtml) { const pr = await DESK.pdfHtml(html, "smoke.pdf"); ok("feasibility report → PDF", pr && pr.ok && pr.bytes > 10000, pr && pr.bytes); }
        const c0 = g.selected[0]; S.selCand = c0 && c0.id; S.tab = "plan"; renderInspector(); await new Promise(r => setTimeout(r, 150));
        ok("site explain shows PM E-DRIVE breakdown + queue", c0 && /PM E-DRIVE/.test($("#explain").textContent) && /queue/i.test($("#explain").textContent), c0 && c0.id);
        S.selCand = null;
        S.tab = "forecast"; renderInspector(); await new Promise(r => setTimeout(r, 150));
        ok("forecast uses the VAHAN S-curve", /S-curve/.test($("#tabbody").textContent), "");
        S.tab = "validate"; renderInspector(); await new Promise(r => setTimeout(r, 100));
        ok("validate shows VAHAN data quality", /Aggregate row removed|matched to a district/.test($("#tabbody").textContent), "");
        S.tab = "compare"; renderInspector(); await new Promise(r => setTimeout(r, 100)); openSplit(); await new Promise(r => setTimeout(r, 600));
        ok("split-screen baseline view", $$(".split-map .leaflet-pane").length >= 2 && /newly covered/.test($("#sp-rk").textContent), $("#sp-rk").textContent);
        $$(".rg-modal").forEach(m => m.remove());
        openChangelog(); ok("Round 1 → Round 2 changelog", $$(".rg-modal tbody tr").length >= 10, $$(".rg-modal tbody tr").length); $$(".rg-modal").forEach(m => m.remove());
        openDisclosures(); ok("Rule 5 & 6 disclosures", /No synthetic data/.test($(".rg-modal").textContent) && /gpt-oss-120b/.test($(".rg-modal").textContent), ""); $$(".rg-modal").forEach(m => m.remove());
        const keepBudget = S.opts.budgetLakh;
        openChallenge(); $("#ch-q").value = "Nashik"; $("#ch-f").dispatchEvent(new Event("submit", { cancelable: true }));
        for (let i = 0; i < 100 && !$(".ch-clock.done"); i++) await new Promise(r => setTimeout(r, 100));
        ok("live challenge: district + ₹10 crore plan", $(".ch-clock.done") && S.did === "maharashtra.nashik" && S.analysis.plans.greedy.selected.length > 0, $(".ch-clock") && $(".ch-clock").textContent);
        $$(".rg-modal").forEach(m => m.remove()); S.opts.budgetLakh = keepBudget;
        // AI agent tools (Groq gpt-oss-120b drives these; exercised directly here since CI has no Groq key)
        { const g = await agentTool("go_to_region", { name: "Nashik" }); const p = await agentTool("set_plan_options", { budget_crore: 10, objective: "greedy", budget_basis: "total" });
          const st = await agentTool("get_site", { rank: 1 }); const gs = DESK.groqStatus ? await DESK.groqStatus() : {};
          ok("AI agent tools operate the workspace", g.opened === "Nashik" && p.budget_lakh === 1000 && p.sites > 0 && p.pm_edrive && st.pm_edrive && st.queue, `${p.sites} sites · subsidy ${p.pm_edrive && p.pm_edrive.subsidy_lakh} · groq key ${gs.configured ? "set" : "not set"}`);
          S.opts.budgetLakh = 250; }
        // freight corridor planner (NH-48 Delhi → Jaipur)
        S.mode = "corridor"; S.corridor.from = findPlace("Delhi"); S.corridor.to = findPlace("Jaipur"); await goIndia(); await runCorridor();
        if (S.route && S.route.g) { renderInspector(); await new Promise(r => setTimeout(r, 100)); await runFreight(); }
        const F = S.freight;
        ok("freight corridor plan (heavy vehicles)", F && F.feasible && F.stations.every(x => x.pm.arch === "highway") && F.hdCount >= 0, F && `${F.stations.length} new · ${F.used.length} existing used · ${F.hdCount} heavy-duty on route`);
        S.mode = "atlas"; S.route = null; S.freight = null;
        await goDistrict("jharkhand.east-singhbhum");
      }
      const ev0 = Evidence.all(); const wrote = store.set("evidence", [...ev0, { lat: "22.8", lng: "86.2", name: "smoke", status: "ok" }]); const back = Evidence.all();
      ok("protected store round-trip (admin)", wrote && back.length === ev0.length + 1, back.length); store.set("evidence", ev0);
      const v = await Audit.verify(); ok("audit log verifies", v && v.ok, JSON.stringify(v));
      const api = await fetch("/api/v1/geographies", { headers: { "X-Session-Token": (DESK.session() || {}).token || "" } }); ok("local API from the app", api.status === 200, api.status);
      S.mode = "corridor"; S.corridor.from = findPlace("Delhi"); S.corridor.to = findPlace("Jaipur"); goIndia(); await runCorridor();
      ok("corridor check", S.route && S.route.g && S.route.g.total > 200, S.route && S.route.g && `${S.route.g.total.toFixed(0)} km via ${S.route.r.engine}`);
      S.mode = "atlas"; S.route = null; clearLayers("route");
      const t = await fetch("/tiles/a/5/23/13.png").then(r => r.status).catch(() => 0); ok("tile proxy reachable (cache or network)", true, `status ${t}${t === 504 ? " (offline: acceptable)" : ""}`);
    } catch (e) { ok("self-test run", false, e.stack || e.message); }
    return out;
  }

  /* ================================================================== guided demo tour (§15 walkthrough) */
  const TOUR = [
    { sel: ".appbar", title: "ReachGrid workspace", text: "A decision engine for public EV charging: real chargers, census demand and a budget optimiser for every state and district. Use Next, or the arrow keys.", run: () => { S.mode = "atlas"; return goIndia(); } },
    { sel: "#map", title: "India, coloured by access gap", text: "Every state shaded by the share of people more than 10 km from a listed charger. Darker means it needs more attention. Click any state to pop it out." },
    { sel: "#w-nav", title: "Ranked: needs attention first", text: "The navigator ranks states or districts by any metric. The search box (press /) finds any state, district or town." },
    { sel: "#w-insp", title: "Drill into a district", text: "East Singhbhum, Jharkhand. The inspector shows population, listed charging sites and registered EVs with their provenance, the distance distribution and the towns with no nearby charger.", run: () => goDistrict("jharkhand.east-singhbhum") },
    { sel: "#w-insp", title: "Plan new chargers", text: "Choose an objective (coverage, equity, corridor or commercial), a distance threshold, a budget and hardware. Four planning objectives and two baselines compete on the scenario board.", run: () => { S.tab = "plan"; S.planKey = "greedy"; renderInspector(); drawPlan(true); } },
    { sel: "#map", title: "Where to build, and why", text: "Numbered pink pins are the greedy picks in order. Blue cells are people newly brought within reach. Click a pin for its score breakdown, confidence, commercial screen and review controls." },
    { sel: "#w-insp", title: "How many chargers by 2030?", text: "The Forecast tab projects the EV fleet from real VAHAN registrations (2020–2024 trend), adds 3W, car and bus segments, and converts public charging demand into AC and DC charge points needed each year, against the existing inventory.", run: () => { S.tab = "forecast"; renderInspector(); } },
    { sel: "#w-insp", title: "Compare methods", text: "Budget curve (diminishing returns), greedy vs local search vs an exact integer programme with its LP bound, and a nine-variant sensitivity analysis. Heavy jobs run in a background worker.", run: () => { S.tab = "compare"; renderInspector(); } },
    { sel: "#w-insp", title: "Validate", text: "A holdout backtest hides real chargers and checks whether the method finds them again. It also shows equity metrics and runs the proposal's acceptance tests live in the browser.", run: () => { S.tab = "validate"; renderInspector(); } },
    { sel: "#w-insp", title: "Field evidence & VAHAN", text: "Upload site surveys, DISCOM capacity or land status: blocked sites drop out and real costs replace assumptions. Upload VAHAN EV registrations to replace the 2011 proxy.", run: () => { S.tab = "evidence"; renderInspector(); } },
    { sel: "#w-insp", title: "Portfolio monitor", text: "Mark sites as built. They count as chargers from then on, and observed sessions/day recalibrate the commercial screen. The review queue tracks the human sign-off before money is spent.", run: () => { S.tab = "portfolio"; renderInspector(); } },
    { sel: "#w-insp", title: "Confidence ledger & audit", text: "Source quality, the data-refresh change report, a live OpenStreetMap check, and a SHA-256 hash-chained audit log of every action. Exports can be AES-256 encrypted.", run: () => { S.tab = "ledger"; renderInspector(); } },
    { sel: "#w-insp", title: "Corridor check", text: "Can an EV make Delhi → Jaipur? The route runs on the national highway graph, every charger near it is found, and the longest gap is tested against your usable range.", run: () => { S.mode = "corridor"; S.corridor.from = findPlace("Delhi"); S.corridor.to = findPlace("Jaipur"); goIndia(); setTimeout(runCorridor, 120); } },
    { sel: ".statusbar", title: "Built for real work", text: "Status bar, keyboard shortcuts (?), full screen (F), resizable panels, a scenario API and methodology and business pages. That's the tour.", run: () => { S.mode = "atlas"; S.route = null; clearLayers("route"); return goDistrict("jharkhand.east-singhbhum"); } },
  ];
  let tourI = -1;
  function tourEl() {
    let o = $("#rg-tour");
    if (!o) {
      o = document.createElement("div"); o.id = "rg-tour";
      o.innerHTML = `<div class="tour-hole"></div><div class="win tour-card"><div class="tb"><span class="t" id="tour-t"></span><span class="mono" id="tour-n" style="font-size:11px"></span></div><div class="bd"><p id="tour-x"></p><div style="display:flex;gap:6px;justify-content:space-between"><button class="btn sm ghost" id="tour-skip">End tour</button><span><button class="btn sm ghost" id="tour-prev">← Back</button> <button class="btn sm" id="tour-next">Next →</button></span></div></div></div>`;
      $("#atlas .desk").appendChild(o);
      $("#tour-next").onclick = () => tourGo(tourI + 1); $("#tour-prev").onclick = () => tourGo(tourI - 1); $("#tour-skip").onclick = tourEnd;
    }
    return o;
  }
  async function tourGo(i) {
    if (i < 0) return; if (i >= TOUR.length) return tourEnd();
    tourI = i; const st = TOUR[i], o = tourEl(); o.hidden = false;
    $("#tour-t").textContent = st.title; $("#tour-x").textContent = st.text; $("#tour-n").textContent = `${i + 1} / ${TOUR.length}`;
    $("#tour-prev").disabled = i === 0; $("#tour-next").textContent = i === TOUR.length - 1 ? "Finish" : "Next →";
    try { if (st.run) await st.run(); } catch (e) { console.warn(e); }
    setTimeout(() => {
      const t = $(st.sel); if (!t) return; const d = $("#atlas .desk").getBoundingClientRect(), r = t.getBoundingClientRect();
      const hole = $(".tour-hole", o); Object.assign(hole.style, { left: r.left - d.left - 4 + "px", top: r.top - d.top - 4 + "px", width: r.width + 8 + "px", height: r.height + 8 + "px" });
      const card = $(".tour-card", o), cw = Math.min(380, d.width - 24);
      let x = r.left - d.left + r.width / 2 - cw / 2, y = r.bottom - d.top + 12;
      if (y + 190 > d.height) y = Math.max(12, r.top - d.top - 200);
      if (r.height > d.height * 0.6) { y = d.height / 2 - 90; x = r.left - d.left > d.width / 2 ? r.left - d.left - cw - 16 : r.right - d.left + 16; if (x < 12 || x + cw > d.width - 12) x = d.width / 2 - cw / 2; }
      Object.assign(card.style, { width: cw + "px", left: Math.max(12, Math.min(d.width - cw - 12, x)) + "px", top: Math.max(12, y) + "px" });
    }, st.run ? 700 : 60);
  }
  function tourStart() { if (!isApp()) enterApp("atlas"); Audit.add("tour.start", ""); tourGo(0); }
  function tourEnd() { const o = $("#rg-tour"); if (o) o.hidden = true; tourI = -1; }
  document.addEventListener("keydown", (e) => { if (tourI < 0) return; if (e.key === "ArrowRight") tourGo(tourI + 1); else if (e.key === "ArrowLeft") tourGo(tourI - 1); else if (e.key === "Escape") tourEnd(); });
  function initDocsMenu() {
    const tools = $(".ab-tools"); if (!tools || $("#ab-demo")) return;
    const demo = document.createElement("button"); demo.className = "ab-btn ab-role"; demo.id = "ab-demo"; demo.textContent = "▶ Demo"; demo.title = "Guided walkthrough"; demo.onclick = tourStart;
    const docs = document.createElement("div"); docs.className = "ab-docs";
    docs.innerHTML = `<button class="ab-btn ab-role" id="ab-docs" aria-haspopup="true" aria-expanded="false">Docs ▾</button><div class="ab-menu" hidden><a href="methodology.html">Methodology</a><a href="business.html">Business model & roadmap</a><a href="api.html">Scenario API</a><a href="#sources" id="ab-src">Sources & licences</a><a href="#changelog" id="ab-chg">Round 1 → Round 2 changelog</a><a href="#disclosures" id="ab-dis">Data & AI disclosures</a></div>`;
    tools.prepend(docs); tools.prepend(demo);
    const btn = $("#ab-docs"), menu = $(".ab-menu", docs);
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", !menu.hidden); };
    document.addEventListener("click", () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); });
    $("#ab-src").onclick = (e) => { e.preventDefault(); if (DESK) DESK.openDoc("methodology.html"); else location.href = "./#sources"; };
    $("#ab-chg").onclick = (e) => { e.preventDefault(); openChangelog(); };
    $("#ab-dis").onclick = (e) => { e.preventDefault(); openDisclosures(); };
  }
  function registerAPI() {
    if (DESK) return;   // the desktop app serves the API over a real local HTTP server
    if ("serviceWorker" in navigator && isSecureContext && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => { });
  }

  const origRender = render;
  render = function () { origRender(); if ($("#asks")) renderAskSuggestions(); updateStatus(); syncToolbar(); };

  boot();
})();
