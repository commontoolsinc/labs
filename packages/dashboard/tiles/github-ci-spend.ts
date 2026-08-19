/**
 * Reports month-to-date GitHub Actions cost and projects it to a full-month
 * total. The 45-day daily-spend chart labels the line with month-to-date spend.
 *
 * GitHub's enhanced billing report supplies daily net Actions spend. It
 * reports a day or two after it ends, and a settled day with no row is a day
 * Actions spent nothing. That reading holds only while the report is still
 * writing rows, so a report whose newest row is too far back is unavailable
 * rather than a run of $0 days.
 */

import type { Status, Tile, TileView } from "../types.ts";
import { budgetStatus, daysLabel, friendlyError, github, usd } from "../lib.ts";
import { REPO } from "../config.ts";
import {
  calendarMonth,
  reportLagDays,
  settled,
  SPEND_HISTORY_DAYS,
  spendChart,
  summarizeDailySpend,
} from "../spend.ts";
import { themedChartSeries } from "../theme.ts";

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

interface DailySpend {
  byDay: Map<string, number>;
  mtd: number;
  projected: number;
  estimateDays: number;
}

interface GitHubDollarSpend extends DailySpend {
  kind: "dollars";
  budget: number;
  /**
   * The calendar months whose usage report was read, as "YYYY-MM". A month
   * that could not be read is absent, and its days are unknown rather than $0.
   */
  months: Set<string>;
}

interface GitHubMinuteSpend {
  kind: "minutes";
  used: number;
  included: number;
  paid: number;
}

type GitHubSpend = GitHubDollarSpend | GitHubMinuteSpend;

const actionsOf = (report: { usageItems?: UsageItem[] }): UsageItem[] =>
  (report.usageItems ?? []).filter((item) =>
    String(item.product).toLowerCase() === "actions"
  );

const usagePath = (org: string, year: number, month: number) =>
  `organizations/${org}/settings/billing/usage?year=${year}&month=${month}`;

const monthKey = (year: number, month0: number) =>
  `${year}-${String(month0 + 1).padStart(2, "0")}`;

export const GITHUB_LAG_DAYS = 2;
// How far back a source's newest row may sit before the tile stops reading the
// source. GitHub reports within a day or two of a day ending, so four days
// without a row is a feed that has stopped rather than one running late. A
// stretch where the org bills nothing at all leaves the same gap, and a
// weekend of it stays inside this.
const MAX_REPORT_LAG_DAYS = 4;
const GITHUB_COLOR = "#58a6ff";
const GITHUB_SWATCH = `<span class="swatch" style="background:${
  themedChartSeries(GITHUB_COLOR).color
}"></span>`;

function dayKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === day ? day : null;
}

function addDaily(
  target: Map<string, number>,
  day: string,
  amount: number,
): void {
  if (amount === 0) return;
  target.set(day, (target.get(day) ?? 0) + amount);
}

function addGitHubDays(
  target: Map<string, number>,
  items: UsageItem[],
): void {
  for (const item of items) {
    const day = dayKey(item.date);
    if (!day) continue;
    addDaily(target, day, Number(item.netAmount) || 0);
  }
}

class GitHubUsageShapeError extends Error {}

/**
 * The error a source raises when its newest row is too far back to read the
 * days after it. The message names the source and how far behind it has
 * fallen.
 */
class StalledReportError extends Error {}

/**
 * Throws when the source's newest row sits further back than a source that is
 * still reporting would leave it. A source with no row at all dates nothing and
 * charts nothing, so there is no reading of it to protect.
 */
function requireCurrentReport(
  source: string,
  reportedThrough: string | undefined,
  now: Date,
): void {
  if (reportedThrough === undefined) return;
  const lag = reportLagDays(reportedThrough, now);
  if (lag > MAX_REPORT_LAG_DAYS) {
    throw new StalledReportError(`${source} ${daysLabel(lag)} behind`);
  }
}

