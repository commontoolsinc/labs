// ci spend: the org's GitHub Actions spend for the month, extrapolated to a
// projected full-month total, against the Actions budget configured in GitHub. The
// billable spend (net of discounts — so the included-usage allowance is already
// deducted) and its per-day breakdown come from the enhanced billing platform's
// usage report; a classic-plan fallback shows minutes vs the included allowance.
//
// The projection's daily rate is measured over a trailing window of at least two
// weeks — or the whole month-to-date if that is longer — so a couple of noisy
// early-month days don't dominate. When this month has under two weeks of data,
// the window spills into the tail of last month's daily spend. Uses GH_TOKEN,
// which for this tile must also carry org billing read (an org owner or billing
// manager) on top of the Actions read the other GitHub tiles use.
import type { Status, Tile, TileView } from "../types.ts";
import { budgetStatus, friendlyError, github, SPARK_FADE, sparkline, usd } from "../lib.ts";
import { REPO } from "../config.ts";

interface UsageItem {
  date: string;
  product: string;
  netAmount: number;
}
interface Budget {
  budget_product_sku?: string;
  budget_amount?: number;
}
interface ActionsBilling {
  total_minutes_used: number;
  total_paid_minutes_used: number;
  included_minutes: number;
}

// The usage report labels the product "actions" (lowercase) and splits it across
// SKUs (runner minutes, storage) and repos; match case-insensitively.
const actionsOf = (report: { usageItems?: UsageItem[] }): UsageItem[] =>
  (report.usageItems ?? []).filter((i) => String(i.product).toLowerCase() === "actions");
const sumNet = (items: UsageItem[]): number => items.reduce((s, i) => s + (Number(i.netAmount) || 0), 0);
const byDayOf = (items: UsageItem[]): Map<string, number> => {
  const byDay = new Map<string, number>();
  for (const i of items) {
    const day = i.date.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (Number(i.netAmount) || 0));
  }
  return byDay;
};
// Billable spend for every calendar day of one month. The usage report carries a row
// only for a day that had usage, so a day it omits is a day that spent nothing, and a
// rate measured over the month has to count it.
const monthSeries = (items: UsageItem[], year: number, month0: number): number[] =>
  calendarMonth(byDayOf(items), year, month0);

const usagePath = (org: string, y: number, m: number) =>
  `organizations/${org}/settings/billing/usage?year=${y}&month=${m}`;

// How late a source settles a day's billing. GitHub's usage report runs a day or two
// behind. The provider cost APIs return a zero bucket for the day in progress.
export const GITHUB_LAG_DAYS = 2;
export const PROVIDER_LAG_DAYS = 1;

// The leading days of a month whose spend is known, given how many days have passed
// since that month began and how late the source settles.
//
// A day is known once it carries a figure, and failing that once the source has had
// `lagDays` to settle it. Both halves are needed. Counting only the days that carried
// spend stalls the window the moment spend stops, so a month that spends nothing after
// the 14th goes on rating itself over 14 days until the month ends, and a fortnight
// whose spend all landed on the 2nd is rated over two days. Counting every day that
// has passed instead divides by days whose figures have not arrived, dragging the rate
// toward zero. A zero day inside the window is left alone either way: that is a day
// which really did spend nothing, and it belongs in the rate.
//
// For last month, `elapsedDays` counts from that month's own first day, so it includes
// however much of this month has gone by. Exported for unit testing.
export function settled(daily: number[], elapsedDays: number, lagDays: number): number[] {
  let withData = daily.length;
  while (withData > 0 && daily[withData - 1] === 0) withData--;
  const known = Math.max(withData, elapsedDays - lagDays);
  return daily.slice(0, Math.max(0, Math.min(daily.length, known)));
}

// Daily values for every calendar day of one month, chronological and indexed from the
// 1st, with the days a source has no entry for filled in as zero. Exported for the
// model-spend tile, whose per-provider maps are keyed the same way.
export function calendarMonth(byDay: Map<string, number>, year: number, month0: number): number[] {
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const prefix = `${year}-${String(month0 + 1).padStart(2, "0")}-`;
  return Array.from({ length: days }, (_, i) => byDay.get(prefix + String(i + 1).padStart(2, "0")) ?? 0);
}

