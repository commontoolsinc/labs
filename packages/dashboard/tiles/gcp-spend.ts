// cloud spend: yesterday's total GCP cost, summed from a BigQuery billing-export
// table over the BigQuery REST API — no bq/gcloud CLI. Auth is the workload's own
// service account: the GKE metadata server in the cluster (Workload Identity), or
// a service-account key in GCP_SA_KEY for local development. That account needs
// BigQuery Job User on the query project and Data Viewer on the dataset, and a
// billing export to BigQuery must exist. Status compares the day's spend against
// an optional daily budget.
import type { Tile, TileView } from "../types.ts";
import { bigQuery } from "../gcp.ts";
import { budgetStatus, readBudget, usd } from "../lib.ts";

// Sums cost for the most recent full UTC day from the billing-export table.
const sqlFor = (table: string) =>
  "SELECT SUM(cost) AS cost FROM `" + table +
  "` WHERE DATE(usage_start_time) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)";

// The billing table is `project.dataset.table`; the query runs in that project,
// where the service account holds Job User.
const projectOf = (table: string) => table.split(".")[0];

export const gcpSpend: Tile = {
  id: "gcp-spend",
  intervalMs: 3_600_000,
  async collect(ctx): Promise<TileView> {
    const label = "cloud spend";
    const table = ctx.env("GCP_BILLING_TABLE");
    if (!table) return { label, status: "unknown", value: "—", sub: "set GCP_BILLING_TABLE" };
    // The table id is interpolated into the query, so keep it to a plain BigQuery
    // identifier (project.dataset.table, optionally with a $ partition decorator).
    if (!/^[A-Za-z0-9_.$-]+$/.test(table)) {
      return { label, status: "unknown", value: "—", sub: "invalid GCP_BILLING_TABLE" };
    }

    let cost: number;
    try {
      const rows = await bigQuery(projectOf(table), sqlFor(table), ctx.env);
      const raw = rows[0]?.[0];
      // SUM over a day with no exported rows is NULL (an empty cell), which means
      // the export hasn't landed yet — distinct from a genuine zero, so don't
      // report "$0/day".
      if (raw == null || raw === "") {
        return { label, status: "unknown", value: "—", sub: "no billing data yet" };
      }
      cost = Number(raw);
      if (!Number.isFinite(cost)) {
        return { label, status: "unknown", value: "—", sub: "unavailable — check credentials" };
      }
    } catch {
      return { label, status: "unknown", value: "—", sub: "unavailable — check credentials" };
    }

    return {
      label,
      status: budgetStatus(cost, readBudget(ctx.env("GCP_DAILY_BUDGET"))),
      value: `${usd(cost)}/day`,
      sub: "yesterday · project spend",
    };
  },
};
