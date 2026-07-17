// Shared interfaces for the tile registry.
//
// To add a tile: create a file in tiles/ that exports a `Tile`, then add it to
// the array in registry.ts (the single registration point). To remove one:
// delete its line from registry.ts. Nothing else needs to change.

export type Status = "good" | "warn" | "bad" | "unknown";

// A render-ready snapshot produced by a tile's collect().
export interface TileView {
  label: string; // header label (plain text; escaped by the renderer)
  status: Status; // good / warn / bad / unknown -> green / orange / red / gray
  value?: string; // big headline (TRUSTED html — escape in the tile if it holds data)
  sub?: string; // sub line (plain text; escaped by the renderer)
  extra?: string; // trusted inline html under sub (sparkline / strip / list)
  duration?: number; // a span in ms; rendered (humanSpan) in the chart's bottom-left corner
  aside?: string; // trusted inline html minor header facet (e.g. an MTD or "running" badge)
  href?: string; // if set, the whole tile becomes a link (external opens a new tab)
  hint?: string; // small drill affordance text, e.g. "commits ↗"
  wide?: boolean; // render full-width below the grid instead of as a grid cell
}

export interface Route {
  path: string;
  handler(req: Request, url: URL): Response | Promise<Response>;
}

export interface Tile {
  id: string; // unique, stable key for this tile's scheduling + latest-view state
  intervalMs: number; // how often collect() runs
  collect(ctx: Ctx): Promise<TileView>;
  routes?: Route[]; // optional drill-down routes this tile owns
}

// Shared, memoized data sources handed to every collect().
export interface Ctx {
  runs(): Promise<Run[]>; // labs deno.yml runs on main (shared across CI tiles, memoized)
  // main-branch runs for any repo + workflow, memoized per (repo, workflow) so
  // several tiles reading the same repo share one fetch (loom's CI tiles, and the
  // combined recent-runs stream).
  runsFor(repo: string, workflow: string): Promise<Run[]>;
  env(key: string): string | undefined;
}

export interface Run {
  repo?: string; // the "owner/name" the run was fetched for (tagged by the fetcher)
  id: number;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  event: string;
  head_sha: string;
  display_title: string;
  run_started_at: string;
  updated_at: string;
  html_url: string;
  head_commit: { message: string } | null;
}