// Project a full-month total from a daily rate measured over a window of at least
// two weeks — or the whole month-to-date if that is longer. When this month has
// fewer than two weeks of data, the window fills from the tail of last month's
// daily spend. Exported for unit testing.
export const MIN_WINDOW_DAYS = 14;
// How many trailing calendar days the daily-spend sparkline aims to cover.
const SPARK_DAYS = 45;
export function projectMonthly(
  mtd: number,
  coveredThis: number,
  daysInMonth: number,
  lastMonthDaily: number[],
): number {
  const needFromLast = Math.max(0, MIN_WINDOW_DAYS - coveredThis);
  const tail = needFromLast > 0 ? lastMonthDaily.slice(-needFromLast) : [];
  const windowDays = coveredThis + tail.length;
  if (windowDays <= 0) return mtd; // no data anywhere
  const windowSpend = mtd + tail.reduce((s, d) => s + d, 0);
  return (windowSpend / windowDays) * daysInMonth;
}

// A sparkline of the last up-to-SPARK_DAYS calendar days of daily billable spend,
// in-range gaps filled with 0, the current month's tail drawn brighter in the
// same gradient style as the other tiles. The bottom-right corner shows the span
// it covers (e.g. "45 days"). Ends on the last day with data (billing lags a day
// or two, so this avoids a fake trailing dip to zero).
function dailySparkline(
  byDay: Map<string, number>,
  year: number,
  month0: number,
  status: Status,
): { chart: string; spanMs: number } {
  const keys = [...byDay.keys()].sort();
  if (keys.length < 2) return { chart: "", spanMs: 0 };
  const ms = (k: string) => Date.parse(`${k}T00:00:00Z`);
  const end = ms(keys[keys.length - 1]);
  const start = Math.max(ms(keys[0]), end - (SPARK_DAYS - 1) * 86_400_000);
  const monthStart = Date.UTC(year, month0, 1);
  const series: number[] = [];
  let current = 0;
  for (let t = start; t <= end; t += 86_400_000) {
    series.push(byDay.get(new Date(t).toISOString().slice(0, 10)) ?? 0);
    if (t >= monthStart) current++;
  }
  if (series.length < 2) return { chart: "", spanMs: 0 };
  // Mark the slice the projection rates: this month, reaching back to
  // MIN_WINDOW_DAYS when the month is younger than that, since projectMonthly
  // borrows that many days from last month's tail. Both count calendar days from
  // the start of the month, so the mark tracks the window up to the unsettled days
  // at the end, which the projection leaves out and the line still draws.
  const windowDays = Math.min(series.length, Math.max(current, MIN_WINDOW_DAYS));
  const highlight = { count: windowDays, color: "#c7ccd4" };
  // The inclusive day span the line covers, for the tile's duration slot.
  return { chart: sparkline(series, "#727882", highlight, SPARK_FADE[status]), spanMs: end - start + 86_400_000 };
}

