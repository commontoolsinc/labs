// Central configuration and tunable thresholds.
export const PORT = Number(Deno.env.get("DASHBOARD_PORT") ?? "8731");
export const REPO = Deno.env.get("DASHBOARD_REPO") ?? "commontoolsinc/labs";
export const CI_WORKFLOW = "deno.yml";

// The service.name production reports under in SigNoz. The tiles that read traces
// scope to it by name: the same SigNoz also holds staging and one-off perf runs,
// whose spans are not production's and whose error rates are nothing like it.
// Override with PROD_SERVICE.
export const PROD_SERVICE = "toolshed-production";

// The loom repo and its main CI workflow ("Tests (fast)"), for the loom-repo CI
// tiles and the combined recent-runs stream.
export const LOOM_REPO = Deno.env.get("DASHBOARD_LOOM_REPO") ?? "commontoolsinc/loom";
export const LOOM_CI_WORKFLOW = "test-fast.yml";

// Shared fetch window — the widest any tile needs (ci-trust's): the fetch stops
// at whichever of these two yields fewer workflow runs. Every CI tile slices
// from it.
export const CI_RUNS_MAX = 200; // workflow runs
export const CI_RUNS_MAX_AGE_DAYS = 60; // ~2 months

// Status thresholds (tune here).
export const TRUST_GOOD = 90, TRUST_WARN = 75; // first-try-green %
export const TRUST_COLS = 40; // columns in the ci-trust cell grid (more = smaller cells)
export const DUR_GOOD = 12, DUR_WARN = 20; // median CI minutes
// ci-duration median window — the larger of these two (more runs wins).
export const DUR_MIN_RUNS = 20;
export const DUR_MAX_AGE_HOURS = 6;
export const RECENT_WINDOW = 10; // recent completed runs scanned for the recent-runs status
export const RECENT_DISPLAY = 50; // rows the recent-runs tile shows
