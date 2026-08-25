/**
 * Checks that the public common.tools site answers, with the same synthetic
 * round trip the production tile makes. A single unreachable check reads as a
 * calm gray, meaning the wall cannot tell, and only a sustained run of
 * failures escalates to a red "down"; an HTTP 5xx is bad immediately.
 * COMMON_TOOLS_URL overrides the target, which is how the check is pointed at
 * the www host when the apex redirects.
 */

import { confirmDashboardConnectivity } from "../connectivity.ts";
import type { Status, Tile, TileView } from "../types.ts";

const FAIL_THRESHOLD = 3; // consecutive unreachable checks before declaring "down"
let fails = 0;

export const commonToolsUp: Tile = {
  id: "common-tools-up",
  intervalMs: 30_000,
  async collect(ctx): Promise<TileView> {
    const url = ctx.env("COMMON_TOOLS_URL") ?? "https://common.tools/";
    const host = new URL(url).host;

    try {
      const t0 = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "manual" });
      confirmDashboardConnectivity();
      const ms = Date.now() - t0;
      try {
        await res.body?.cancel();
      } catch {
        // A received status establishes reachability when body cleanup fails.
      }
      fails = 0; // reachable — reset the outage counter

      const status: Status = res.status >= 500 ? "bad" : res.status >= 400 || ms > 2500 ? "warn" : "good";
      return {
        label: "common.tools",
        status,
        value: res.status >= 500 ? "erroring" : `${ms} ms`,
        sub: `HTTP ${res.status} · ${host}`,
        href: url,
        hint: "open ↗",
      };
    } catch {
      fails++;
      if (fails >= FAIL_THRESHOLD) {
        return { label: "common.tools", status: "bad", value: "down", sub: `unreachable · ${host}`, href: url, hint: "open ↗" };
      }
      return { label: "common.tools", status: "unknown", value: "—", sub: `unreachable · ${host}`, href: url, hint: "open ↗" };
    }
  },
};
