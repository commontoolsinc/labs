// cloud spend: month-to-date GCP cost from a BigQuery billing export, projected
// to a full-month total. Every figure is money the account actually pays: the
// cost of its usage after the credits that come off it. The daily series covers
// up to 45 finished UTC days. The rate window is highlighted. Early in the month
// it reaches into available prior-month history, up to a 14-day total. Cost from
// a day the export is still writing contributes only to the month-to-date total.
//
// The export lands a day's usage in batches, and goes on adding to a day well
// into the following one, so a day it has not finished reads as a fall in spend
// and would drag down any rate measured over it. A day counts as finished once
// the export has written a later day's usage since it last wrote that day's,
// because the export works forward through usage and does not return to a day it
// has left behind. The chart and the rate window both end at the newest finished
// day, and an export that has finished no day in several days grays the tile
// rather than projecting from stale history.
//
// The tile uses the BigQuery REST API, without bq or gcloud. It authenticates as
// the workload's service account in GKE, or with GCP_SA_KEY locally. That account
// needs BigQuery Job User on the query project and Data Viewer on the dataset.
import type { Tile, TileView } from "../types.ts";
import { bigQuery } from "../gcp.ts";
import { budgetStatus, daysLabel, readBudget, usd } from "../lib.ts";
import { DAY_MS, SPEND_HISTORY_DAYS, spendChart, summarizeDailySpend } from "../spend.ts";

const GCP_COLOR = "#4285f4";
// How far behind the newest finished day may fall before the tile stops
// reporting. The export normally finishes a day within a day or two of it
// ending, so this much silence is a broken export rather than a slow one.
const MAX_EXPORT_LAG_DAYS = 4;

// Daily cost, credit, and export progress for the trailing UTC days and today.
// A usage row carries its credits as a repeated field of negative amounts,
// covering promotions, committed- and sustained-use discounts, and the free tier,
// so what the account pays for that row is the two added together. The latest
// export_time of a day's rows is when the export last added to that day.
// Grouping in BigQuery keeps the response small even when the export has many
// rows per service.
const sqlFor = (table: string) =>
  `SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS day, ` +
  `SUM(cost) AS cost, ` +
  `IFNULL(SUM((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit)), 0) ` +
  `AS credits, UNIX_SECONDS(MAX(export_time)) AS exported ` +
  `FROM \`${table}\` ` +
  `WHERE DATE(usage_start_time) >= ` +
  `DATE_SUB(CURRENT_DATE(), INTERVAL ${SPEND_HISTORY_DAYS} DAY) ` +
  `AND DATE(usage_start_time) <= CURRENT_DATE() ` +
  `GROUP BY day ORDER BY day`;

// The billing table is `project.dataset.table`; the query runs in that project,
// where the service account holds Job User.
const projectOf = (table: string) => table.split(".")[0];

function dayTime(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === day ? parsed : null;
}

function amount(cell: string | undefined): number {
  const raw = cell ?? "";
  return raw.trim() === "" ? NaN : Number(raw);
}

interface DailyCost {
  paid: number; // cost after credits
  exported: number; // when the export last added to this day, in seconds
}

interface DailyCostHistory {
  paid: Map<string, number>; // finished days, cost after credits
  paidMtd: number; // this month so far, unfinished days included
  availableSince: string;
  lagDays: number; // days from the newest finished day to today
}

function dailyCosts(
  rows: string[][],
  now: Date,
): DailyCostHistory | null {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const first = today - SPEND_HISTORY_DAYS * DAY_MS;
  const parsed = new Map<string, DailyCost>();
  let oldest = today;
  for (const row of rows) {
    const day = row[0] ?? "";
    const time = dayTime(day);
    const cost = amount(row[1]);
    const credit = amount(row[2]);
    const exported = amount(row[3]);
    if (
      time === null ||
      time < first ||
      time > today ||
      !Number.isFinite(cost) ||
      !Number.isFinite(credit) ||
      !Number.isFinite(exported)
    ) {
      throw new Error("billing history has an unexpected shape");
    }
    parsed.set(day, { paid: cost + credit, exported });
    oldest = Math.min(oldest, time);
  }

  // The newest day the export has finished with: walking back from the newest
  // day, the first one the export stopped adding to before it wrote a later day.
  const days = [...parsed.keys()].sort();
  let laterExport = -Infinity;
  let last: number | undefined;
  for (let index = days.length - 1; index >= 0; index--) {
    const exported = parsed.get(days[index])!.exported;
    if (exported < laterExport) {
      last = dayTime(days[index])!;
      break;
    }
    laterExport = Math.max(laterExport, exported);
  }
  if (last === undefined) return null;

  // Missing dates after the first exported date are real quiet days: the export
  // has moved past them, so there was nothing to bill.
  const paid = new Map<string, number>();
  for (let time = oldest; time <= last; time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    paid.set(day, parsed.get(day)?.paid ?? 0);
  }
  const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-`;
  const paidMtd = [...parsed]
    .filter(([day]) => day.startsWith(monthPrefix))
    .reduce((sum, [, cost]) => sum + cost.paid, 0);
  return {
    paid,
    paidMtd,
    availableSince: new Date(oldest).toISOString().slice(0, 10),
    lagDays: (today - last) / DAY_MS,
  };
}

export const gcpSpend: Tile = {
  id: "gcp-spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const label = "cloud spend";
    const table = ctx.env("GCP_BILLING_TABLE");
    if (!table) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "set GCP_BILLING_TABLE",
      };
    }
    // The table id is interpolated into the query, so keep it to a plain
    // BigQuery identifier, optionally with a partition decorator.
    if (!/^[A-Za-z0-9_.$-]+$/.test(table)) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "invalid GCP_BILLING_TABLE",
      };
    }

    const now = new Date();
    let history: DailyCostHistory | null;
    try {
      const rows = await bigQuery(
        projectOf(table),
        sqlFor(table),
        ctx.env,
      );
      if (rows.length === 0) {
        return {
          label,
          status: "unknown",
          value: "—",
          sub: "no billing data yet",
        };
      }
      history = dailyCosts(rows, now);
    } catch {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "unavailable — check credentials",
      };
    }
    if (!history) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "no billing data yet",
      };
    }
    if (history.lagDays > MAX_EXPORT_LAG_DAYS) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: `billing export ${daysLabel(history.lagDays)} behind`,
      };
    }

    // The rate window stops at the newest finished day, which the export leaves
    // this many days back, so the days it is still writing are left out of the
    // rate rather than counted as days that spent nothing.
    const summary = summarizeDailySpend(
      history.paid,
      now,
      {
        lagDays: history.lagDays,
        availableSince: history.availableSince,
      },
    );
    const daysInMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const dailyBudget = readBudget(ctx.env("GCP_DAILY_BUDGET"));
    const monthlyBudget = dailyBudget * daysInMonth;
    const status = budgetStatus(summary.projected, monthlyBudget);
    const chart = spendChart(
      [{ spend: { byDay: history.paid }, color: GCP_COLOR }],
      now,
      status,
      summary.estimateDays,
    );

    return {
      label,
      status,
      value: `~${usd(summary.projected)}/mo`,
      aside: `<span class="hmtd">${usd(history.paidMtd)} MTD</span>`,
      sub: "billing account spend",
      extra: chart.chart,
      duration: chart.duration,
    };
  },
};
