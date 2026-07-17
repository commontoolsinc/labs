// model spend: month-to-date API cost across the LLM providers we use, projected
// to a full-month total against an optional monthly budget. Each provider's
// authoritative billing API is read in real USD: OpenAI and Anthropic (org Admin
// keys, which expose per-day cost) and OpenRouter (a key, which exposes only a
// running monthly total).
//
// The two providers with a daily series are charted as one line each over the
// trailing ~45 days, dimmed except for the current-month slice that feeds the
// headline (like the github-ci-spend sparkline), with each line's month-to-date
// total in the right gutter. The headline is the projected full-month spend,
// extrapolated from the recent daily rate — spilling into last month's tail when
// this month is under two weeks old — summed across every provider we could read.
// The subtitle is the key (which colour is which provider, plus OpenRouter's total
// since it has no line); the combined month-to-date total sits in the header aside,
// and the span the chart covers goes to the tile's duration slot.
//
// Any provider we can't read shows "$???" and drops the tile to gray, but the
// rest still chart and total. All LLM traffic routes through the AI gateway, but
// the gateway exposes tokens, not dollars — these provider APIs are the
// authoritative source of spend.
import type { Status, Tile, TileView } from "../types.ts";
import { budgetStatus, multiSparkline, readBudget, SPARK_FADE, usd } from "../lib.ts";
import { calendarMonth, MIN_WINDOW_DAYS, projectMonthly, PROVIDER_LAG_DAYS, settled } from "./github-ci-spend.ts";

// The provider billing APIs are slow — OpenAI's costs endpoint alone takes ~12-16s
// for a 46-day query and slows further under repeated calls — and this tile pages
// over ~45 days, so give each request generous headroom. A request that would have
// returned shouldn't be cut off, stranding the whole provider as "$???".
const TIMEOUT = 30000;
const SPARK_DAYS = 45; // trailing calendar days the per-provider lines cover
const OPENAI_COLOR = "#10a37f";
const ANTHROPIC_COLOR = "#d97757";

// Daily billable USD, keyed by "YYYY-MM-DD", from OpenAI's org cost buckets.
async function openaiDaily(key: string, startSec: number): Promise<Map<string, number>> {
  const byDay = new Map<string, number>();
  let page: string | undefined;
  for (let i = 0; i < 12; i++) {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(startSec));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "62");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`OpenAI costs HTTP ${res.status}`);
    const data = await res.json() as {
      data?: Array<{ start_time?: number; results?: Array<{ amount?: { value?: number | string } }> }>;
      has_more?: boolean;
      next_page?: string | null;
    };
    if (!Array.isArray(data.data)) throw new Error("OpenAI costs: unexpected shape");
    for (const bucket of data.data) {
      if (typeof bucket.start_time !== "number") continue;
      const day = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
      let sum = 0;
      for (const r of bucket.results ?? []) sum += Number(r.amount?.value) || 0;
      byDay.set(day, (byDay.get(day) ?? 0) + sum);
    }
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return byDay;
}