async function githubDollarSpend(
  token: string,
  org: string,
  now: Date,
): Promise<GitHubDollarSpend> {
  const year = now.getUTCFullYear();
  const month0 = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  const report = await github<{ usageItems?: UsageItem[] }>(
    usagePath(org, year, month0 + 1),
    token,
  );
  if (!Array.isArray(report.usageItems)) {
    throw new GitHubUsageShapeError("billing usage unavailable");
  }

  // One billing pipeline writes the report, a row at a time, for every product
  // the org used on a day. Its newest row, whatever product that row belongs
  // to, is how far the pipeline has been written. Actions alone would say less:
  // it can be quiet for days while the rest of the org keeps billing, and a
  // quiet week and a stopped report look the same in its rows.
  let reportedThrough: string | undefined;
  const noteReport = (items: UsageItem[] | undefined): void => {
    for (const entry of items ?? []) {
      const day = dayKey(entry.date);
      if (day && (reportedThrough === undefined || day > reportedThrough)) {
        reportedThrough = day;
      }
    }
  };
  noteReport(report.usageItems);

  const current = actionsOf(report);
  const mtd = current.reduce(
    (sum, item) => sum + (Number(item.netAmount) || 0),
    0,
  );
  const byDay = new Map<string, number>();
  addGitHubDays(byDay, current);
  const months = new Set<string>([monthKey(year, month0)]);
  let priorMonthDaily: number[] = [];
  let immediatePrior = true;
  let remaining = SPEND_HISTORY_DAYS - dayOfMonth;
  let previousYear = year;
  let previousMonth = month0;
  while (remaining > 0) {
    previousMonth--;
    if (previousMonth < 0) {
      previousMonth = 11;
      previousYear--;
    }
    try {
      const previous = await github<{ usageItems?: UsageItem[] }>(
        usagePath(org, previousYear, previousMonth + 1),
        token,
      );
      if (Array.isArray(previous.usageItems)) {
        noteReport(previous.usageItems);
        const previousItems = actionsOf(previous);
        addGitHubDays(byDay, previousItems);
        months.add(monthKey(previousYear, previousMonth));
        if (immediatePrior) {
          const previousSeries = calendarMonth(
            byDay,
            previousYear,
            previousMonth,
          );
          priorMonthDaily = settled(
            previousSeries,
            previousSeries.length + dayOfMonth,
            GITHUB_LAG_DAYS,
          );
        }
      }
    } catch {
      // A missing prior month shortens the chart and leaves current billing usable.
    }
    remaining -= new Date(
      Date.UTC(previousYear, previousMonth + 1, 0),
    ).getUTCDate();
    immediatePrior = false;
  }
  requireCurrentReport("GitHub billing report", reportedThrough, now);

  let budget = NaN;
  try {
    const response = await github<{ budgets?: Budget[] }>(
      `organizations/${org}/settings/billing/budgets`,
      token,
    );
    const actions = (response.budgets ?? []).find((entry) =>
      String(entry.budget_product_sku).toLowerCase() === "actions"
    );
    if (actions && Number.isFinite(Number(actions.budget_amount))) {
      budget = Number(actions.budget_amount);
    }
  } catch {
    // An unset GitHub budget leaves the spend projection uncompared.
  }

  return {
    kind: "dollars",
    byDay,
    ...summarizeDailySpend(
      byDay,
      now,
      {
        lagDays: GITHUB_LAG_DAYS,
        measuredMtd: mtd,
        priorMonthDaily,
      },
    ),
    budget,
    months,
  };
}

async function githubSpend(
  token: string,
  org: string,
  now: Date,
): Promise<GitHubSpend> {
  try {
    return await githubDollarSpend(token, org, now);
  } catch (error) {
    // The classic endpoint answers for an org without the enhanced billing
    // platform. A report that is there but unreadable, or there but no longer
    // being written, is not that org.
    if (
      error instanceof GitHubUsageShapeError ||
      error instanceof StalledReportError
    ) {
      throw error;
    }
    const billing = await github<ActionsBilling>(
      `orgs/${org}/settings/billing/actions`,
      token,
    );
    return {
      kind: "minutes",
      used: Number(billing.total_minutes_used) || 0,
      included: Number(billing.included_minutes) || 0,
      paid: Number(billing.total_paid_minutes_used) || 0,
    };
  }
}

function minutesView(
  org: string,
  spend: GitHubMinuteSpend,
): TileView {
  const fraction = spend.included > 0 ? spend.used / spend.included : 0;
  const status: Status = spend.paid > 0 || fraction >= 1
    ? "bad"
    : fraction >= 0.8
    ? "warn"
    : "good";
  return {
    label: "ci spend",
    status,
    value: `${spend.paid} paid min`,
    sub: `${spend.used} / ${spend.included} min · MTD`,
    href: `https://github.com/organizations/${org}/settings/billing`,
    hint: "billing ↗",
  };
}

function unavailableMessage(error: unknown): string {
  if (error instanceof GitHubUsageShapeError) return error.message;
  if (error instanceof StalledReportError) return error.message;
  if (!(error instanceof Error)) return "CI spend unavailable";
  return friendlyError(error.message);
}

export const githubCiSpend: Tile = {
  id: "github-ci-spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const label = "ci spend";
    const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
    if (!token) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "set GH_TOKEN (needs org billing read)",
      };
    }

    const org = ctx.env("GH_BILLING_ORG") ?? REPO.split("/")[0];
    const drill = {
      href: `https://github.com/organizations/${org}/settings/billing`,
      hint: "billing ↗",
    };
    const now = new Date();
    try {
      const spend = await githubSpend(token, org, now);
      if (spend.kind === "minutes") return minutesView(org, spend);

      const budget = spend.budget;
      const status = budgetStatus(spend.projected, budget);
      const chart = spendChart(
        [{
          spend,
          color: GITHUB_COLOR,
          label: usd(spend.mtd),
          lagDays: GITHUB_LAG_DAYS,
          knownMonths: spend.months,
        }],
        now,
        status,
      );
      const amount = chart.chart ? "" : ` ${usd(spend.mtd)}`;
      const budgetLabel = Number.isFinite(budget)
        ? ` • Budget ${usd(budget)}`
        : "";
      const legend =
        `<p class="sub">${GITHUB_SWATCH} GitHub${amount}${budgetLabel}</p>`;

      return {
        ...drill,
        label,
        status,
        value: `~${usd(spend.projected)}/mo`,
        aside: `<span class="hmtd">${usd(spend.mtd)} MTD</span>`,
        extra: `${legend}${chart.chart}`,
        duration: chart.duration,
      };
    } catch (error) {
      return {
        ...drill,
        label,
        status: "unknown",
        value: "—",
        sub: unavailableMessage(error),
        extra: `<p class="sub">${GITHUB_SWATCH} GitHub $???</p>`,
      };
    }
  },
};
