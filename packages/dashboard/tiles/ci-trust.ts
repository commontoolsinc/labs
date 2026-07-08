// ci trust: share of recent completed runs that passed on the first attempt (a
// flakiness signal), with a per-run pass/fail history strip.
import type { Status, Tile, TileView } from "../types.ts";
import { concDot, strip } from "../lib.ts";
import { TRUST_COLS, TRUST_GOOD, TRUST_STRIP, TRUST_WARN } from "../config.ts";

export const ciTrust: Tile = {
  id: "ci-trust",
  intervalMs: 30_000,
  async collect(ctx): Promise<TileView> {
    const runs = await ctx.runs();
    const completed = runs.filter((r) => r.status === "completed" && r.conclusion);
    const firstTryGreen = completed.filter((r) => r.conclusion === "success" && r.run_attempt === 1).length;
    const pct = completed.length ? (firstTryGreen / completed.length) * 100 : 0;
    const s: Status = completed.length === 0
      ? "unknown"
      : pct >= TRUST_GOOD ? "good" : pct >= TRUST_WARN ? "warn" : "bad";
    // Round the cell count down to a whole number of rows so the grid is always
    // complete; only show a single short row when that's all the data there is.
    const cap = Math.min(TRUST_STRIP, completed.length);
    const n = cap < TRUST_COLS ? cap : Math.floor(cap / TRUST_COLS) * TRUST_COLS;
    const cells = [...completed].reverse().slice(-n).map((r) => ({
      outcome: concDot(r.conclusion, r.run_attempt),
      href: r.html_url,
    }));
    return {
      label: "ci trust",
      status: s,
      value: `${pct.toFixed(1)}%`,
      sub: `first-try green · last ${completed.length} runs`,
      extra: strip(cells, TRUST_COLS),
    };
  },
};
