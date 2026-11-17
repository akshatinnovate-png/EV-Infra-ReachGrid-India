/* PM E-DRIVE costing, subsidy and capacity checks for ReachGrid. No DOM; runs in the browser, a worker and Node.
 *
 * Sources (all in the repository's methodology page):
 *  [OG]   MHI, Operational Guidelines for Deployment of EV Public Charging Stations under PM E-DRIVE, 26 Sep 2025.
 *         Table 1 (connector standards), Table 2 (location categories and subsidy), Table 3 (BEE upstream benchmarks, Aug 2022),
 *         Annexures B, C, D (proposal summary and location-wise formats).
 *  [FAQ]  MHI, FAQs on the Operational Guidelines (26 Sep 2025). FAQ 1 (Category A <= ~20% of requested subsidy),
 *         FAQ 4 (feasibility study report), FAQ 6 (BEE EVSE benchmarks revised Oct 2025, incl. GST; upstream on DISCOM
 *         demand note; GST and refundable deposits not eligible), FAQ 8/12 (Unified Bharat E-Charge).
 *  [DRAFT] MHI draft guidelines (Jul 2025), section 4: indicative city / highway station configurations and areas.
 */
(function (root) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;

  const SOURCES = {
    og: "MHI Operational Guidelines for EV PCS under PM E-DRIVE, 26 Sep 2025",
    faq: "MHI FAQs on the Operational Guidelines (BEE benchmarks revised Oct 2025)",
    draft: "MHI draft EV PCS guidelines, Jul 2025 (indicative configurations)",
  };

  /** [OG] Table 2 */
  const CATEGORIES = {
    A: { upstream: 1.0, evse: 1.0, label: "Govt. premises with free public access", examples: "Govt. offices, residential complexes, hospitals, educational institutes, CPSEs" },
    B: { upstream: 0.8, evse: 0.7, label: "Govt.-owned / controlled public locations", examples: "PSU OMC outlets, railway stations, AAI airports, STU bus stations, metro, municipal parking, public ports, NHAI / state toll plazas & wayside amenities" },
    C: { upstream: 0.8, evse: 0.0, label: "All other city and highway locations", examples: "Streets, malls, market complexes, private outlets, highways" },
    D: { upstream: 0.8, evse: 0.0, label: "Battery swapping / battery charging stations", examples: "BSS / BCS at any location" },
  };
  const CAT_A_SHARE_LIMIT = 0.20;   // [FAQ] 1: "should preferably not exceed 20% of the total requested subsidy"

  /** [FAQ] 6a: BEE EVSE benchmark, ₹ lakh including GST (Oct 2025) */
  const EVSE_BENCHMARK_LAKH = { 12: 1.60, 60: 3.40, 120: 5.00, 240: 8.00, 360: 12.50 };
  /** [OG] Table 3: BEE upstream benchmark by EV PCS rating, ₹ lakh (Aug 2022). After Oct 2025 the upstream subsidy is
   *  based on the DISCOM demand note [FAQ 6b]; ReachGrid uses this table only as the default estimate. */
  const UPSTREAM_BENCHMARK_LAKH = [[50, 6.04], [100, 14.80], [150, 19.00], [Infinity, 24.00]];

  /** charger types and the vehicle segments they serve ([OG] Table 1) */
  const CHARGER = {
    12: { conn: "LECCS / LEVDC", std: "IS-17017-2-6 / -2-7", seg: "e2w3w" },
    60: { conn: "CCS-II", std: "IS-17017-2-3", seg: "e4w" },
    120: { conn: "CCS-II", std: "IS-17017-2-3", seg: "e4w" },
    240: { conn: "CCS-II", std: "IS-17017-2-3", seg: "bus" },
    360: { conn: "CCS-II", std: "IS-17017-2-3", seg: "bus" },
  };

  /** station archetypes. city / highway are the indicative configurations of [DRAFT] section 4; hub and bss are
   *  ReachGrid options for 2W/3W-dominated demand (12 kW LECCS, or battery swapping under Category D). */
  const ARCHETYPES = {
    city: { label: "City EV PCS", chargers: [{ kw: 60, n: 1 }, { kw: 12, n: 2 }], area: [40, 60], basis: "indicative [DRAFT §4.i]: ≥1 × 60 kW CCS-II + ≥2 × 12 kW LECCS/LEVDC, 40–60 m²" },
    highway: { label: "Highway EV PCS", chargers: [{ kw: 240, n: 1 }, { kw: 60, n: 2 }], area: [250, 300], basis: "indicative [DRAFT §4.ii]: ≥1 × 240 kW CCS-II (e-bus/truck) + ≥2 × 60 kW CCS-II, 250–300 m²" },
    hub: { label: "2W/3W charging hub", chargers: [{ kw: 12, n: 4 }], area: [24, 40], basis: "ReachGrid option: 4 × 12 kW LECCS/LEVDC (4 bays × 6 m², [DRAFT] bay size)" },
    bss: { label: "Battery swapping station", chargers: [], swapKw: 30, area: [15, 25], basis: "ReachGrid option: BSS under Category D (upstream only), ~30 kW connected load" },
  };

  const DEFAULTS = {
    enabled: true,
    budgetBasis: "total",                    // total (project cost) | subsidy (MHI envelope) | net (agency outlay after subsidy)
    gstRate: 0.18,                            // GST on EVSE; benchmarks include GST, GST is not eligible [FAQ 6c] (assumption: 18%)
    evseActualFactor: 1.0,                    // actual EVSE price ex-GST as a multiple of the benchmark ex-GST (replace with quotes)
    upstreamFactor: 1.0,                      // DISCOM demand note as a multiple of the Table 3 estimate (replace with demand notes)
    htLakhPerKm: 6,                           // HT line extension beyond the first km to the nearest substation, ₹ lakh/km (assumption)
    htMaxKm: 10,
    otherLakh: { city: 2, highway: 4, hub: 1, bss: 1.5 },   // signage, canopy, parking marking: not subsidy-eligible (assumption)
    preferSwap: false,                        // use battery swapping (Category D) instead of 12 kW hubs in 2W/3W-dominated districts
    hubIfFourWheelerShareBelow: 0.03,         // district e-4W share of EVs below which town / hotspot sites become 2W/3W hubs
    capACatA: true,                           // keep Category A within 20% of the requested subsidy while optimising
  };

  const lakh = (x) => Math.round(x * 100) / 100;
  function upstreamBenchmark(kw) { for (const [lim, v] of UPSTREAM_BENCHMARK_LAKH) if (kw <= lim) return v; return 24; }
  function ratingKw(arch) { const a = ARCHETYPES[arch]; return a.swapKw || a.chargers.reduce((s, c) => s + c.kw * c.n, 0); }

  /** category of a candidate from its host / OSM site type; user overrides win */
  function categoryOf(c, cfg) {
    if (c.catOverride) return c.catOverride;
    if (c.arch === "bss" || (cfg && cfg.preferSwap && c.arch === "hub")) return "D";
    if (c.site && c.site.cat) return c.site.cat;
    return "C";
  }

  /** archetype for a candidate given the district fleet mix */
  function archetypeOf(c, mix, cfg) {
    if (c.archOverride) return c.archOverride;
    const onHighway = c.host === "highway" || c.host === "toll" || (c.raw && c.raw.roadKm != null && c.raw.roadKm < 1 && (c.host === "omc" || c.host === "fuel"));
    if (onHighway) return "highway";
    if (c.host === "bus" && mix && mix.bus > 0) return "highway";      // bus stations: e-bus fast charging
    const fourW = mix ? mix.e4w : null;
    if (fourW != null && fourW < cfg.hubIfFourWheelerShareBelow && (c.host === "town" || c.host === "hotspot")) return cfg.preferSwap ? "bss" : "hub";
    return "city";
  }

  /** full cost and subsidy breakdown for one site (₹ lakh) */
  function costSite(c, cfg) {
    const k = { ...DEFAULTS, ...(cfg || {}) };
    const arch = c.arch || "city", A = ARCHETYPES[arch], cat = categoryOf({ ...c, arch }, k), P = CATEGORIES[cat];
    const kw = ratingKw(arch);
    const extraKm = c.gridKm != null && c.gridKm > 1 ? Math.min(k.htMaxKm, c.gridKm - 1) : 0;
    const upstream = upstreamBenchmark(kw) * k.upstreamFactor + extraKm * k.htLakhPerKm;
    const evseLines = A.chargers.map(ch => {
      const benchEx = EVSE_BENCHMARK_LAKH[ch.kw] / (1 + k.gstRate);
      const actualEx = benchEx * k.evseActualFactor;
      return { kw: ch.kw, n: ch.n, conn: CHARGER[ch.kw].conn, seg: CHARGER[ch.kw].seg, benchEx, actualEx, eligible: Math.min(benchEx, actualEx) };
    });
    const evse = evseLines.reduce((s, l) => s + l.actualEx * l.n, 0);
    const evseEligible = evseLines.reduce((s, l) => s + l.eligible * l.n, 0);
    const other = (k.otherLakh[arch] ?? 2);
    const subUp = P.upstream * upstream, subEvse = P.evse * evseEligible;
    const total = upstream + evse + other, subsidy = subUp + subEvse;
    return {
      arch, archLabel: A.label, archBasis: A.basis, category: cat, ratingKw: kw, area: A.area, chargers: evseLines,
      upstream: lakh(upstream), upstreamBasis: `BEE Table 3 estimate for ${kw} kW${extraKm ? ` + ${extraKm.toFixed(1)} km HT extension` : ""}; replace with DISCOM demand note`,
      evse: lakh(evse), evseEligible: lakh(evseEligible), other: lakh(other),
      total: lakh(total), subsidyUpstream: lakh(subUp), subsidyEvse: lakh(subEvse), subsidy: lakh(subsidy), net: lakh(total - subsidy),
    };
  }

  /** applies archetype, category and cost to every candidate; c.cost follows the chosen budget basis */
  function applyToCandidates(cands, mixFor, cfg) {
    const k = { ...DEFAULTS, ...(cfg || {}) };
    for (const c of cands) {
      c.arch = archetypeOf(c, mixFor ? mixFor(c) : null, k);
      c.pm = costSite({ ...c, gridKm: c.raw ? c.raw.gridKm : null }, k);
      c.cost = c.costOverride != null ? c.costOverride : Math.max(0.01, k.budgetBasis === "subsidy" ? c.pm.subsidy : k.budgetBasis === "net" ? c.pm.net : c.pm.total);
    }
    return cands;
  }

  /** proposal totals in the Annexure B shape, plus the Category A share check */
  function summarise(selected) {
    const t = { sites: selected.length, chargers: { e2w3w: 0, e4w: 0, bus: 0 }, byCat: { A: 0, B: 0, C: 0, D: 0 }, total: 0, subsidy: 0, net: 0, upstream: 0, evse: 0 };
    for (const c of selected) {
      const p = c.pm; if (!p) continue;
      for (const l of p.chargers) t.chargers[l.seg] += l.n;
      t.byCat[p.category] += p.subsidy; t.total += p.total; t.subsidy += p.subsidy; t.net += p.net; t.upstream += p.upstream; t.evse += p.evse;
    }
    for (const k of Object.keys(t.byCat)) t.byCat[k] = lakh(t.byCat[k]);
    ["total", "subsidy", "net", "upstream", "evse"].forEach(k => { t[k] = lakh(t[k]); });
    t.catAShare = t.subsidy ? t.byCat.A / t.subsidy : 0;
    t.catAOk = t.catAShare <= CAT_A_SHARE_LIMIT + 1e-9;
    return t;
  }

  /* ---------------- capacity: M/M/c queue (Erlang C) ---------------- */
  /** probability an arriving EV must wait, for c servers and offered load a = λ/μ (Erlangs) */
  function erlangC(c, a) {
    if (c <= 0) return 1;
    if (a >= c) return 1;
    let b = 1;                                   // Erlang B by recursion, then convert to C
    for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
    return (c * b) / (c - a * (1 - b));
  }
  /** M/M/c metrics: lambda arrivals per hour, mu services per hour per charger */
  function mmc(lambda, mu, c) {
    const a = lambda / mu, rho = a / Math.max(1, c);
    if (c <= 0 || rho >= 1) return { c, a, rho, pWait: 1, wqMin: Infinity, stable: false };
    const pw = erlangC(c, a);
    return { c, a, rho, pWait: pw, wqMin: (pw / (c * mu - lambda)) * 60, stable: true };
  }
  /** smallest c with P(wait) <= target */
  function chargersFor(lambda, mu, target = 0.2, max = 500) {
    for (let c = 1; c <= max; c++) { const m = mmc(lambda, mu, c); if (m.stable && m.pWait <= target) return m; }
    return mmc(lambda, mu, max);
  }

  const QUEUE_DEFAULTS = {
    // daily public energy per vehicle (kWh) and energy per public session (kWh): planning assumptions, editable
    kwhDay: { e2w: 1.2, e3w: 7, e4w: 6, bus: 120 },
    publicShare: { e2w: 0.15, e3w: 0.35, e4w: 0.25, bus: 0.10 },
    kwhSession: { e2w: 2, e3w: 6, e4w: 18, bus: 150 },
    peakHourShare: 0.12,          // share of a day's sessions in the busiest hour (assumption)
    efficiency: 0.85,             // delivered / rated power over a session (taper, losses)
    target: 0.2,                  // design target: at most 20% of EVs wait at the peak hour
  };
  /** peak-hour queue for a site: fleet {e2w,e3w,e4w,bus} of vehicles within reach, share = fraction captured here */
  function siteQueue(arch, fleet, share, cfg) {
    const q = { ...QUEUE_DEFAULTS, ...(cfg || {}) };
    const A = ARCHETYPES[arch]; const out = {};
    const groups = { e2w3w: ["e2w", "e3w"], e4w: ["e4w"], bus: ["bus"] };
    for (const [g, segs] of Object.entries(groups)) {
      const guns = A.chargers.filter(c => CHARGER[c.kw].seg === g);
      const n = guns.reduce((s, c) => s + c.n, 0); if (!n) continue;
      const kw = guns[0].kw;
      let lam = 0, kwhW = 0;
      for (const s of segs) {
        const sessDay = (fleet[s] || 0) * q.kwhDay[s] * q.publicShare[s] / q.kwhSession[s] * share;
        lam += sessDay * q.peakHourShare; kwhW += sessDay * q.kwhSession[s];
      }
      const sessDayTot = lam / q.peakHourShare;
      const kwhPerSession = sessDayTot ? kwhW / sessDayTot : q.kwhSession[segs[0]];
      const mu = (kw * q.efficiency) / kwhPerSession;      // sessions per hour per gun
      const m = mmc(lam, mu, n), need = chargersFor(lam, mu, q.target);
      out[g] = { kw, guns: n, lambda: lam, mu, ...m, needGuns: need.c, extra: Math.max(0, need.c - n) };
    }
    return out;
  }

  /* ---------------- adoption S-curve ---------------- */
  /** logistic EV share of new registrations s(t) = S / (1 + exp(-k (t - t0))), anchored so that s(year0) = share0 */
  function logisticFit(share0, year0, S, t0) {
    const s = Math.min(Math.max(share0, 1e-4), S * 0.98);
    const k = Math.log(S / s - 1) / (t0 - year0);           // from s(year0) = share0
    return { S, t0, k: isFinite(k) && k > 0 ? k : 0.5, at: (t) => S / (1 + Math.exp(-(isFinite(k) && k > 0 ? k : 0.5) * (t - t0))) };
  }
  const SCURVE_DEFAULTS = {
    saturation: { e2w: 0.8, e3w: 0.9, e4w: 0.4, bus: 0.7 },  // long-run EV share of new registrations (assumption)
    inflection: { e2w: 2030, e3w: 2026, e4w: 2033, bus: 2030 },
    marketGrowth: 0.04,                                       // all-fuel registrations growth per year (assumption)
    life: 12,                                                  // years a vehicle stays in the fleet
    horizon: 2030,
  };
  /** district projection from observed VAHAN years: ev.years {YYYY: {e2w..bus, n (months), all:{...}}} */
  function scurveForecast(ev, cfg) {
    const c = { ...SCURVE_DEFAULTS, ...(cfg || {}), saturation: { ...SCURVE_DEFAULTS.saturation, ...((cfg || {}).saturation || {}) }, inflection: { ...SCURVE_DEFAULTS.inflection, ...((cfg || {}).inflection || {}) } };
    const segs = ["e2w", "e3w", "e4w", "bus"];
    const ys = Object.keys(ev.years).sort(); const last = ys[ys.length - 1];
    const L = ev.years[last], scale = 12 / Math.max(1, L.n || 12);       // annualise a partial year
    // anchor: latest full year if the last year is partial and short, else the last year annualised
    const anchorY = (L.n || 12) >= 6 ? last : ys[ys.length - 2] || last, AY = ev.years[anchorY], aScale = anchorY === last ? scale : 1;
    const fits = {}, allRegs = {};
    for (const s of segs) {
      const allS = (AY.all && AY.all[s]) || 0, evS = AY[s] || 0;
      fits[s] = logisticFit(allS ? evS / allS : 0, +anchorY, c.saturation[s], c.inflection[s]);
      allRegs[s] = allS * aScale;
    }
    // fleet: observed registrations (stock) to the anchor year, then projected
    const stock = Object.fromEntries(segs.map(s => [s, ys.filter(y => y <= anchorY).reduce((a, y) => a + (ev.years[y][s] || 0) * (y === anchorY ? aScale : 1), 0)]));
    const hist = ys.filter(y => y <= anchorY).map(y => Object.fromEntries(segs.map(s => [s, (ev.years[y][s] || 0) * (y === anchorY ? aScale : 1)])));
    const rows = [];
    for (let t = +anchorY; t <= c.horizon; t++) {
      if (t > +anchorY) {
        const reg = {};
        for (const s of segs) { allRegs[s] *= (1 + c.marketGrowth); reg[s] = allRegs[s] * fits[s].at(t); stock[s] += reg[s]; }
        hist.push(reg);
        if (hist.length > c.life) { const old = hist[hist.length - 1 - c.life]; for (const s of segs) stock[s] -= old[s]; }
      }
      rows.push({ year: t, share: Object.fromEntries(segs.map(s => [s, t === +anchorY ? (AY.all && AY.all[s] ? (AY[s] || 0) / AY.all[s] : 0) : fits[s].at(t)])),
        reg: Object.fromEntries(segs.map(s => [s, Math.round(t === +anchorY ? (AY[s] || 0) * aScale : hist[hist.length - 1][s])])),
        stock: Object.fromEntries(segs.map(s => [s, Math.round(stock[s])])) });
    }
    return { anchorYear: +anchorY, fits: Object.fromEntries(segs.map(s => [s, { S: fits[s].S, t0: fits[s].t0, k: +fits[s].k.toFixed(3) }])), rows };
  }

  const API = { SOURCES, CATEGORIES, CAT_A_SHARE_LIMIT, EVSE_BENCHMARK_LAKH, UPSTREAM_BENCHMARK_LAKH, CHARGER, ARCHETYPES, DEFAULTS, QUEUE_DEFAULTS, SCURVE_DEFAULTS,
    upstreamBenchmark, ratingKw, categoryOf, archetypeOf, costSite, applyToCandidates, summarise, erlangC, mmc, chargersFor, siteQueue, logisticFit, scurveForecast };
  if (isNode) module.exports = API; else root.RGPMEDrive = API;
})(typeof self !== "undefined" ? self : this);
