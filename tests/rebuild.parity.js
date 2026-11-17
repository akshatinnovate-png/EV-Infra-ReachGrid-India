// The desktop app's in-app rebuild (desktop/rebuild.js) must reproduce the Python pipeline. Run after pipeline/build.py
// with the same raw charger CSV:  `node tests/rebuild.parity.js`
const fs = require("fs"), path = require("path"), assert = require("assert");
const R = path.join(__dirname, "..");
const parse = (f) => { const t = fs.readFileSync(f, "utf8"); const u = t.slice(t.indexOf("*/") + 2); return JSON.parse(u.slice(u.indexOf("={") + 1).trim().replace(/;\s*$/, "")); };
global.window = {};
const E = require("../js/engine.js"), RB = require("../desktop/rebuild.js");
(async () => {
  const csvPath = path.join(R, "pipeline/raw/charging_stations.csv");
  if (!fs.existsSync(csvPath)) { console.log("skipped: pipeline/raw/charging_stations.csv not present (run pipeline/fetch_sources.sh)"); return; }
  const py = parse(path.join(R, "data/india.js")), india = parse(path.join(R, "data/india.js")), states = {};
  for (const s of india.states) states[s.id] = parse(path.join(R, `data/state/${s.id}.js`));
  await RB.rebuild({ india, stateFiles: states, E, fetchText: async () => fs.readFileSync(csvPath, "utf8"), overpass: async () => { throw new Error("offline"); }, parts: ["chargers"] });
  const P = new Map(py.districts.map(d => [d.id, d.stats]));
  let countDiff = 0, maxCov = 0, maxMd = 0, maxAbs = 0, net = 0;
  for (const d of india.districts) {
    const a = P.get(d.id), b = d.stats;
    if (a.chargers !== b.chargers) { countDiff++; maxAbs = Math.max(maxAbs, Math.abs(a.chargers - b.chargers)); net += b.chargers - a.chargers; }
    for (const t of ["5", "10", "25"]) maxCov = Math.max(maxCov, Math.abs(a.coverage[t] - b.coverage[t]));
    maxMd = Math.max(maxMd, Math.abs(a.mean_dist - b.mean_dist));
  }
  console.log(`national chargers ${py.totals.chargers} vs ${india.totals.chargers}; 10 km coverage ${py.totals.coverage["10"]} vs ${india.totals.coverage["10"]}; districts with a different count ${countDiff}/737; max district coverage diff ${maxCov.toFixed(4)}; max mean-distance diff ${maxMd.toFixed(3)} km`);
  assert.strictEqual(india.totals.chargers, py.totals.chargers, "national charger total");
  assert(Math.abs(india.totals.coverage["10"] - py.totals.coverage["10"]) <= 0.001, "national coverage");
  // the app locates chargers on boundaries simplified to ~180 m, so a charger on a shared border can land next door:
  // differences must be tiny, paired between neighbours (net zero) and rare
  assert(maxAbs <= 2 && net === 0 && countDiff <= 30, `border reassignment: ${countDiff} districts, max ${maxAbs}, net ${net}`);
  assert(maxCov <= 0.03, "district coverage within rounding (cells exactly at a threshold)");
  assert(maxMd <= 0.25, "mean distance within rounding");
  console.log("parity ok");
})().catch(e => { console.error(e.message); process.exit(1); });
