// model spend: month-to-date API cost across the LLM providers we use, against an
// optional monthly budget. Sums each provider's authoritative billing API in real
// USD: OpenAI and Anthropic (org Admin keys) and OpenRouter (a key). Each provider
// is independently optional; one that errors contributes 0 and drops from the
// "included" list, so a dead key never blanks the tile. All LLM traffic routes
// through the AI gateway, but the gateway exposes tokens, not dollars — these
// provider APIs are the authoritative source of spend.
import type { Tile, TileView } from "../types.ts";
import { budgetStatus, friendlyError, readBudget } from "../lib.ts";

const TIMEOUT = 8000;

// First of the current month, UTC.
function monthStart(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
}

async function openaiCost(key: string): Promise<number> {
  const start = Math.floor(monthStart().getTime() / 1000);
  let total = 0;
  let page: string | undefined;
  for (let i = 0; i < 12; i++) {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(start));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`OpenAI costs HTTP ${res.status}`);
    const data = await res.json() as {
      data?: Array<{ results?: Array<{ amount?: { value?: number } }> }>;
      has_more?: boolean;
      next_page?: string | null;
    };
    if (!Array.isArray(data.data)) throw new Error("OpenAI costs: unexpected shape");
    for (const bucket of data.data) {
      for (const r of bucket.results ?? []) total += Number(r.amount?.value) || 0;
    }
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return total;
}

async function anthropicCost(key: string): Promise<number> {
  const start = monthStart().toISOString();
  let total = 0;
  let page: string | undefined;
  for (let i = 0; i < 12; i++) {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", start);
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Anthropic cost_report HTTP ${res.status}`);
    const data = await res.json() as {
      data?: Array<{ results?: Array<{ amount?: string | number }> }>;
      has_more?: boolean;
      next_page?: string | null;
    };
    if (!Array.isArray(data.data)) throw new Error("Anthropic cost_report: unexpected shape");
    // Amounts are USD in cents (decimal strings) -> divide by 100.
    for (const bucket of data.data) {
      for (const r of bucket.results ?? []) total += (Number(r.amount) || 0) / 100;
    }
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return total;
}

async function openrouterCost(key: string): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`OpenRouter key HTTP ${res.status}`);
  const data = await res.json() as { data?: { usage_monthly?: number } };
  if (typeof data.data?.usage_monthly !== "number") throw new Error("OpenRouter: no usage_monthly");
  return data.data.usage_monthly;
}

export const modelSpend: Tile = {
  id: "model-spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const label = "model spend";
    const providers: Array<[string, string | undefined, (k: string) => Promise<number>]> = [
      ["openai", ctx.env("OPENAI_ADMIN_KEY"), openaiCost],
      ["anthropic", ctx.env("ANTHROPIC_ADMIN_KEY"), anthropicCost],
      ["openrouter", ctx.env("OPENROUTER_KEY"), openrouterCost],
    ];
    const configured = providers.filter((p) => p[1]);
    if (configured.length === 0) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "set OPENAI_ADMIN_KEY / ANTHROPIC_ADMIN_KEY / OPENROUTER_KEY",
      };
    }

    let cost = 0;
    const included: string[] = [];
    let lastErr = "";
    for (const [name, key, fetchCost] of configured) {
      try {
        cost += await fetchCost(key!);
        included.push(name);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (included.length === 0) {
      return { label, status: "unknown", value: "—", sub: friendlyError(lastErr) };
    }

    const sub = `model apis · MTD · ${included.join("+")}`;
    return {
      label,
      status: budgetStatus(cost, readBudget(ctx.env("MODEL_MONTHLY_BUDGET"))),
      value: `$${Math.round(cost)}/mo`,
      sub,
    };
  },
};
