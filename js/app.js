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
      if (qs.has("tour")) setTimeout(tourStart, 600);
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
  function runAnalysis(withPlans = true) {
    const t0 = performance.now();
    const { ctx, cands } = Rg.analyse(analysisArgs());
    const plans = E.runScenarios(ctx, cands, effOpts());
    S.analysis = { ctx, cands, plans, ms: performance.now() - t0, key: scenarioKey() };
    return S.analysis;
  }
  function scenarioKey() {
    const o = S.opts;
    return fnv(JSON.stringify([INDIA.version, S.sid, S.did, o.tauKm, o.detour, o.chargerFilter, effOpts().budgetLakh, o.hardware, o.hardwareCost, o.siteCost, o.weights, o.metric, o.commercial, Evidence.all().length, extraChargers().length, EVUpload.get() && EVUpload.get().at]));
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
    const T = [["overview", "Overview"], ["plan", "Plan"], ["compare", "Compare"], ["validate", "Validate"], ["evidence", "Evidence"], ["portfolio", "Portfolio"], ["chargers", "Chargers"], ["ledger", "Ledger"]];
    el.innerHTML = tabs(T) + `<div id="tabbody"></div>`;
    bindTabs(el);
    const tb = $("#tabbody");
    if (["plan", "compare", "validate", "evidence", "portfolio"].includes(S.tab) && !S.analysis) {
      tb.innerHTML = `<p class="sub">Building demand cells, candidate sites and plans for ${esc(name)}…</p>`;
      setTimeout(() => { runAnalysis(); drawPlan(true); if (S.level === "state") drawCells(); renderInspector(); updateStatus(); }, 30);
      return;
    }
    ({ overview: tabOverview, plan: tabPlan, compare: tabCompare, sens: tabCompare, validate: tabValidate, evidence: tabEvidence, portfolio: tabPortfolio, chargers: tabChargers, ledger: tabLedger }[S.tab] || tabOverview)(tb, name);
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
        <label class="f">Hardware per site<select data-o="hardware"><option value="dc60" ${o.hardware === "dc60" ? "selected" : ""}>DC 60 kW (${rupL(o.hardwareCost.dc60)})</option><option value="dc30" ${o.hardware === "dc30" ? "selected" : ""}>DC 30 kW (${rupL(o.hardwareCost.dc30)})</option><option value="ac22" ${o.hardware === "ac22" ? "selected" : ""}>AC 22 kW ×2 (${rupL(o.hardwareCost.ac22)})</option></select></label>
      </div>
      <label class="f">Existing chargers that count<select data-o="chargerFilter"><option value="all" ${o.chargerFilter === "all" ? "selected" : ""}>All listed sites</option><option value="dc" ${o.chargerFilter === "dc" ? "selected" : ""}>DC fast only (≥15 kW or DC guns)</option><option value="verified" ${o.chargerFilter === "verified" ? "selected" : ""}>Confirmed by ≥2 sources only</option></select></label>
      <details><summary class="mono" style="cursor:pointer;font-size:11.5px">Score weights & cost assumptions</summary>
        ${Object.keys(o.weights).map(k => `<label class="f"><span class="row"><span>${k}</span><b>${o.weights[k].toFixed(2)}</b></span><input type="range" min="0" max="0.6" step="0.05" value="${o.weights[k]}" data-w="${k}"></label>`).join("")}
        <div class="grid2">${Object.keys(o.siteCost).map(k => `<label class="f">Site cost: ${k} (₹ L)<input type="number" min="0" step="1" value="${o.siteCost[k]}" data-sc="${k}"></label>`).join("")}</div>
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
      return `<div class="siteRow ${S.selCand === c.id ? "on" : ""}" data-c="${c.id}"><div class="num">${i + 1}</div><div><b>${esc(c.label)}</b>${reviewBadge(c.id)}${c.evidence ? ` <span class="tag obs">evidence</span>` : ""}<br><span class="sub">${esc(c.host)} · score ${c.score.toFixed(0)}${c.missing.length ? ` · <span title="renormalised">${c.missing.length} unknown</span>` : ""}${step ? (step.unit ? ` · ${nIN(step.gain)} veh. HH captured` : ` · +${people(step.gain)} ${S.planKey === "equity" ? "weighted " : ""}covered`) : ""}</span></div><div style="text-align:right">${rupL(c.cost)}<br><span class="tag ${({ High: "obs", Medium: "der", Low: "imp" })[E.confidenceFor(c, A.ctx).grade]}">${E.confidenceFor(c, A.ctx).grade}</span></div></div>`;
    }).join("") || `<p class="sub">No candidate adds coverage within this budget. Try a larger budget or threshold.</p>`;
    tb.innerHTML = `${ctrl}
      <div class="hdr"><span>Scenario board · baseline ${pct(A.ctx.base.coverage)}</span><span class="sub">${A.cands.length} candidates · ${A.ms.toFixed(0)} ms</span></div>
      <div class="board">${rows}</div>
      <div class="hdr"><span>${esc(plan.name)} · shortlist</span><span class="sub">id ${A.key}</span></div>
      <div id="explain"></div>
      <div>${sites}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
        <button class="btn sm" data-x="csv">Shortlist CSV</button><button class="btn sm" data-x="geojson">GeoJSON</button><button class="btn sm" data-x="json">Scenario JSON</button><button class="btn sm ghost" data-x="save">Save scenario</button><button class="btn sm ghost" data-x="print">Print report</button><button class="btn sm ghost" data-x="enc">Encrypted export</button>
      </div>
      ${savedScenariosHTML()}
      <div class="note">Shortlist for field validation, not a construction decision. Each site still needs land, DISCOM grid capacity, permits and demand checks.</div>`;
    $$("input[data-o],select[data-o]", tb).forEach(i => i.addEventListener("input", () => { const k = i.dataset.o; S.opts[k] = i.type === "range" ? +i.value : i.value; i.closest("label").querySelector("b") && (i.closest("label").querySelector("b").textContent = k === "budgetLakh" || k === "budgetStateLakh" ? rupL(+i.value) : k === "tauKm" ? i.value + " km" : k === "detour" ? "×" + i.value : ""); rerun(); }));
    $$("input[data-w]", tb).forEach(i => i.addEventListener("input", () => { S.opts.weights = { ...S.opts.weights, [i.dataset.w]: +i.value }; i.closest("label").querySelector("b").textContent = (+i.value).toFixed(2); rerun(); }));
    $$("input[data-sc]", tb).forEach(i => i.addEventListener("change", () => { S.opts.siteCost = { ...S.opts.siteCost, [i.dataset.sc]: Math.max(0, +i.value || 0) }; rerun(); }));
    $$("input[data-cm]", tb).forEach(i => i.addEventListener("change", () => { S.opts.commercial = { ...(S.opts.commercial || E.DEFAULTS.commercial), [i.dataset.cm]: Math.max(0, +i.value || 0) }; rerun(); }));
    $("#objective").onchange = (e) => { S.planKey = e.target.value; Audit.add("plan.objective", e.target.value); drawPlan(true); renderInspector(); updateStatus(); };
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
        <li>${nIN(c.raw.vehicleHH)} ${/uploaded/.test(A.ctx.pressureSource) ? "registered EVs (uploaded)" : "vehicle-owning households (Census 2011 rates)"} in reach · ${c.raw.localChargers} existing sites in reach</li>
        <li>Nearest mapped highway ${isFinite(c.raw.roadKm) ? km(c.raw.roadKm) : "far"}${c.placePop ? ` · ${esc(c.place)} pop. ${nIN(c.placePop)}` : ""}</li>
      </ul>
      <div class="hdr"><span>Confidence: ${conf.grade}</span><span class="sub">separate from score</span></div>
      ${conf.parts.map(([n, v, t]) => `<div class="comp"><span>${esc(n)}</span><div class="minibar"><i style="width:${v * 100}%;background:${v >= 0.7 ? "var(--good)" : v >= 0.5 ? "var(--warn)" : "var(--bad)"}"></i></div><span title="${esc(t)}">${Math.round(v * 100)}</span></div><div class="sub" style="margin:-2px 0 4px 98px;font-size:10.5px">${esc(t)}</div>`).join("")}
      ${c.evidence ? `<div class="note">Field evidence: <b>${esc(c.evidence.status)}</b>${c.evidence.grid_kva ? ` · ${c.evidence.grid_kva} kVA` : ""}${c.evidence.land ? ` · land ${esc(c.evidence.land)}` : ""}${c.evidence.notes ? ` · ${esc(c.evidence.notes)}` : ""}</div>` : ""}
      ${explainExtras(c)}
      <div style="margin-top:6px"><a class="linkbtn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=16/${c.lat}/${c.lng}">Inspect site on OpenStreetMap ↗</a></div></div>`;
    bindExplainExtras(c);
    $("#x-close").onclick = () => { S.selCand = null; el.innerHTML = ""; $$(".siteRow").forEach(r => r.classList.remove("on")); };
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
    if (kind === "print") window.print();
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
      else if (/^[1-8]$/.test(k) && S.level !== "india" && S.mode !== "corridor") { S.tab = ["overview", "plan", "compare", "validate", "evidence", "portfolio", "chargers", "ledger"][+k - 1]; renderInspector(); }
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
    role: () => store.get("role", "analyst"),
    user: () => store.get("user", "analyst@local"),
    can: (p) => PERMS[Gov.role()].includes(p),
    need(p, what) { if (Gov.can(p)) return true; toast(`Your role (${ROLES[Gov.role()]}) cannot ${what}. Switch role in the toolbar.`); return false; },
  };
  const hexOf = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  async function sha256Hex(text) {
    if (window.crypto && crypto.subtle) return hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return "fnv-" + fnv(text) + fnv(text + "#");   // insecure contexts (file://) only
  }
  const Audit = {
    list: () => store.get("audit", []),
    async add(action, detail) {
      const list = Audit.list(), prev = list.length ? list[list.length - 1].hash : "0".repeat(64);
      const e = { ts: new Date().toISOString(), user: Gov.user(), role: Gov.role(), action, detail: String(detail || "").slice(0, 300), build: INDIA.version, prev };
      e.hash = await sha256Hex(JSON.stringify([e.ts, e.user, e.role, e.action, e.detail, e.build, e.prev]));
      list.push(e); store.set("audit", list.slice(-3000));
    },
    async verify() {
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
    return new Promise(res => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => { const f = i.files[0]; if (!f) return res(null); const r = new FileReader(); r.onload = () => res({ name: f.name, text: r.result }); r.readAsText(f); }; i.click(); });
  }
  function initRole() {
    const tools = $(".ab-tools"); if (!tools || $("#ab-role")) return;
    const b = document.createElement("button"); b.className = "ab-btn ab-role"; b.id = "ab-role"; b.title = "Role (workflow permissions)";
    const sync = () => { b.textContent = ROLES[Gov.role()]; };
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
      ${series[0].points.map(p => `<text x="${X(p[0])}" y="${h - pad.b + 12}" font-size="8.5" text-anchor="middle" font-family="monospace" fill="currentColor">${esc(xFmt(cat[p[0]]).replace("₹", ""))}</text>`).join("")}
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
      <div class="hdr"><span>Budget curve</span><span class="sub">coverage you buy per budget</span></div>
      <div id="cmp-curve">${C.curve ? curveHTML(C.curve) : `<button class="btn sm" id="run-curve">Run budget comparison (8 budgets)</button>`}</div>
      <div class="hdr"><span>Optimiser comparison</span><span class="sub">greedy · local search · exact ILP</span></div>
      <div id="cmp-opt">${C.opt ? optHTML(C.opt) : `<p class="sub" style="margin:0 0 6px">Solves the budgeted maximum-coverage integer programme exactly (LP-based branch and bound) and reports how close the greedy heuristic gets.</p><button class="btn sm" id="run-opt">Run optimiser comparison</button>`}</div>
      <div class="hdr"><span>Sensitivity analysis</span><span class="sub">9 alternative assumption sets</span></div>
      <div id="cmp-sens">${S.sens ? sensHTML(S.sens) : `<button class="btn sm" id="run-sens">Run sensitivity analysis</button>`}</div>`;
    const go = (btn, key, job, extra, render) => { const b = $(btn, tb); if (!b) return; b.onclick = () => { b.outerHTML = busy("busy-" + key); runJob(job, extra).then(r => { if (key === "sens") S.sens = r; else (S.compare ||= {})[key] = r; Audit.add("analysis." + job, regionName()); tabCompare(tb); }).catch(e => { $("#busy-" + key, tb).textContent = "Failed: " + e.message; }); }; };
    go("#run-curve", "curve", "budgetCurve");
    go("#run-opt", "opt", "compareOptimisers", { timeoutMs: S.level === "state" ? 15000 : 8000 });
    go("#run-sens", "sens", "sensitivity");
    $$("[data-cx]", tb).forEach(b => b.onclick = () => exportCompare(b.dataset.cx));
    $$("[data-rerun]", tb).forEach(b => b.onclick = () => { if (b.dataset.rerun === "sens") S.sens = null; else if (S.compare) delete S.compare[b.dataset.rerun]; tabCompare(tb); });
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
  function tabValidate(tb) {
    const A = S.analysis, plan = A.plans[S.planKey], m = plan.metrics, V = S.backtest;
    tb.innerHTML = `
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


  /* ================================================================== guided demo tour (§15 walkthrough) */
  const TOUR = [
    { sel: ".appbar", title: "ReachGrid workspace", text: "A decision engine for public EV charging: real chargers, census demand and a budget optimiser for every state and district. Use Next, or the arrow keys.", run: () => { S.mode = "atlas"; return goIndia(); } },
    { sel: "#map", title: "India, coloured by access gap", text: "Every state shaded by the share of people more than 10 km from a listed charger. Darker means it needs more attention. Click any state to pop it out." },
    { sel: "#w-nav", title: "Ranked: needs attention first", text: "The navigator ranks states or districts by any metric. The search box (press /) finds any state, district or town." },
    { sel: "#w-insp", title: "Drill into a district", text: "East Singhbhum, Jharkhand: 22.9 lakh people, 22 listed charging sites. The inspector shows provenance, the distance distribution and the towns with no nearby charger.", run: () => goDistrict("jharkhand.east-singhbhum") },
    { sel: "#w-insp", title: "Plan new chargers", text: "Choose an objective (coverage, equity, corridor or commercial), a distance threshold, a budget and hardware. Four planning objectives and two baselines compete on the scenario board.", run: () => { S.tab = "plan"; S.planKey = "greedy"; renderInspector(); drawPlan(true); } },
    { sel: "#map", title: "Where to build, and why", text: "Numbered pink pins are the greedy picks in order. Blue cells are people newly brought within reach. Click a pin for its score breakdown, confidence, commercial screen and review controls." },
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
    docs.innerHTML = `<button class="ab-btn ab-role" id="ab-docs" aria-haspopup="true" aria-expanded="false">Docs ▾</button><div class="ab-menu" hidden><a href="methodology.html">Methodology</a><a href="business.html">Business model & roadmap</a><a href="api.html">Scenario API</a><a href="#sources" id="ab-src">Sources & licences</a></div>`;
    tools.prepend(docs); tools.prepend(demo);
    const btn = $("#ab-docs"), menu = $(".ab-menu", docs);
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", !menu.hidden); };
    document.addEventListener("click", () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); });
    $("#ab-src").onclick = (e) => { e.preventDefault(); location.href = "./#sources"; };
  }
  function registerAPI() {
    if ("serviceWorker" in navigator && isSecureContext && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => { });
  }

  const origRender = render;
  render = function () { origRender(); if ($("#asks")) renderAskSuggestions(); updateStatus(); syncToolbar(); };

  boot();
})();
