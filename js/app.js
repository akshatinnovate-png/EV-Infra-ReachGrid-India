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
  const store = { get(k, d) { try { const v = localStorage.getItem("rg_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem("rg_" + k, JSON.stringify(v)); } catch { } } };
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
    } catch (e) {
      bootStep.textContent = "Failed: " + e.message + ". Serve the folder over http (see README).";
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
    tiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { subdomains: "abcd", maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' });
    map.attributionControl.setPrefix('<a href="#sources">ReachGrid data sources</a>');
    ["context", "base", "roads", "cells", "route", "chargers", "places", "cands", "sites", "osm"].forEach(k => { G[k] = L.layerGroup().addTo(map); });
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
      L.marker([c[0], c[1]], { icon: L.divIcon({ className: "", html: `<div class="charger-sq ${isDC(c) ? "" : "ac"}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }), keyboard: false }).bindPopup(chargerPopup(c)).addTo(G.chargers);
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
    clearLayers("sites", "cands");
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
    if (!["overview", "plan", "chargers", "ledger"].includes(S.tab)) S.tab = "overview";
    if (S.tab === "plan") S.tab = "overview";
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
    return { india: INDIA, stateData: curState(), roads: ROADS, districtIds: S.level === "district" ? [S.did] : null, opts };
  }
  function runAnalysis(withPlans = true) {
    const t0 = performance.now();
    const { ctx, cands } = Rg.analyse(analysisArgs());
    const plans = E.runScenarios(ctx, cands, effOpts());
    S.analysis = { ctx, cands, plans, ms: performance.now() - t0, key: scenarioKey() };
    return S.analysis;
  }
  function scenarioKey() {
    const o = S.opts;
    return fnv(JSON.stringify([INDIA.version, S.sid, S.did, o.tauKm, o.detour, o.chargerFilter, effOpts().budgetLakh, o.hardware, o.hardwareCost, o.siteCost, o.weights]));
  }
  const rerun = debounce(() => {
    store.set("opts", S.opts);
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
    const T = [["overview", "Overview"], ["plan", "Plan"], ["sens", "Sensitivity"], ["chargers", "Chargers"], ["ledger", "Ledger"]];
    el.innerHTML = tabs(T) + `<div id="tabbody"></div>`;
    bindTabs(el);
    const tb = $("#tabbody");
    if ((S.tab === "plan" || S.tab === "sens") && !S.analysis) {
      tb.innerHTML = `<p class="sub">Building demand cells, candidate sites and plans for ${esc(name)}…</p>`;
      setTimeout(() => { runAnalysis(); drawPlan(true); if (S.level === "state") drawCells(); renderInspector(); updateStatus(); }, 30);
      return;
    }
    ({ overview: tabOverview, plan: tabPlan, sens: tabSens, chargers: tabChargers, ledger: tabLedger }[S.tab] || tabOverview)(tb, name);
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
      <div class="hdr"><span>Largest operators (sites)</span></div>${operatorsBars(T.operators)}
      <div class="note">Counts are listed public sites from 8 merged sources. They are not operational counts and are not added to official PCS totals, which use different definitions.</div>`;
    $$("[data-d]", el).forEach(r => r.onclick = () => goDistrict(r.dataset.d));
  }

  function tabOverview(tb, name) {
    const isD = S.level === "district";
    const st = isD ? statOf(S.did) : INDIA.stateById.get(S.sid).stats;
    let html = `<div class="big-name">${esc(name)}</div><div class="sub" style="margin-bottom:8px">${isD ? esc(INDIA.stateById.get(S.sid).name) + " · " : ""}${nIN(st.area)} km² · ${isD ? provenance(st) : `${st.districts} districts, ${st.imputed_districts} with apportioned census`}</div>`;
    html += kpiGrid(st, [[pct(st.car_rate), "households with car"], [pct(st.tw_rate), "with 2-wheeler"], [st.km2_per_charger ? nIN(st.km2_per_charger) + " km²" : "—", "area per charger"]]);
    if (isD && S.analysis) {
      const h = E.histogram(S.analysis.ctx.cells, S.analysis.ctx.base.dist), max = Math.max(...h.values);
      const labels = ["0–2 km", "2–5", "5–10", "10–15", "15–25", "25–50", "50+ km"];
      html += `<div class="hdr"><span>Where people are vs nearest charger</span><span class="sub">detour ×${S.opts.detour}</span></div>${h.values.map((v, i) => `<div class="hist"><span>${labels[i]}</span><div class="minibar"><i style="width:${(v / max) * 100}%;background:${i < 3 ? "#1b1b1d" : PAL[Math.min(5, i)]}"></i></div><span>${pct(v / h.total, 0)}</span></div>`).join("")}`;
      const d = curDistrict(), idx = Rg.chargerIndex(INDIA, "all");
      html += `<div class="hdr"><span>Towns & nearest charger</span><span class="sub">GeoNames</span></div><table class="t"><thead><tr><th>Town</th><th class="n">Population</th><th class="n">Nearest</th></tr></thead><tbody>${d.places.slice(0, 12).map(([n, lon, lat, p]) => { const near = idx.nearest(lat, lon, 400); return `<tr class="click" data-ll="${lat},${lon}"><td>${esc(n)}</td><td class="n">${nIN(p)}</td><td class="n" style="color:${near && near.d > S.opts.tauKm ? "var(--bad)" : "inherit"}">${near ? km(near.d) : "—"}</td></tr>`; }).join("")}</tbody></table>`;
    }
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
        <label class="f"><span class="row"><span>Access threshold τ</span><b>${o.tauKm} km</b></span><input type="range" min="2" max="50" step="1" value="${o.tauKm}" data-o="tauKm"></label>
        <label class="f"><span class="row"><span>Road detour factor</span><b>×${o.detour}</b></span><input type="range" min="1" max="1.8" step="0.05" value="${o.detour}" data-o="detour"></label>
        ${S.level === "state" ? `<label class="f"><span class="row"><span>State budget</span><b>${rupL(effOpts().budgetLakh)}</b></span><input type="range" min="100" max="20000" step="50" value="${effOpts().budgetLakh}" data-o="budgetStateLakh"></label>` : `<label class="f"><span class="row"><span>Budget</span><b>${rupL(o.budgetLakh)}</b></span><input type="range" min="20" max="2000" step="10" value="${o.budgetLakh}" data-o="budgetLakh"></label>`}
        <label class="f">Hardware per site<select data-o="hardware"><option value="dc60" ${o.hardware === "dc60" ? "selected" : ""}>DC 60 kW (${rupL(o.hardwareCost.dc60)})</option><option value="dc30" ${o.hardware === "dc30" ? "selected" : ""}>DC 30 kW (${rupL(o.hardwareCost.dc30)})</option><option value="ac22" ${o.hardware === "ac22" ? "selected" : ""}>AC 22 kW ×2 (${rupL(o.hardwareCost.ac22)})</option></select></label>
      </div>
      <label class="f">Existing chargers that count<select data-o="chargerFilter"><option value="all" ${o.chargerFilter === "all" ? "selected" : ""}>All listed sites</option><option value="dc" ${o.chargerFilter === "dc" ? "selected" : ""}>DC fast only (≥15 kW or DC guns)</option><option value="verified" ${o.chargerFilter === "verified" ? "selected" : ""}>Confirmed by ≥2 sources only</option></select></label>
      <details><summary class="mono" style="cursor:pointer;font-size:11.5px">Score weights & cost assumptions</summary>
        ${Object.keys(o.weights).map(k => `<label class="f"><span class="row"><span>${k}</span><b>${o.weights[k].toFixed(2)}</b></span><input type="range" min="0" max="0.6" step="0.05" value="${o.weights[k]}" data-w="${k}"></label>`).join("")}
        <div class="grid2">${Object.keys(o.siteCost).map(k => `<label class="f">Site cost: ${k} (₹ L)<input type="number" min="0" step="1" value="${o.siteCost[k]}" data-sc="${k}"></label>`).join("")}</div>
        <button class="linkbtn" id="reset-opts">Reset to proposal defaults</button>
        <p class="sub">Costs are planning assumptions, not quotes. Grid connection costs vary widely and are unknown until a DISCOM study.</p>
      </details>`;
    const rows = Object.entries(P).map(([k, p]) => {
      const m = p.metrics;
      return `<div class="brow ${k === S.planKey ? "active" : ""}"><div class="top"><button class="nm" data-plan="${k}">${esc(p.name)}</button><span class="v">${pct(m.coverage)}</span></div>
        <div class="rail"><s style="left:${A.ctx.base.coverage * 100}%" title="baseline"></s><i style="left:${m.coverage * 100}%"></i></div>
        <small>${m.sites} sites · ${rupL(m.cost)} · +${people(m.newlyCovered)} covered · ${m.costPerPerson ? rup(m.costPerPerson) + "/person" : "—"} · worst-served reached ${pct(m.worstServed, 0)}</small></div>`;
    }).join("");
    const plan = P[S.planKey];
    const sites = plan.selected.map((c, i) => {
      const step = plan.steps[i];
      return `<div class="siteRow ${S.selCand === c.id ? "on" : ""}" data-c="${c.id}"><div class="num">${i + 1}</div><div><b>${esc(c.label)}</b><br><span class="sub">${esc(c.host)} · score ${c.score.toFixed(0)}${c.missing.length ? ` · <span title="renormalised">${c.missing.length} unknown</span>` : ""}${step ? ` · +${people(step.gain)} ${S.planKey === "equity" ? "weighted " : ""}covered` : ""}</span></div><div style="text-align:right">${rupL(c.cost)}<br><span class="tag ${({ High: "obs", Medium: "der", Low: "imp" })[E.confidenceFor(c, A.ctx).grade]}">${E.confidenceFor(c, A.ctx).grade}</span></div></div>`;
    }).join("") || `<p class="sub">No candidate adds coverage within this budget. Try a larger budget or threshold.</p>`;
    tb.innerHTML = `${ctrl}
      <div class="hdr"><span>Scenario board · baseline ${pct(A.ctx.base.coverage)}</span><span class="sub">${A.cands.length} candidates · ${A.ms.toFixed(0)} ms</span></div>
      <div class="board">${rows}</div>
      <div class="hdr"><span>${esc(plan.name)} · shortlist</span><span class="sub">id ${A.key}</span></div>
      <div id="explain"></div>
      <div>${sites}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
        <button class="btn sm" data-x="csv">Shortlist CSV</button><button class="btn sm" data-x="geojson">GeoJSON</button><button class="btn sm" data-x="json">Scenario JSON</button><button class="btn sm ghost" data-x="save">Save scenario</button><button class="btn sm ghost" data-x="print">Print report</button>
      </div>
      ${savedScenariosHTML()}
      <div class="note">Shortlist for field validation, not a construction decision. Each site still needs land, DISCOM grid capacity, permits and demand checks.</div>`;
    $$("input[data-o],select[data-o]", tb).forEach(i => i.addEventListener("input", () => { const k = i.dataset.o; S.opts[k] = i.type === "range" ? +i.value : i.value; i.closest("label").querySelector("b") && (i.closest("label").querySelector("b").textContent = k === "budgetLakh" || k === "budgetStateLakh" ? rupL(+i.value) : k === "tauKm" ? i.value + " km" : k === "detour" ? "×" + i.value : ""); rerun(); }));
    $$("input[data-w]", tb).forEach(i => i.addEventListener("input", () => { S.opts.weights = { ...S.opts.weights, [i.dataset.w]: +i.value }; i.closest("label").querySelector("b").textContent = (+i.value).toFixed(2); rerun(); }));
    $$("input[data-sc]", tb).forEach(i => i.addEventListener("change", () => { S.opts.siteCost = { ...S.opts.siteCost, [i.dataset.sc]: Math.max(0, +i.value || 0) }; rerun(); }));
    $("#reset-opts").onclick = () => { S.opts = { ...E.DEFAULTS, weights: { ...E.DEFAULTS.weights } }; rerun(); };
    $$("[data-plan]", tb).forEach(b => b.onclick = () => { S.planKey = b.dataset.plan; drawPlan(true); renderInspector(); });
    $$("[data-c]", tb).forEach(r => r.onclick = () => selectCand(r.dataset.c));
    $$("[data-x]", tb).forEach(b => b.onclick = () => exportPlan(b.dataset.x));
    $$("[data-load]", tb).forEach(b => b.onclick = () => { const s = store.get("scenarios", []).find(x => x.id === b.dataset.load); if (s) { S.opts = { ...E.DEFAULTS, ...s.opts }; S.planKey = s.plan; if (s.region.did && s.region.did !== S.did) goDistrict(s.region.did).then(rerun); else rerun(); } });
    $$("[data-del]", tb).forEach(b => b.onclick = () => { store.set("scenarios", store.get("scenarios", []).filter(x => x.id !== b.dataset.del)); renderInspector(); });
    if (S.selCand) showExplain(S.selCand);
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
        <li>${nIN(c.raw.vehicleHH)} vehicle-owning households in reach (Census 2011 rates) · ${c.raw.localChargers} existing sites in reach</li>
        <li>Nearest mapped highway ${isFinite(c.raw.roadKm) ? km(c.raw.roadKm) : "far"}${c.placePop ? ` · ${esc(c.place)} pop. ${nIN(c.placePop)}` : ""}</li>
      </ul>
      <div class="hdr"><span>Confidence: ${conf.grade}</span><span class="sub">separate from score</span></div>
      ${conf.parts.map(([n, v, t]) => `<div class="comp"><span>${esc(n)}</span><div class="minibar"><i style="width:${v * 100}%;background:${v >= 0.7 ? "var(--good)" : v >= 0.5 ? "var(--warn)" : "var(--bad)"}"></i></div><span title="${esc(t)}">${Math.round(v * 100)}</span></div><div class="sub" style="margin:-2px 0 4px 98px;font-size:10.5px">${esc(t)}</div>`).join("")}
      <div style="margin-top:6px"><a class="linkbtn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=16/${c.lat}/${c.lng}">Inspect site on OpenStreetMap ↗</a></div></div>`;
    $("#x-close").onclick = () => { S.selCand = null; el.innerHTML = ""; $$(".siteRow").forEach(r => r.classList.remove("on")); };
  }

  function regionName() { return S.level === "district" ? `${INDIA.districtById.get(S.did).name}, ${INDIA.stateById.get(S.sid).name}` : INDIA.stateById.get(S.sid).name; }
  function scenarioRecord() {
    const A = S.analysis, plan = A.plans[S.planKey];
    return {
      scenario_id: A.key, created_at: new Date().toISOString(), tool: "ReachGrid India", data_build: INDIA.version,
      region: { level: S.level, sid: S.sid, did: S.did, name: regionName() },
      assumptions: { threshold_km: S.opts.tauKm, distance_metric: `haversine × detour ${S.opts.detour}`, counted_chargers: S.opts.chargerFilter, budget_lakh: effOpts().budgetLakh, hardware: S.opts.hardware, hardware_cost_lakh: S.opts.hardwareCost, site_cost_lakh: S.opts.siteCost, score_weights: S.opts.weights, demand: "Census 2011 population on hex cells (derived)" },
      baseline: { coverage: A.ctx.base.coverage, mean_distance_km: A.ctx.base.meanDist, population: A.ctx.base.total },
      plans: Object.fromEntries(Object.entries(A.plans).map(([k, p]) => [k, { name: p.name, sites: p.metrics.sites, cost_lakh: p.metrics.cost, coverage: p.metrics.coverage, newly_covered: p.metrics.newlyCovered, cost_per_person_rs: p.metrics.costPerPerson, worst_served_reached: p.metrics.worstServed, selected: p.selected.map(c => c.id) }])),
      selected_plan: S.planKey,
      shortlist: plan.selected.map((c, i) => ({ rank: i + 1, id: c.id, label: c.label, host: c.host, lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), cost_lakh: c.cost, score: +c.score.toFixed(2), components: c.comp, unknown_components: c.missing, confidence: E.confidenceFor(c, A.ctx).grade })),
      sources: INDIA.sources.map(s => ({ id: s.id, title: s.title, licence: s.licence, sha256: s.sha256 || null })),
      caveats: ["Model output, not a guarantee of utilisation or social impact.", "Grid capacity, land, permits and safety are not assessed.", "Charger listings are not verified as operational."],
    };
  }
  function download(name, text, type) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function exportPlan(kind) {
    const rec = scenarioRecord(), base = `reachgrid_${slug(rec.region.name)}_${rec.scenario_id}`;
    if (kind === "json") download(base + ".json", JSON.stringify(rec, null, 2), "application/json");
    if (kind === "csv") {
      const h = ["rank", "id", "label", "host", "lat", "lng", "cost_lakh", "score", "gap", "pressure", "corridor", "equity", "feasibility", "unknown_components", "confidence", "scenario_id"];
      download(base + ".csv", [h.join(","), ...rec.shortlist.map(s => [s.rank, s.id, s.label, s.host, s.lat, s.lng, s.cost_lakh, s.score, ...["gap", "pressure", "corridor", "equity", "feasibility"].map(k => s.components[k] == null ? "" : s.components[k].toFixed(1)), s.unknown_components.join("|"), s.confidence, rec.scenario_id].map(csvCell).join(","))].join("\n"), "text/csv");
    }
    if (kind === "geojson") download(base + ".geojson", JSON.stringify({ type: "FeatureCollection", properties: { scenario_id: rec.scenario_id, region: rec.region.name }, features: rec.shortlist.map(s => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lng, s.lat] }, properties: s })) }), "application/geo+json");
    if (kind === "save") { const list = store.get("scenarios", []).filter(x => x.id !== rec.scenario_id); list.push({ id: rec.scenario_id, region: rec.region, opts: S.opts, plan: S.planKey, planName: rec.plans[S.planKey].name, metrics: rec.plans[S.planKey] }); store.set("scenarios", list.slice(-30)); renderInspector(); }
    if (kind === "print") window.print();
  }

  /* ---------- sensitivity ---------- */
  function tabSens(tb) {
    if (!S.sens) {
      tb.innerHTML = `<p>Re-runs the greedy plan under nine alternative assumptions (threshold, detour, costs, weights) and reports how much the shortlist changes.</p><button class="btn sm" id="run-sens">Run sensitivity analysis</button>`;
      $("#run-sens").onclick = () => { tb.innerHTML = `<p class="sub">Running 9 scenarios…</p>`; setTimeout(() => { S.sens = E.sensitivity(o => Rg.analyse(analysisArgs(o)), effOpts()); tabSens(tb); }, 30); };
      return;
    }
    const st = S.sens, stable = st.slice(1).filter(r => r.overlap >= 0.5).length;
    tb.innerHTML = `<div class="hdr"><span>Shortlist stability</span><span class="sub">Jaccard overlap vs base</span></div>
      <table class="t"><thead><tr><th>Variant</th><th class="n">Baseline</th><th class="n">With plan</th><th class="n">Sites</th><th class="n">Overlap</th></tr></thead><tbody>${st.map(r => `<tr><td>${esc(r.name)}</td><td class="n">${pct(r.baseCoverage)}</td><td class="n">${pct(r.coverage)}</td><td class="n">${r.sites}</td><td class="n" style="color:${r.overlap >= 0.5 ? "var(--good)" : "var(--bad)"}">${pct(r.overlap, 0)}</td></tr>`).join("")}</tbody></table>
      <div class="note ${stable >= 6 ? "" : "warnnote"}">${stable}/8 variants keep at least half the shortlist. ${stable >= 6 ? "Rankings are fairly robust to the assumptions tested." : "Rankings are sensitive to assumptions; treat individual sites as hypotheses and validate the overlapping ones first."}</div>
      <div class="sub">Greedy vs score-only overlap at base: ${pct(st[0].scoreOverlap, 0)}. Low overlap means the marginal-gain method picks a different set than plain ranking does.</div>
      <button class="btn sm ghost" id="rerun-sens" style="margin-top:8px">Re-run</button>`;
    $("#rerun-sens").onclick = () => { S.sens = null; tabSens(tb); };
  }

  /* ---------- chargers tab ---------- */
  function tabChargers(tb) {
    const sd = curState(), ds = S.level === "district" ? [curDistrict()] : sd.districts;
    const all = ds.flatMap(d => d.chargers.map(c => ({ c, d: d.name })));
    const ops = [...new Set(all.map(x => x.c[3] || "Unknown"))].sort();
    tb.innerHTML = `<div class="grid2"><input type="search" id="cq" placeholder="Filter name / address…"><select id="cop"><option value="">All operators (${ops.length})</option>${ops.map(o => `<option>${esc(o)}</option>`).join("")}</select></div>
      <div style="display:flex;gap:10px;margin:6px 0;font-size:11.5px"><label><input type="checkbox" id="cdc"> DC only</label><label><input type="checkbox" id="cver"> ≥2 sources</label><span class="sub" id="ccount"></span></div>
      <div class="scroll" style="max-height:420px"><table class="t"><thead><tr><th>Station</th><th class="n">kW</th><th class="n">₹/kWh</th><th class="n">Src</th></tr></thead><tbody id="crows"></tbody></table></div>
      <div style="margin-top:8px"><button class="btn sm" id="cexp">Export CSV</button></div>`;
    let rows = [];
    const draw = () => {
      const q = norm($("#cq").value), op = $("#cop").value, dc = $("#cdc").checked, ver = $("#cver").checked;
      rows = all.filter(({ c }) => (!q || norm(c[2] + " " + c[11] + " " + c[10]).includes(q)) && (!op || (c[3] || "Unknown") === op) && (!dc || isDC(c)) && (!ver || c[8] >= 2));
      $("#ccount").textContent = `${nIN(rows.length)} of ${nIN(all.length)}`;
      $("#crows").innerHTML = rows.slice(0, 400).map(({ c, d }, i) => `<tr class="click" data-i="${i}"><td><b>${esc(c[2] || "Unnamed")}</b><br><span class="sub">${esc(c[3] || "Unknown")}${S.level === "state" ? " · " + esc(d) : ""}</span></td><td class="n">${c[4] ?? "—"}</td><td class="n">${(c[7].match(/[\d.]+/) || ["—"])[0]}</td><td class="n">${c[8]}</td></tr>`).join("") + (rows.length > 400 ? `<tr><td colspan="4" class="sub">Showing first 400; export for all.</td></tr>` : "");
      $$("#crows tr[data-i]").forEach(r => r.onclick = () => { const { c } = rows[+r.dataset.i]; map.flyTo([c[0], c[1]], 15); L.popup().setLatLng([c[0], c[1]]).setContent(chargerPopup(c)).openOn(map); });
    };
    ["cq", "cop", "cdc", "cver"].forEach(id => $("#" + id).addEventListener("input", draw)); draw();
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
      <ul style="padding-left:16px;margin:4px 0"><li>Operational status and uptime are not observed.</li><li>Distances are straight-line × detour, not routed.</li><li>Grid capacity, land and permits are unknown for every candidate.</li><li>Vehicle ownership uses 2011 household rates as a pressure proxy, not EV registrations.</li></ul>`;
    $("#osm-run").onclick = () => osmCheck(ds, $("#osm-out"));
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
  function runCorridor() {
    const C = S.corridor;
    if (!C.from || !C.to) { $("#insp-body").innerHTML = `<p>Pick both towns from the suggestions first.</p>`; return; }
    GRAPH ||= E.buildGraph(ROADS);
    const r = E.route(GRAPH, { lat: C.from[2], lng: C.from[1] }, { lat: C.to[2], lng: C.to[1] });
    if (!r) { S.route = { error: "No highway route found between these towns on the coarse network." }; renderInspector(); return; }
    const idx = Rg.chargerIndex(INDIA, C.dcOnly ? "dc" : "all");
    const g = E.corridorGaps(r.path, idx, { bufferKm: C.buffer, rangeKm: C.range, reservePct: C.reserve });
    S.route = { r, g, idx, from: C.from, to: C.to, opts: { ...C } };
    drawRoute(); renderInspector(); updateStatus();
  }
  function drawRoute() {
    clearLayers("route");
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
  }
  function renderCorridorInsp(el) {
    $("#insp-title").textContent = "Corridor report";
    if (!S.route) { el.innerHTML = `<div class="big-name">Can an EV make this trip?</div><p>Pick two towns or a preset. ReachGrid routes over the national highway graph, finds every listed charger within your detour limit and checks the longest charging gap against your car's usable range.</p><div class="note">Uses the real charger dataset (${nIN(INDIA.totals.chargers)} sites). Listing ≠ working charger: plan a backup.</div>`; return; }
    if (S.route.error) { el.innerHTML = `<p>${esc(S.route.error)}</p>`; return; }
    const { r, g, from, to, opts } = S.route;
    const W = 360, scale = W / g.total;
    const strip = `<svg viewBox="0 0 ${W} 46" width="100%" role="img" aria-label="Charging stops along the route"><rect x="0" y="18" width="${W}" height="10" fill="#fff" stroke="#1b1b1d"/>${g.gaps.map(gp => gp.km > g.usable * 0.6 ? `<rect x="${gp.from * scale}" y="18" width="${gp.km * scale}" height="10" fill="${gp.km > g.usable ? "#b11a52" : "#e44fbf"}"/>` : "").join("")}${g.stops.map(s => `<rect x="${s.at * scale - 1}" y="12" width="2" height="22" fill="#1b1b1d"/>`).join("")}${g.plan.map((s, i) => `<g><rect x="${s.at * scale - 7}" y="0" width="14" height="12" fill="#e44fbf" stroke="#1b1b1d"/><text x="${s.at * scale}" y="9.5" font-size="8" text-anchor="middle" fill="#fff" font-family="monospace">${i + 1}</text></g>`).join("")}<text x="0" y="44" font-size="9" font-family="monospace">${esc(from[0])}</text><text x="${W}" y="44" font-size="9" text-anchor="end" font-family="monospace">${esc(to[0])} · ${g.total.toFixed(0)} km</text></svg>`;
    el.innerHTML = `<div class="big-name">${esc(from[0])} → ${esc(to[0])}</div>
      <div class="sub">${g.total.toFixed(0)} km on mapped highways${r.snapFrom > 5 || r.snapTo > 5 ? ` (+${(r.snapFrom + r.snapTo).toFixed(0)} km to reach the network)` : ""}</div>
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
      <div class="note">Gaps over 60% of usable range are pink, over 100% red. Stops are listed sites, not verified as working.</div>`;
    $$("[data-ll]", el).forEach(tr => tr.onclick = () => { const [a, b] = tr.dataset.ll.split(","); map.flyTo([+a, +b], 13); });
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
      el.innerHTML = `<div class="lgrow"><span class="sw sq"></span>DC charger (listed)</div><div class="lgrow"><span class="sw hollow"></span>AC / power unknown</div>
        <div class="lgrow"><span class="sw" style="background:#fff"></span>Demand within ${t} km</div>
        <div class="lgrow"><span class="sw" style="background:${PAL[2]}"></span>${t}–${1.5 * t} km</div><div class="lgrow"><span class="sw" style="background:${PAL[4]}"></span>${2 * t}–${3 * t} km</div><div class="lgrow"><span class="sw" style="background:${PAL[5]}"></span>&gt; ${3 * t} km</div>
        <div class="lgrow"><span class="sw newcov"></span>Newly covered by plan</div><div class="lgrow"><span class="sw sel"></span>Proposed site (rank)</div>
        <div class="layers">${[["tiles", "street map"], ["cells", "demand cells"], ["chargers", "chargers"], ["places", "towns"], ["roads", "highways"], ["cands", "all candidates"], ["sites", "plan sites"]].map(([k, n]) => `<label><input type="checkbox" data-l="${k}" ${S.layers[k] ? "checked" : ""}> ${n}</label>`).join("")}</div>`;
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
      : A && S.level !== "india" ? `τ ${S.opts.tauKm} km · baseline <b>${pct(A.ctx.base.coverage)}</b> → plan <b>${pct(A.plans[S.planKey].metrics.coverage)}</b>`
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
      else if (/^[1-5]$/.test(k) && S.level !== "india" && S.mode !== "corridor") { S.tab = ["overview", "plan", "sens", "chargers", "ledger"][+k - 1]; renderInspector(); }
    });
    map.on("mousemove", e => { $("#sb-cursor").textContent = `${e.latlng.lat.toFixed(4)}°N ${e.latlng.lng.toFixed(4)}°E · z${map.getZoom().toFixed(1)}`; });
    initFloating();
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
  let sdkLoaded = null, apiKey = store.get("ak", null), chat = [];
  function initAsk() {
    const el = $("#ask-body");
    el.innerHTML = `<div class="chatlog" id="chatlog" aria-live="polite"></div>
      <div class="suggest" id="asks"></div>
      <form class="askbar" id="askform"><input id="askin" placeholder="Ask about any state or district…" autocomplete="off"><button aria-label="Send">↑</button></form>
      <details style="margin-top:8px;font-family:var(--sans);font-size:11.5px"><summary style="cursor:pointer">Claude answers ${apiKey ? "(connected)" : "(optional)"}</summary>
        <p style="margin:6px 0">Built-in answers use the loaded data. Add your Anthropic API key for open-ended questions. The key goes straight from your browser to api.anthropic.com and is stored only if you tick “remember”.</p>
        <div class="askbar"><input type="password" id="akey" placeholder="sk-ant-…" value="${apiKey ? "••••••••" : ""}"><button type="button" id="akeyset" aria-label="Save key">✓</button></div>
        <label><input type="checkbox" id="akrem" ${store.get("ak", null) ? "checked" : ""}> remember on this device</label> <button type="button" class="linkbtn" id="akclr">forget key</button></details>`;
    say("bot", "Hi! I'm working from the loaded data: 25k+ real chargers, census demand and the optimiser. Ask me where access is weakest, where to build next, or compare two places.");
    renderAskSuggestions();
    $("#askform").onsubmit = (e) => { e.preventDefault(); const q = $("#askin").value.trim(); if (!q) return; $("#askin").value = ""; ask(q); };
    $("#akeyset").onclick = () => { const v = $("#akey").value.trim(); if (v && !v.startsWith("•")) { apiKey = v; if ($("#akrem").checked) store.set("ak", v); say("bot", "Claude connected. Open questions now go to Claude with the current map context."); } };
    $("#akclr").onclick = () => { apiKey = null; store.set("ak", null); $("#akey").value = ""; say("bot", "Key forgotten."); };
  }
  function renderAskSuggestions() {
    const s = S.level === "india" ? ["Which districts have the worst access?", "Compare Kerala and Bihar", "Delhi to Jaipur by EV?"] : S.level === "state" ? ["Worst-served districts here?", "Who operates most chargers?", "Where should the next chargers go?"] : ["Where should the next chargers go?", "How reliable is this data?", "How many people are beyond 10 km?"];
    $("#asks").innerHTML = s.map(x => `<button type="button">${esc(x)}</button>`).join("");
    $$("#asks button").forEach(b => b.onclick = () => ask(b.textContent));
  }
  function say(who, text, small) {
    const log = $("#chatlog"), m = document.createElement("div");
    m.className = "msg " + (who === "me" ? "me" : ""); m.textContent = text;
    if (small) { const s = document.createElement("small"); s.textContent = small; m.appendChild(s); }
    log.appendChild(m); log.scrollTop = log.scrollHeight; return m;
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
  async function ask(q) {
    say("me", q);
    const local = localAnswer(q);
    if (!apiKey) { say("bot", local || "I can answer: worst/best access, where to build next, compare A and B, operators, tariffs, data reliability, counts, and “X to Y by EV”. For open questions, add an Anthropic API key below.", "built-in · from bundled data"); renderAskSuggestions(); return; }
    if (local && /compare|worst|best|where|operator|tariff|how many|to .* by ev/.test(norm(q))) { say("bot", local, "built-in · from bundled data"); }
    const m = say("bot", "…", "Claude · thinking");
    try {
      sdkLoaded ||= loadScript("vendor/anthropic-sdk.js");
      await sdkLoaded;
      const client = new window.AnthropicSDK({ apiKey, dangerouslyAllowBrowser: true });
      chat.push({ role: "user", content: `Context (JSON, from ReachGrid's loaded data):\n${JSON.stringify(contextForClaude())}\n\nQuestion: ${q}` });
      const stream = client.beta.messages.stream({
        model: "claude-opus-5-5", max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        output_config: { effort: "low" },
        system: "You are ReachGrid's planning assistant for EV charging access in India. Answer from the JSON context. Quote numbers with their caveats: chargers are listed sites, not verified operational; demand is Census 2011; distances are straight-line × detour. Never invent figures that are not in the context; say what data would be needed instead. Be concise: under 140 words, plain text, no markdown headings.",
        messages: chat.slice(-8),
      });
      let text = "";
      stream.on("text", (d) => { text += d; m.firstChild.textContent = text; $("#chatlog").scrollTop = 1e9; });
      const fin = await stream.finalMessage();
      if (fin.stop_reason === "refusal") { m.firstChild.textContent = "Claude declined this request. Try rephrasing, or use the built-in answers."; chat.pop(); return; }
      chat.push({ role: "assistant", content: fin.content.filter(b => b.type === "text") });
      m.lastChild.textContent = `Claude · ${fin.model}`;
    } catch (e) {
      chat.pop();
      m.firstChild.textContent = (local ? local + "\n\n" : "") + `(Claude unavailable: ${e.status === 401 ? "invalid API key" : e.message})`;
      m.lastChild.textContent = "built-in fallback";
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

  const origRender = render;
  render = function () { origRender(); if ($("#asks")) renderAskSuggestions(); updateStatus(); syncToolbar(); };

  boot();
})();
