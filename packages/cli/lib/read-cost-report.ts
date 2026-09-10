/**
 * Builds per-step read-cost reports from completed scheduler runs. The report
 * retains runs whose actions have left the graph and counts each marker once.
 */

import type { RuntimeTelemetryMarker } from "@commonfabric/runner";

type RunComplete = Extract<
  RuntimeTelemetryMarker,
  { type: "scheduler.run.complete" }
>;
type Counts = NonNullable<RunComplete["reads"]>;

interface Row {
  label: string;
  runs: number;
  proxyAccesses: number;
  linkResolutions: number;
  distinctDocuments: number;
  dependencies: number;
}

/** Accumulates measured runs for one initialization or test-step interval. */
export class ReadCostReport {
  readonly #rows = new Map<string, Row>();

  /** Records one completed run, including runs without an authored source. */
  record(marker: RuntimeTelemetryMarker): void {
    if (
      marker.type !== "scheduler.run.complete" || marker.reads === undefined
    ) return;
    let row = this.#rows.get(marker.actionId);
    if (row === undefined) {
      row = {
        label: marker.actionInfo?.src ?? marker.actionInfo?.moduleName ??
          marker.actionId,
        runs: 0,
        proxyAccesses: 0,
        linkResolutions: 0,
        distinctDocuments: 0,
        dependencies: 0,
      };
      this.#rows.set(marker.actionId, row);
    }
    row.runs++;
    ReadCostReport.#add(row, marker.reads);
  }

  /** Clears the interval before the next step begins. */
  clear(): void {
    this.#rows.clear();
  }

  /**
   * Returns access-ranked rows and untruncated totals. Documents and dependencies
   * are sums of per-run cardinalities, not unions across the interval.
   */
  lines(label: string, limit: number): string[] {
    const rows = [...this.#rows.values()].sort((a, b) =>
      b.proxyAccesses - a.proxyAccesses ||
      b.linkResolutions - a.linkResolutions ||
      a.label.localeCompare(b.label)
    );
    const total: Row = {
      label,
      runs: 0,
      proxyAccesses: 0,
      linkResolutions: 0,
      distinctDocuments: 0,
      dependencies: 0,
    };
    for (const row of rows) {
      total.runs += row.runs;
      ReadCostReport.#add(total, row);
    }
    return [
      `    Read cost (${label}; action bodies): ${
        ReadCostReport.#format(total)
      }`,
      ...rows.slice(0, Math.max(0, limit)).map((row) =>
        `      ${ReadCostReport.#format(row)} — ${row.label}`
      ),
    ];
  }

  /** Helper for interval accumulation, which adds independent counter fields. */
  static #add(row: Row, counts: Counts): void {
    row.proxyAccesses += counts.proxyAccesses;
    row.linkResolutions += counts.linkResolutions;
    row.distinctDocuments += counts.distinctDocuments;
    row.dependencies += counts.dependencies;
  }

  /** Helper for report rows, which labels cardinality sums explicitly. */
  static #format(row: Row): string {
    return `${row.runs} runs, ${row.proxyAccesses} accesses, ${row.linkResolutions} link hops, ` +
      `${row.distinctDocuments} document-runs, ${row.dependencies} dependency-runs`;
  }
}
