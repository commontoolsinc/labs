// Central configuration and tunable thresholds.
export const PORT = Number(Deno.env.get("DASHBOARD_PORT") ?? "8731");
export const REPO = Deno.env.get("DASHBOARD_REPO") ?? "commontoolsinc/labs";
export const CI_WORKFLOW = "deno.yml";

// Shared fetch window — the widest any tile needs (ci-trust's): the fetch stops
// at whichever of these two yields fewer commits. Every CI tile slices from it.
export const CI_RUNS_MAX = 200; // commits
export const CI_RUNS_MAX_AGE_DAYS = 60; // ~2 months

// Status thresholds (tune here).
export const TRUST_GOOD = 90, TRUST_WARN = 75; // first-try-green %
export const TRUST_COLS = 40; // columns in the ci-trust cell grid (more = smaller cells)
export const TRUST_STRIP = 200; // max cells; the count is rounded down to a whole number of rows
export const DUR_GOOD = 12, DUR_WARN = 20; // median CI minutes
// ci-duration median window — the larger of these two (more commits wins).
export const DUR_MIN_RUNS = 20;
export const DUR_MAX_AGE_HOURS = 6;
export const RECENT_WINDOW = 10; // recent completed runs scanned for the recent-runs status
export const RECENT_DISPLAY = 50; // rows the recent-runs tile shows
