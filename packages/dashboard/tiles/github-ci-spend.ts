// github ci spend: the org's GitHub Actions spend for the month, extrapolated to a
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
import { budgetStatus, daysLabel, friendlyError, github, SPARK_FADE, sparkline } from "../lib.ts";
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
const dailyTotals = (items: UsageItem[]): Map<string, number> => {
  const byDay = new Map<string, number>();
  for (const i of items) {
    const day = i.date.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (Number(i.netAmount) || 0));
  }
  return byDay;
};

const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);
const calendarSeries = (byDay: Map<string, number>, start: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => byDay.get(dayKey(start + i * 86_400_000)) ?? 0);

const usagePath = (org: string, y: number, m: number) =>
  `organizations/${org}/settings/billing/usage?year=${y}&month=${m}`;

// Project a full-month total from a daily rate measured over a window of at least
// two weeks — or the whole month-to-date if that is longer. When this month has
// fewer than two weeks of data, the window fills from the tail of last month's
// daily spend. Exported for unit testing.
const MIN_WINDOW_DAYS = 14;
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
// same gradient style as the other tiles. The corner caption is how many days it
// actually covers. Ends on the last day with data (billing lags a day or two, so
// this avoids a fake trailing dip to zero).
function dailySparkline(byDay: Map<string, number>, year: number, month0: number, status: Status): string {
  const keys = [...byDay.keys()].sort();
  if (keys.length < 2) return "";
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
  if (series.length < 2) return "";
  const days = series.length;
  const highlight = current >= 2 ? { count: current, color: "#c7ccd4" } : undefined;
  return sparkline(series, "#727882", highlight, daysLabel(days), SPARK_FADE[status]);
}

export const githubCiSpend: Tile = {
  id: "github-ci-spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const label = "github ci spend";
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

    try {
      const report = await github<{ usageItems?: UsageItem[] }>(usagePath(org, year, month0 + 1), token);
      // A 200 without a well-formed usageItems array (e.g. a permission-filtered
      // view) must not read as a real $0 — gray out instead.
      if (!Array.isArray(report.usageItems)) {
        return { ...drill, label, status: "unknown", value: "—", sub: "billing usage unavailable" };
      }
      const items = actionsOf(report);
      const mtd = sumNet(items);
      const coveredThis = now.getUTCDate();
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
          if (firstPrior) {
            const prevDays = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
            lastMonthDaily = calendarSeries(dailyTotals(its), Date.UTC(py, pm, 1), prevDays);
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
      return {
        ...drill,
        label,
        status,
        value: `~$${Math.round(projected)}/mo`,
        sub: Number.isFinite(budget)
          ? `$${Math.round(mtd)} MTD · $${Math.round(budget)} budget`
          : `$${Math.round(mtd)} MTD · projected`,
        extra: dailySparkline(byDay, year, month0, status),
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
