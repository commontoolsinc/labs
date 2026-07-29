// cloud spend: month-to-date GCP cost from a BigQuery billing export, projected
// to a full-month total. The daily series covers up to 45 complete UTC days.
// The rate window is highlighted. Early in the month it reaches into available
// prior-month history, up to a 14-day total. Today's partial cost contributes
// only to the month-to-date total.
//
// The tile uses the BigQuery REST API, without bq or gcloud. It authenticates as
// the workload's service account in GKE, or with GCP_SA_KEY locally. That account
// needs BigQuery Job User on the query project and Data Viewer on the dataset.
import type { Tile, TileView } from "../types.ts";
import { bigQuery } from "../gcp.ts";
import { budgetStatus, readBudget, usd } from "../lib.ts";
import { DAY_MS, SPEND_HISTORY_DAYS, spendChart, summarizeDailySpend } from "../spend.ts";

const GCP_COLOR = "#4285f4";
const GCP_LAG_DAYS = 1;

// Daily gross cost for the trailing complete UTC days and today. Grouping in
// BigQuery keeps the response small even when the export has many rows per
// service.
const sqlFor = (table: string) =>
  `SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS day, ` +
  `SUM(cost) AS cost FROM \`${table}\` ` +
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

interface DailyCostHistory {
  complete: Map<string, number>;
  actualMtd: number;
  availableSince: string;
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
  const last = today - DAY_MS;
  const first = today - SPEND_HISTORY_DAYS * DAY_MS;
  const parsed = new Map<string, number>();
  let oldest = today;
  for (const row of rows) {
    const day = row[0] ?? "";
    const time = dayTime(day);
    const raw = row[1] ?? "";
    const cost = raw.trim() === "" ? NaN : Number(raw);
    if (
      time === null ||
      time < first ||
      time > today ||
      !Number.isFinite(cost)
    ) {
      throw new Error("billing history has an unexpected shape");
    }
    parsed.set(day, cost);
    oldest = Math.min(oldest, time);
  }

  const lastDay = new Date(last).toISOString().slice(0, 10);
  if (!parsed.has(lastDay)) return null;

  // Missing dates after the first exported date are real quiet days once the
  // query's one-day billing lag has elapsed.
  const complete = new Map<string, number>();
  for (let time = oldest; time <= last; time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    complete.set(day, parsed.get(day) ?? 0);
  }
  const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-`;
  const actualMtd = [...parsed]
    .filter(([day]) => day.startsWith(monthPrefix))
    .reduce((sum, [, cost]) => sum + cost, 0);
  return {
    complete,
    actualMtd,
    availableSince: new Date(oldest).toISOString().slice(0, 10),
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

    const summary = summarizeDailySpend(
      history.complete,
      now,
      {
        lagDays: GCP_LAG_DAYS,
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
      [{ spend: { byDay: history.complete }, color: GCP_COLOR }],
      now,
      status,
      summary.estimateDays,
    );

    return {
      label,
      status,
      value: `~${usd(summary.projected)}/mo`,
      aside: `<span class="hmtd">${usd(history.actualMtd)} MTD</span>`,
      sub: "billing account spend",
      extra: chart.chart,
      duration: chart.duration,
    };
  },
};
