// prod errors: the 5xx error rate over the last 15 minutes from SigNoz.
// Env-gated on SIGNOZ_URL + SIGNOZ_API_KEY; returns "unknown" until both are set.
// The query payload is environment-specific, so an unrecognized response shape
// resolves to "unknown" rather than a guessed number.
import type { Status, Tile, TileView } from "../types.ts";

// Pull the first finite number out of a nested SigNoz result. The v3/v4
// query_range response nests series values under result[].series[].values[],
// where each value is a [timestamp, "stringNumber"] pair. This walks whatever
// shape comes back and returns the first numeric leaf it can parse.
function firstNumber(node: unknown, depth = 0): number | undefined {
  if (depth > 8 || node == null) return undefined;
  if (typeof node === "number") return Number.isFinite(node) ? node : undefined;
  if (typeof node === "string") {
    if (node.trim() === "") return undefined; // "" coerces to 0 — skip empty metadata strings
    const n = Number(node);
    return Number.isFinite(n) ? n : undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const n = firstNumber(item, depth + 1);
      if (n !== undefined) return n;
    }
    return undefined;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const n = firstNumber(v, depth + 1);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

export const prodErrors: Tile = {
  id: "prod-errors",
  intervalMs: 60_000,
  async collect(ctx): Promise<TileView> {
    const base = ctx.env("SIGNOZ_URL");
    const key = ctx.env("SIGNOZ_API_KEY");
    if (!base || !key) {
      return {
        label: "prod errors",
        status: "unknown",
        value: "—",
        sub: "set SIGNOZ_URL + SIGNOZ_API_KEY",
      };
    }

    const now = Date.now();
    const start = now - 15 * 60 * 1000;

    // Environment-specific builder query: the 5xx error rate as a percentage of
    // all requests over the last 15 minutes. Series A counts spans with an HTTP
    // status >= 500; series B counts all spans; the formula divides them. The
    // exact attribute keys and metric names vary per deployment, so this is a
    // best-effort shape rather than a portable contract.
    const body = {
      start,
      end: now,
      step: 60,
      compositeQuery: {
        queryType: "builder",
        panelType: "value",
        builderQueries: {
          A: {
            queryName: "A",
            dataSource: "traces",
            aggregateOperator: "count",
            expression: "A",
            disabled: true,
            filters: {
              op: "AND",
              items: [
                {
                  key: { key: "responseStatusCode", type: "tag", dataType: "string" },
                  op: ">=",
                  value: "500",
                },
              ],
            },
          },
          B: {
            queryName: "B",
            dataSource: "traces",
            aggregateOperator: "count",
            expression: "B",
            disabled: true,
            filters: { op: "AND", items: [] },
          },
          C: {
            queryName: "C",
            expression: "(A / B) * 100",
            disabled: false,
          },
        },
      },
    };

    let json: unknown;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/api/v3/query_range`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "SIGNOZ-API-KEY": key,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return { label: "prod errors", status: "bad", sub: `SigNoz HTTP ${res.status}` };
      }
      json = await res.json();
    } catch {
      return { label: "prod errors", status: "bad", sub: "SigNoz unreachable" };
    }

    const pct = firstNumber(json);
    if (pct === undefined || pct < 0) {
      return { label: "prod errors", status: "unknown", sub: "unexpected SigNoz response" };
    }

    const status: Status = pct < 1 ? "good" : pct < 5 ? "warn" : "bad";
    return {
      label: "prod errors",
      status,
      value: `${pct.toFixed(2)}%`,
      sub: "5xx · last 15m",
    };
  },
};
