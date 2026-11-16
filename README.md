# ReachGrid India

**EV charging infrastructure intelligence & investment optimisation, for every state and district in India.**
Techfest 2026–27 · EV Infra & Green Mobility AI Challenge · Challenge 1 · Team GoingAgain

ReachGrid is not another charger map. It is a decision engine: it estimates where charging access is weak,
says how much to trust each number, and tests which candidate sites buy the most new access per rupee.

```
India  →  Jharkhand  →  East Singhbhum
(click a state: it pops out · click a district: everything inside it)
```

## Run it

No build step and no API keys. Start the bundled server, which opens your browser:

```bash
python3 serve.py
```

On Windows, double-click `start-windows.bat` or run `python serve.py`.

It runs at <http://localhost:5050>. Pass another port with `python3 serve.py 7000`, or set `PORT=7000`.
If the port is busy, the next free port is used. Any static server works too, for example `npx serve -l 5050`. Deep links work, for example `?r=jharkhand/east-singhbhum`, `?r=maharashtra/pune` or `?r=uttar-pradesh`.
The app also works on GitHub Pages or any static host.

## What's real

| Layer | Source | Status in the app |
|---|---|---|
| **25,587 public charging stations** with operator, power, connectors, tariff, address and source count | [reclaimchennai/india-ev-charging-dataset](https://github.com/reclaimchennai/india-ev-charging-dataset), merged from Kia/Numocity, MG eHUB, ChargeZone, Bolt.Earth, OpenChargeMap, OpenStreetMap, BESCOM and MeeTicket (ODbL 1.0) | observed |
| **Population, households, car & two-wheeler ownership, income bands** for all 640 Census 2011 districts | Census of India 2011 | observed |
| **737 current district boundaries**, 36 states/UTs | [udit-001/india-maps-data](https://github.com/udit-001/india-maps-data) | observed |
| **Census 2011 district polygons**, used to apportion 2011 totals onto post-2011 districts | [DataMeet](https://github.com/datameet/maps) (CC BY 4.0) | observed → imputed where split |
| **3,502 towns** with population | GeoNames (CC BY 4.0) | observed |
| **National highway network**: 14,414-node routable graph | Natural Earth 10m roads (public domain) | observed |
| Demand surface: ~260 hex cells per district | Census × GeoNames dasymetric model | derived |
| Live OSM cross-check | Overpass API, queried from your browser | live |

Pipeline checks: district populations reconcile to the Census 2011 national total within 0.01%. All 25,587 stations land
inside a district (38 coastal points snap to the nearest one). 494 districts map one-to-one onto Census 2011 districts; 243 are flagged *imputed*.

## Workspace

**Launch workspace** (or any link with `?app=1`) opens a full-viewport planning app: a toolbar with breadcrumbs and global search,
a docked navigator and inspector you can resize by dragging (double-click a divider to reset), the map in the middle,
the legend and assistant floating over the map, and a status bar showing scope, coverage, cursor coordinates, data build and IST clock.
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

## Tests

```bash
node tests/engine.test.js
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
