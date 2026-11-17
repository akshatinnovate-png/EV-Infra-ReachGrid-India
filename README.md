# ReachGrid India

<img src="desktop/build/icons/icon-128.png" width="64" align="right" alt="">

**EV charging infrastructure intelligence & investment optimisation, for every state and district in India.**
Techfest 2026–27 · EV Infra & Green Mobility AI Challenge · Challenge 1 · Team GoingAgain

ReachGrid is not another charger map. It is a decision engine: it estimates where charging access is weak,
says how much to trust each number, and tests which candidate sites buy the most new access per rupee.

```
India  →  Jharkhand  →  East Singhbhum
(click a state: it pops out · click a district: everything inside it)
```

## Install (Windows)

1. Download **[ReachGrid-India-Setup.exe](https://github.com/akshatinnovate-png/EV-Infra-ReachGrid-India/releases/latest/download/ReachGrid-India-Setup.exe)**, or use the button on the [website](https://akshatinnovate-png.github.io/EV-Infra-ReachGrid-India/).
2. Run it. It installs per-user in seconds (no admin rights) and opens the app. The installer is not code-signed yet, so Windows may say "Windows protected your PC": choose **More info → Run anyway**.
3. Start planning. You're signed in as the owner, and all data and the engine are bundled. Press **▶ Demo** for the guided tour.

The app runs as its own window (Electron), not in a browser. Your profile, projects, audit log and offline map tiles live in `%APPDATA%\ReachGrid India`.

### What the desktop app adds over a static site

| Capability | How |
|---|---|
| Real accounts and enforced roles | scrypt-hashed passwords; Viewer/Analyst/Admin checked in the main process on every protected write; optional sign-in at start-up |
| Tamper-evident audit log | append-only `audit.jsonl` with a SHA-256 hash chain, written by the main process; editing any line is detected |
| Local REST API for other tools | `http://127.0.0.1:<port>/api/v1` on a real HTTP server, with an API key, read-only by default, optional writes, fixed port option |
| Offline maps | tile proxy with a disk cache; "download this region for offline" (z6–z15) |
| Street routing | corridor checks route on OSRM when online, falling back to the highway graph |
| Live data | one-click data updates from the weekly rebuild; live OpenStreetMap substations for grid proximity |
| App updates | electron-updater from GitHub Releases, downloaded in the background and installed on restart |
| Native files | save/open dialogs, PDF reports (`printToPDF`), `.reachgrid` project files (merge evidence, portfolio, reviews and scenarios from colleagues) |
| Secrets | the optional Claude API key is encrypted with Windows DPAPI (`safeStorage`) |
| App windows | methodology, business model and API console open as app windows; external links open in the system browser |
| Team server | Settings → Team: an Admin shares the workspace on the office network (port 47800 by default). Colleagues' ReachGrid apps join by address and sign in with their own account; evidence, portfolio, reviews and scenarios live on the server, roles are enforced there, and every action is audited under the remote user. Requires passwords; failed sign-ins are rate-limited; proxies are closed to anonymous callers. Plain HTTP: use on a trusted network |
| In-app rebuild | Settings → Data & maps → Rebuild now: re-downloads the charger listings, VAHAN registrations by RTO and OpenStreetMap PM E-DRIVE locations, and rebuilds them with the pipeline's formulas (no Python). Checked against the Python build on every data refresh (`tests/rebuild.parity.js`) |

### Build it yourself

```bash
cd desktop
npm ci
npx electron-builder --win nsis      # on Windows; produces dist/ReachGrid-India-Setup.exe
npm start                            # run from source on any OS
npx electron . --smoke-test=out.json # 32+ end-to-end checks, exit code 0 on success
```

Every push to `main` runs `.github/workflows/desktop.yml` on a real Windows machine:

1. Unit tests.
2. Build the installer.
3. Smoke-test the unpacked app, including network checks (tiles, offline download, data update and revert, routing).
4. Install silently and check the Start-menu and desktop shortcuts.
5. Smoke-test the installed app.
6. Uninstall silently.

The release is published only if all of these pass.

### Develop the web workspace

The workspace itself is `app.html` plus `js/`. To work on it in a browser, run `python3 serve.py` and open `/app.html?app=1`.

## What's real

| Layer | Source | Status in the app |
|---|---|---|
| **28,553 public charging stations** with operator, power, connectors, tariff, address and source count | [reclaimchennai/india-ev-charging-dataset](https://github.com/reclaimchennai/india-ev-charging-dataset), merged from Kia/Numocity, MG eHUB, ChargeZone, Bolt.Earth, OpenChargeMap, OpenStreetMap, BESCOM and MeeTicket (ODbL 1.0) | observed |
| **Population, households, car & two-wheeler ownership, income bands** for all 640 Census 2011 districts | Census of India 2011 | observed |
| **737 current district boundaries**, 36 states/UTs | [udit-001/india-maps-data](https://github.com/udit-001/india-maps-data) | observed |
| **Census 2011 district polygons**, used to apportion 2011 totals onto post-2011 districts | [DataMeet](https://github.com/datameet/maps) (CC BY 4.0) | observed → imputed where split |
| **3,502 towns** with population | GeoNames (CC BY 4.0) | observed |
| **National highway network**: 14,414-node routable graph | Natural Earth 10m roads (public domain) | observed |
| Demand surface: ~260 hex cells per district | Census × GeoNames dasymetric model | derived |
| Live OSM cross-check | Overpass API, queried from your browser | live |

Pipeline checks: district populations reconcile to the Census 2011 national total within 0.01%. All 28,553 stations land
inside a district (38 coastal points snap to the nearest one). 494 districts map one-to-one onto Census 2011 districts; 243 are flagged *imputed*.

## Workspace

**Launch workspace** (or any link with `?app=1`) opens a full-viewport planning app: a toolbar with breadcrumbs and global search,
a docked navigator and inspector you can resize by dragging (double-click a divider to reset), the map in the middle,
the legend and assistant floating over the map (drag them by their title bar, minimise with _, double-click the title to snap back), and a status bar showing scope, coverage, cursor coordinates, data build and IST clock.
Panel layout and sizes are remembered. On phones the panels stack under the map.

| Key | Action |
|---|---|
| `F` | Full screen |
| `/` | Search states, districts, towns |
| `Esc` | Up one level (district → state → India) |
| `[` / `]` | Hide or show navigator / inspector |
| `A` / `L` | Assistant / legend |
| `1`–`5` | Overview · Plan · Sensitivity · Chargers · Ledger |
| `C` | Corridor mode |
| `?` | Shortcut help |

## Features

- **Drill-down atlas**: India → state → district. Choropleths for eight metrics: population beyond 10 km, mean distance,
  chargers per lakh people, per 1,000 vehicle households, DC share, cross-verified share, car ownership and station count. Rankings are
  ordered "needs attention first". Search covers every state, district and town.
- **Reachability engine**: population-weighted coverage within a threshold τ, a road-detour factor, and a choice of which existing
  chargers count (all, DC only, or confirmed by two or more sources). Chargers just across a border still count.
- **Gap intelligence**: candidate sites are towns without a charger within 1 km, highway points every 8 km, and unserved demand hotspots.
  Each is scored `0.30·Gap + 0.25·EVPressure + 0.20·Corridor + 0.15·Equity + 0.10·Feasibility`, with unknown components
  renormalised, never zero-filled.
- **Budget optimiser** (proposal Appendix A): greedy marginal coverage per ₹, compared side by side with score-only ranking,
  an EV/charger-ratio baseline and an equity-weighted greedy plan. It works per district or across a whole state.
- **Explanations**: per-site component bars, newly covered population, vehicle households in reach, distance to the nearest highway,
  and a **confidence rubric shown separately from the score**.
- **Sensitivity analysis**: nine variants (τ, detour, ±30% costs, alternative weights) with Jaccard shortlist stability.
- **Corridor check**: route between any two towns on the highway graph, list chargers within a detour limit, find the longest gap,
  and check feasibility for a given EV range and reserve, with a minimum-stop plan.
- **Confidence ledger**: provenance, recency, the cross-verification histogram, and a live OpenStreetMap comparison.
- **Exports**: shortlist CSV, GeoJSON, a reproducible scenario JSON (inputs, outputs, source hashes and a deterministic scenario ID),
  charger CSV, a print report, and saved scenarios.
- **Ask ReachGrid**: built-in answers from the loaded data (worst/best access, where to build, comparisons, operators,
  tariffs, reliability, "X to Y by EV"). There is an optional Claude mode using your own Anthropic API key, sent straight from your browser
  to the API and stored only if you choose.

## Round 2: PM E-DRIVE, VAHAN by RTO, capacity

| Feature | Detail |
|---|---|
| PM E-DRIVE costing in the optimiser | Location categories A–D and subsidy shares from MHI's Operational Guidelines (26 Sep 2025, Table 2); EVSE benchmarks from BEE (Oct 2025, ex-GST); upstream estimated from the BEE table by station rating plus HT extension to the nearest substation, to be replaced by DISCOM demand notes; Category A ≤ 20% of subsidy (FAQ 1); budget counted as project cost, subsidy envelope or agency outlay (`js/pmedrive.js`) |
| Station types | City (1 × 60 kW CCS-II + 2 × 12 kW LECCS/LEVDC), highway (1 × 240 kW + 2 × 60 kW CCS-II), 2W/3W hub (4 × 12 kW) or battery swapping (Category D), chosen from the site type and the district's fleet mix; overridable per site |
| Real eligible sites | PSU OMC outlets, toll plazas, railway and bus stations, AAI airports and government premises from OpenStreetMap become candidates with their category |
| MHI proposal export | Annexure B, C, D (and L–M for swapping stations) as .xlsx in the official column layout, plus the feasibility study report (FAQ 4) as PDF |
| VAHAN by RTO | Registrations by RTO and month since Jan 2022 (India Data Portal mirror of VAHAN, ODC-BY), matched to districts; e-rickshaws observed; segment split modelled from EV-only makers and validated out of sample (e-2W 10.8% state MAPE in 2024; e-4W 8.2% and e-bus 6.6% against published monthly totals); a national-total row mislabelled as an RTO is detected and removed |
| Capacity | M/M/c (Erlang C) peak-hour queue per site and per district: shows where 100% spatial coverage still needs more guns |
| Adoption S-curve | Logistic EV share of new registrations per segment, anchored to the observed share; fleet, guns per charger type and MW to 2030 |
| Provable optimiser | Modified greedy guarantee ½(1 − 1/e) for budgeted coverage (1 − 1/e with equal costs); measured 95.0–100% of the LP bound on 10 districts × 2 budgets |
| Jury tools | Live challenge (any district, town or corridor; ₹10 crore plan with a timer), split-screen vs EV-to-charger ratio allocation, Round 1 → Round 2 changelog, Rule 5 & 6 disclosures |
| Unified Bharat E-Charge | `GET /api/v1/scenarios/{id}/ubec`: planned stations with location, status, pricing and payment fields and OCPI 2.2.1 connector codes, as a draft for onboarding (the hub's protocol is not yet published) |

## Everything in the proposal, as a static site

| Proposal item | Where |
|---|---|
| Reachability engine, gap intelligence, confidence ledger, site optimiser (§3, §6) | Workspace → Plan |
| Planning objectives: coverage, equity, corridor reach, commercial screening (§3.2) | Plan → Planning objective |
| Road-network distance (§6.1) | Plan → Distance metric → Highway network (Dijkstra on the national highway graph) |
| Feasibility screen with real evidence (§3) | Evidence tab: CSV upload or add on map (status, kVA, land, cost) |
| EV registrations (§5) | Evidence tab: VAHAN district CSV replaces the Census proxy |
| Budget scenarios (§6.5) | Compare → budget curve (8 budgets) |
| Integer programming / local search (§6.4) | Compare → optimiser comparison (exact ILP via jsLPSolver, LP bound, optimality gap) |
| Sensitivity report with charts and export (§6.5, §15) | Compare → sensitivity (CSV / JSON) |
| Equity metrics (§8.1) | Validate → dense vs sparse coverage, equity gap, worst-served reached |
| Holdout validation (§8, §12) | Validate → backtest against where operators really built |
| Live acceptance tests (§8) | Validate → self-tests; `node tests/*.test.js` in CI |
| Portfolio Monitor with recalibration (§3) | Portfolio tab: built sites, observed usage, fitted k / R² / MAPE |
| Human review before capital spend (§13) | Site card → propose / approve / reject; review queue |
| Roles, audit log, encrypted export (§13) | Toolbar role; Ledger → hash-chained audit log; Plan → encrypted export (AES-256-GCM) |
| Official count cross-check (§5) | India inspector + state overview (BEE, March 2024) |
| API contracts (§7.2) | [`api.html`](api.html): `POST /api/v1/scenarios` etc., served by a service worker, stored in IndexedDB |
| Asynchronous jobs (§14.1) | Web Worker (`js/worker.js`) |
| Automated refresh and change detection (§10, §14) | `.github/workflows/refresh.yml` weekly rebuild → change report in Ledger |
| Methodology document (§15) | [`methodology.html`](methodology.html) |
| Commercial model, unit economics, bottom-up TAM, roadmap (§9–§14) | [`business.html`](business.html) calculators |
| Demonstration walkthrough (§15) | Toolbar → ▶ Demo, or `?app=1&tour=1` |

Limits that a static site cannot remove: roles and the audit log are enforced in the browser, not on a server; the API answers only pages on this origin; the highway graph is 1:10m, not street-level.

## Tests

```bash
node tests/engine.test.js
node tests/advanced.test.js
node tests/pmedrive.test.js     # PM E-DRIVE subsidy maths, Erlang C, S-curve, Annexure workbook, integration
node tests/rebuild.parity.js    # in-app rebuild reproduces the Python pipeline (needs pipeline/raw/)
```

The tests run against the real bundled data and cover the proposal §8 acceptance rules:

- Data integrity and census reconciliation.
- Adding a charger never increases the nearest distance.
- Coverage rises monotonically with τ.
- The plan stays within budget.
- Missing components are renormalised.
- Identical inputs give identical outputs.
- Corridor routing works.
- The largest state (Uttar Pradesh: 22k cells, 1k+ candidates) runs in about 0.3 s.

## Rebuild the data

```bash
bash pipeline/fetch_sources.sh                    # downloads raw sources into pipeline/raw/
pip install shapely && npm i -g mapshaper pbf@3
python3 pipeline/build.py                         # writes data/*.js (~15 MB, lazy-loaded per state)
```

## Limits (stated in the app too)

- Charger listings are point-in-time and **not verified as operational**. Power and tariff are missing for about 45% of stations.
- Demand is **Census 2011**. Growth since then and actual EV registrations are not modelled; vehicle ownership is a pressure proxy.
- Distances are straight-line × a detour factor, not routed. The highway graph is coarse (1:10m).
- Grid capacity, land, permits and safety are **not assessed**. The shortlist is for field validation, not a construction decision.
- Cost figures are planning assumptions you can edit, not quotes.

## Structure

```
index.html  css/app.css         UI (no framework, no build)
js/engine.js                    reachability, candidates, scoring, optimiser, sensitivity, corridor routing (pure, Node-testable)
js/region.js                    builds an analysis context for any set of districts
js/app.js                       atlas, windows, planner, corridors, ledger, exports, assistant
data/                           generated by pipeline/build.py
pipeline/                       fetch + build scripts
vendor/                         Leaflet 1.9.4, Anthropic TypeScript SDK 1.8.0 (browser bundle)
media/                          compressed background loops
```
