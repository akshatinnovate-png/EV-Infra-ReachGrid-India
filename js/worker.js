/* Background worker for heavy jobs (ILP, sensitivity, backtest, budget curve). Proposal §14.1. */
self.window = self;
importScripts("../vendor/lp-solver.js", "engine.js", "pmedrive.js", "region.js", "advanced.js", "jobs.js", "../data/india.js", "../data/roads.js");
self.onmessage = (e) => {
  const { id, job, args } = e.data;
  try {
    if (!self.RG_STATE || !self.RG_STATE[args.sid]) importScripts(`../data/state/${args.sid}.js`);
    const result = self.RGJobs.run(job, args, { india: self.RG_INDIA, roads: self.RG_ROADS, stateData: self.RG_STATE[args.sid] });
    self.postMessage({ id, result });
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
