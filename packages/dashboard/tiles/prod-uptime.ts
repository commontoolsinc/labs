// production uptime: a synthetic round-trip check of the production URL. Times
// the fetch and maps reachability + latency to a status. A single unreachable
// check is treated as "can't tell" (calm gray), not an outage — only a sustained
// run of failures escalates to a red "down" alarm, so a network blip on the
// dashboard's side doesn't cry wolf. An HTTP 5xx (reached but erroring) is a real
// bad state immediately, since that isn't a connectivity blip.
import type { Status, Tile, TileView } from "../types.ts";

const FAIL_THRESHOLD = 3; // consecutive unreachable checks before declaring "down"
let fails = 0;

export const prodUptime: Tile = {
  id: "prod-uptime",
  intervalMs: 30_000,
  async collect(ctx): Promise<TileView> {
    const url = ctx.env("PROD_URL") ?? "https://production.commontools.dev/";
    const host = new URL(url).host;

    try {
      const t0 = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "manual" });
      const ms = Date.now() - t0;
      fails = 0; // reachable — reset the outage counter

      const status: Status = res.status >= 500 ? "bad" : res.status >= 400 || ms > 2500 ? "warn" : "good";
      return {
        label: "production",
        status,
        value: res.status >= 500 ? "erroring" : `${ms} ms`,
        sub: `HTTP ${res.status} · ${host}`,
        href: url,
        hint: "open ↗",
      };
    } catch {
      fails++;
      if (fails >= FAIL_THRESHOLD) {
        return { label: "production", status: "bad", value: "down", sub: `unreachable · ${host}`, href: url, hint: "open ↗" };
      }
      return { label: "production", status: "unknown", value: "—", sub: `unreachable · ${host}`, href: url, hint: "open ↗" };
    }
  },
};