export const githubCiSpend: Tile = {
  id: "github-ci-spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const label = "ci spend";
    const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
    if (!token) {
      return { label, status: "unknown", value: "—", sub: "set GH_TOKEN (needs org billing read)" };
    }
    const org = ctx.env("GH_BILLING_ORG") ?? REPO.split("/")[0];
    // The whole tile drills through to this org's GitHub billing settings.
    const drill = {
      href: `https://github.com/organizations/${org}/settings/billing`,
      hint: "billing ↗",
    };
    const now = new Date();
    const year = now.getUTCFullYear();
    const month0 = now.getUTCMonth();
    const dayOfMonth = now.getUTCDate();

    try {
      const report = await github<{ usageItems?: UsageItem[] }>(usagePath(org, year, month0 + 1), token);
      // A 200 without a well-formed usageItems array (e.g. a permission-filtered
      // view) must not read as a real $0 — gray out instead.
      if (!Array.isArray(report.usageItems)) {
        return { ...drill, label, status: "unknown", value: "—", sub: "billing usage unavailable" };
      }
      const items = actionsOf(report);
      const mtd = sumNet(items);
      // The days of this month whose billing has settled. The projection divides by
      // these, so a quiet weekend counts and the days still to settle do not. Every
      // day carrying spend is settled by construction, so the month-to-date total is
      // the spend over exactly these days and stays the numerator.
      const coveredThis = settled(monthSeries(items, year, month0), dayOfMonth, GITHUB_LAG_DAYS).length;
      const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

      // Daily billable spend keyed by calendar day, across this month plus enough
      // prior months to fill the ~45-day sparkline. The immediate prior month's
      // daily series also feeds the projection when this month is under two weeks
      // old.
      const byDay = new Map<string, number>();
      const addDays = (its: UsageItem[]) => {
        for (const i of its) {
          const d = i.date.slice(0, 10);
          byDay.set(d, (byDay.get(d) ?? 0) + (Number(i.netAmount) || 0));
        }
      };
      addDays(items);
      let lastMonthDaily: number[] = [];
      let remaining = SPARK_DAYS - now.getUTCDate(); // days needed before this month
      let py = year, pm = month0; // step back month by month
      let firstPrior = true;
      while (remaining > 0) {
        pm -= 1;
        if (pm < 0) {
          pm = 11;
          py -= 1;
        }
        try {
          const prev = await github<{ usageItems?: UsageItem[] }>(usagePath(org, py, pm + 1), token);
          const its = actionsOf(prev);
          addDays(its);
          // Settled like this month: early in a month the borrowed tail is the part
          // most likely not to have settled, and taking those days as real zeros
          // would rate the whole window near zero. Its days have had this month's
          // elapsed days on top of their own to settle.
          if (firstPrior) {
            const prev = monthSeries(its, py, pm);
            lastMonthDaily = settled(prev, prev.length + dayOfMonth, GITHUB_LAG_DAYS);
          }
        } catch { /* a prior month is unavailable — the window just covers less */ }
        remaining -= new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
        firstPrior = false;
      }
      const projected = projectMonthly(mtd, coveredThis, daysInMonth, lastMonthDaily);

      // The org's Actions budget is configured in GitHub (Settings -> Billing ->
      // Budgets) and read here; it is the only source for the budget.
      let budget = NaN;
      try {
        const b = await github<{ budgets?: Budget[] }>(`organizations/${org}/settings/billing/budgets`, token);
        const actions = (b.budgets ?? []).find((x) => String(x.budget_product_sku).toLowerCase() === "actions");
        if (actions && Number.isFinite(Number(actions.budget_amount))) budget = Number(actions.budget_amount);
      } catch { /* no GitHub budget available; leave it unset */ }

      const status = budgetStatus(projected, budget);
      const spark = dailySparkline(byDay, year, month0, status);
      return {
        ...drill,
        label,
        status,
        value: `~${usd(projected)}/mo`,
        // MTD in the header aside; the budget (when GitHub has one) in the sub; the
        // span the sparkline covers goes to the tile's duration slot.
        aside: `<span class="hmtd">${usd(mtd)} MTD</span>`,
        sub: Number.isFinite(budget) ? `${usd(budget)} budget` : undefined,
        extra: spark.chart,
        duration: spark.spanMs,
      };
    } catch {
      // Classic endpoint (minutes, no dollars) for orgs not on the enhanced platform.
      try {
        const b = await github<ActionsBilling>(`orgs/${org}/settings/billing/actions`, token);
        const used = Number(b.total_minutes_used) || 0;
        const included = Number(b.included_minutes) || 0;
        const paid = Number(b.total_paid_minutes_used) || 0;
        const frac = included > 0 ? used / included : 0;
        const status: Status = paid > 0 || frac >= 1 ? "bad" : frac >= 0.8 ? "warn" : "good";
        return { ...drill, label, status, value: `${paid} paid min`, sub: `${used} / ${included} min · MTD` };
      } catch (classicErr) {
        const msg = classicErr instanceof Error ? classicErr.message : String(classicErr);
        return { ...drill, label, status: "unknown", value: "—", sub: friendlyError(msg) };
      }
    }
  },
};