// Daily billable USD, keyed by "YYYY-MM-DD", from Anthropic's cost report (whose
// amounts are USD cents).
async function anthropicDaily(key: string, startISO: string): Promise<Map<string, number>> {
  const byDay = new Map<string, number>();
  let page: string | undefined;
  for (let i = 0; i < 12; i++) {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", startISO);
    url.searchParams.set("limit", "31"); // Anthropic's cost_report rejects limit > 31; it pages instead
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Anthropic cost_report HTTP ${res.status}`);
    const data = await res.json() as {
      data?: Array<{ starting_at?: string; results?: Array<{ amount?: string | number }> }>;
      has_more?: boolean;
      next_page?: string | null;
    };
    if (!Array.isArray(data.data)) throw new Error("Anthropic cost_report: unexpected shape");
    for (const bucket of data.data) {
      if (typeof bucket.starting_at !== "string") continue;
      const day = bucket.starting_at.slice(0, 10);
      let sum = 0;
      for (const r of bucket.results ?? []) sum += (Number(r.amount) || 0) / 100;
      byDay.set(day, (byDay.get(day) ?? 0) + sum);
    }
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return byDay;
}

// OpenRouter exposes only a running month-to-date total, no daily series.
async function openrouterMonthly(key: string): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`OpenRouter key HTTP ${res.status}`);
  const data = await res.json() as { data?: { usage_monthly?: number } };
  if (typeof data.data?.usage_monthly !== "number") throw new Error("OpenRouter: no usage_monthly");
  return data.data.usage_monthly;
}

// Month-to-date total and a projected full-month total from a provider's daily map.
function summarize(
  byDay: Map<string, number>,
  year: number,
  month0: number,
  dayOfMonth: number,
): { mtd: number; projected: number } {
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  // Every day of this month, for the headline total. Quiet days inside the month
  // count toward the rate: a fortnight carrying spend on two days is a low daily
  // rate, not a fortnight of two days.
  const thisMonth = calendarMonth(byDay, year, month0);
  const mtd = thisMonth.reduce((s, v) => s + v, 0);
  const coveredThis = settled(thisMonth, dayOfMonth, PROVIDER_LAG_DAYS).length;
  const pm0 = month0 === 0 ? 11 : month0 - 1;
  const py = month0 === 0 ? year - 1 : year;
  // Last month's days have had this month's elapsed days on top of their own to
  // settle, so only the first day or two of a month leaves any of it unknown.
  const prev = calendarMonth(byDay, py, pm0);
  const lastMonthDaily = settled(prev, prev.length + dayOfMonth, PROVIDER_LAG_DAYS);
  return { mtd, projected: projectMonthly(mtd, coveredThis, daysInMonth, lastMonthDaily) };
}

export const modelSpend: Tile = {
  id: "model-spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const label = "model spend";
    const oaKey = ctx.env("OPENAI_ADMIN_KEY");
    const anKey = ctx.env("ANTHROPIC_ADMIN_KEY");
    const orKey = ctx.env("OPENROUTER_KEY");
    if (!oaKey && !anKey && !orKey) {
      return { label, status: "unknown", value: "—", sub: "set OPENAI_ADMIN_KEY / ANTHROPIC_ADMIN_KEY / OPENROUTER_KEY" };
    }

    const now = new Date();
    const year = now.getUTCFullYear();
    const month0 = now.getUTCMonth();
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
    const monthStartStr = `${year}-${String(month0 + 1).padStart(2, "0")}-01`;
    const startMs = Date.now() - (SPARK_DAYS + 1) * 86_400_000;
    const startSec = Math.floor(startMs / 1000);
    const startISO = `${new Date(startMs).toISOString().slice(0, 10)}T00:00:00Z`;

    // Read each provider concurrently. null = key absent or the billing API errored.
    const [oaMap, anMap, orMonthly] = await Promise.all([
      oaKey ? openaiDaily(oaKey, startSec).catch(() => null) : Promise.resolve(null),
      anKey ? anthropicDaily(anKey, startISO).catch(() => null) : Promise.resolve(null),
      orKey ? openrouterMonthly(orKey).catch(() => null) : Promise.resolve(null),
    ]);

    const oa = oaMap ? summarize(oaMap, year, month0, dayOfMonth) : null;
    const an = anMap ? summarize(anMap, year, month0, dayOfMonth) : null;
    const or = orMonthly !== null
      ? { mtd: orMonthly, projected: dayOfMonth > 0 ? (orMonthly / dayOfMonth) * daysInMonth : orMonthly }
      : null;

    const present = [oa, an, or].filter((p): p is { mtd: number; projected: number } => p !== null);
    if (present.length === 0) {
      return { label, status: "unknown", value: "—", sub: "model spend unavailable" };
    }
    const totalMtd = present.reduce((s, p) => s + p.mtd, 0);
    const totalProjected = present.reduce((s, p) => s + p.projected, 0);
    // Gray only when a CONFIGURED provider couldn't be read. A provider whose key
    // isn't set simply isn't part of this deployment and must not gate the budget
    // (otherwise a one- or two-key deployment would never turn warn/bad).
    const complete = !((oaKey && !oa) || (anKey && !an) || (orKey && !or));
    const status: Status = complete
      ? budgetStatus(totalProjected, readBudget(ctx.env("MODEL_MONTHLY_BUDGET")))
      : "unknown";

    // A shared daily grid across the two charted providers so their lines overlay
    // on one axis, in-range gaps filled with 0, ending on the last day with data.
    const days = new Set<string>();
    for (const m of [oaMap, anMap]) if (m) for (const d of m.keys()) days.add(d);
    let chart = "";
    let durationMs = 0;
    if (days.size >= 2) {
      const sorted = [...days].sort();
      const dayMs = (k: string) => Date.parse(`${k}T00:00:00Z`);
      const end = dayMs(sorted[sorted.length - 1]);
      const start = Math.max(dayMs(sorted[0]), end - (SPARK_DAYS - 1) * 86_400_000);
      durationMs = end - start + 86_400_000;
      const grid: string[] = [];
      for (let t = start; t <= end; t += 86_400_000) grid.push(new Date(t).toISOString().slice(0, 10));
      const lineFor = (m: Map<string, number>, color: string, mtd: number) => ({
        vals: grid.map((d) => m.get(d) ?? 0),
        color,
        label: usd(mtd),
      });
      const lines = [];
      if (oaMap && oa) lines.push(lineFor(oaMap, OPENAI_COLOR, oa.mtd));
      if (anMap && an) lines.push(lineFor(anMap, ANTHROPIC_COLOR, an.mtd));
      // Mark the slice the projection rates: this month, reaching back to
      // MIN_WINDOW_DAYS when the month is younger than that, since projectMonthly
      // borrows that many days from last month's tail. The mark takes in every day
      // of this month the grid holds, where the projection stops at the last day
      // that has settled, and one mark covers both providers though each settles on
      // its own days. It approximates the window rather than tracking it exactly.
      const current = grid.filter((d) => d >= monthStartStr).length;
      const windowDays = Math.min(grid.length, Math.max(current, MIN_WINDOW_DAYS));
      chart = multiSparkline(lines, { fadeFrom: SPARK_FADE[status], highlight: { count: windowDays } });
    }

    // The key line. Charted providers show a swatch (their own MTD sits at the line
    // end on the chart, or inline when there's no chart yet); OpenRouter (no line,
    // abbreviated "OR") and any provider we couldn't read show their value inline
    // ("$???" when missing). Items are bullet-separated. The combined MTD is in the
    // header aside; the span the chart covers goes to the tile's duration slot.
    const swatch = (c: string) => `<span class="swatch" style="background:${c}"></span>`;
    const charted = (p: { mtd: number } | null, name: string, color: string) =>
      p ? (chart ? `${swatch(color)} ${name}` : `${swatch(color)} ${name} ${usd(p.mtd)}`) : `${name} $???`;
    const seg: string[] = [];
    if (oaKey) seg.push(charted(oa, "OpenAI", OPENAI_COLOR));
    if (anKey) seg.push(charted(an, "Anthropic", ANTHROPIC_COLOR));
    if (orKey) seg.push(or ? `OR ${usd(or.mtd)}` : "OR $???");
    const legend = `<p class="sub">${seg.join(" • ")}</p>`;

    return {
      label,
      status,
      // Complete -> a projection (~); missing a provider -> the total is only a
      // lower bound, since the absent provider would add to it (≥).
      value: `${complete ? "~" : "≥"}${usd(totalProjected)}/mo`,
      aside: `<span class="hmtd">${usd(totalMtd)} MTD</span>`,
      extra: legend + chart,
      duration: durationMs,
    };
  },
};
