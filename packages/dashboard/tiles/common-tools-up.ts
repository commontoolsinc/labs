// common.tools uptime: a synthetic round-trip check of the public site, mirroring
// the production tile. A single unreachable check reads as calm gray ("can't
// tell"), and only a sustained run of failures escalates to a red "down"; an HTTP
// 5xx is bad immediately. Override the target with COMMON_TOOLS_URL (e.g. point at
// the www host if the apex redirects).
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
      const ms = Date.now() - t0;
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
