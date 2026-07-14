import type {
  MemoryWireAccountingRecord,
  MemoryWireAccountingReport,
} from "@commonfabric/memory/v2/wire-accounting";

export type LunchPollWireAccountingTotals = {
  baselineBytes: number;
  actualBytes: number;
  frames: number;
  connections: number;
  savedBytes: number;
  savedPercent: number;
};

export type LunchPollWireAccountingRow = LunchPollWireAccountingTotals & {
  direction: string;
  classification: string;
};

export type LunchPollWireAccountingAnalysis = {
  records: MemoryWireAccountingRecord[];
  totals: LunchPollWireAccountingTotals;
  rows: LunchPollWireAccountingRow[];
};

const SYNC_CLASSIFICATION_SUFFIX = ".sync";
// First measured real Lunch Poll browser run saved 22.9% on sync-bearing
// outbound Memory text payload bytes; keep the floor below that observed value
// while still requiring a substantial schema-compression win.
const MIN_SYNC_OUTBOUND_SAVED_PERCENT = 15;

function savedPercent(baselineBytes: number, actualBytes: number): number {
  if (baselineBytes === 0) return 0;
  return ((baselineBytes - actualBytes) / baselineBytes) * 100;
}

function toTotals(
  baselineBytes: number,
  actualBytes: number,
  frames: number,
  connectionIds: Set<string>,
): LunchPollWireAccountingTotals {
  return {
    baselineBytes,
    actualBytes,
    frames,
    connections: connectionIds.size,
    savedBytes: baselineBytes - actualBytes,
    savedPercent: savedPercent(baselineBytes, actualBytes),
  };
}

function browserRecords(
  report: MemoryWireAccountingReport,
): MemoryWireAccountingRecord[] {
  return report.records.filter((record) => record.metadata?.kind === "browser");
}

export function analyzeLunchPollWireAccounting(
  report: MemoryWireAccountingReport,
): LunchPollWireAccountingAnalysis {
  const records = browserRecords(report);
  const connections = new Set<string>();
  let baselineBytes = 0;
  let actualBytes = 0;

  const groups = new Map<
    string,
    {
      direction: string;
      classification: string;
      baselineBytes: number;
      actualBytes: number;
      frames: number;
      connections: Set<string>;
    }
  >();

  for (const record of records) {
    baselineBytes += record.baselineBytes;
    actualBytes += record.actualBytes;
    connections.add(record.connectionId);

    const key = `${record.direction}\u0000${record.classification}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        direction: record.direction,
        classification: record.classification,
        baselineBytes: 0,
        actualBytes: 0,
        frames: 0,
        connections: new Set(),
      };
      groups.set(key, group);
    }
    group.baselineBytes += record.baselineBytes;
    group.actualBytes += record.actualBytes;
    group.frames += 1;
    group.connections.add(record.connectionId);
  }

  const rows = [...groups.values()].map((group) => ({
    direction: group.direction,
    classification: group.classification,
    ...toTotals(
      group.baselineBytes,
      group.actualBytes,
      group.frames,
      group.connections,
    ),
  })).sort((left, right) =>
    left.classification.localeCompare(right.classification) ||
    left.direction.localeCompare(right.direction)
  );

  return {
    records,
    totals: toTotals(baselineBytes, actualBytes, records.length, connections),
    rows,
  };
}

function isOutboundSync(record: MemoryWireAccountingRecord): boolean {
  return record.direction === "outbound" &&
    record.classification.endsWith(SYNC_CLASSIFICATION_SUFFIX);
}

export function validateLunchPollWireAccounting(
  analysis: LunchPollWireAccountingAnalysis,
): string[] {
  const errors: string[] = [];
  const connectionIds = new Set(
    analysis.records.map((record) => record.connectionId),
  );

  if (analysis.records.length === 0) {
    errors.push("expected at least one browser Memory websocket frame");
  }
  if (connectionIds.size < 2) {
    errors.push(
      `expected at least two distinct browser Memory connections, got ${connectionIds.size}`,
    );
  }

  const baselineConnections = new Set(
    analysis.records
      .filter((record) => record.baselineBytes > 0)
      .map((record) => record.connectionId),
  );
  const actualConnections = new Set(
    analysis.records
      .filter((record) => record.actualBytes > 0)
      .map((record) => record.connectionId),
  );
  if (!sameSet(baselineConnections, actualConnections)) {
    errors.push(
      `baseline and actual browser connection sets differ: baseline=${
        sortedSet(baselineConnections).join(",")
      } actual=${sortedSet(actualConnections).join(",")}`,
    );
  }

  for (const record of analysis.records) {
    if (
      record.direction === "inbound" &&
      record.baselineBytes !== record.actualBytes
    ) {
      errors.push(
        `inbound ${record.classification} frame on ${record.connectionId} changed bytes: baseline=${record.baselineBytes} actual=${record.actualBytes}`,
      );
    }
    if (
      record.direction === "outbound" &&
      !record.classification.endsWith(SYNC_CLASSIFICATION_SUFFIX) &&
      record.baselineBytes !== record.actualBytes
    ) {
      errors.push(
        `outbound non-sync ${record.classification} frame on ${record.connectionId} changed bytes: baseline=${record.baselineBytes} actual=${record.actualBytes}`,
      );
    }
  }

  const outboundSyncRecords = analysis.records.filter(isOutboundSync);
  const savedOutboundSyncRecords = outboundSyncRecords.filter((record) =>
    record.actualBytes < record.baselineBytes
  );
  if (savedOutboundSyncRecords.length === 0) {
    errors.push(
      "expected at least one outbound sync-bearing browser frame to save bytes",
    );
  }

  const outboundSyncBaseline = outboundSyncRecords.reduce(
    (sum, record) => sum + record.baselineBytes,
    0,
  );
  const outboundSyncActual = outboundSyncRecords.reduce(
    (sum, record) => sum + record.actualBytes,
    0,
  );
  if (!(outboundSyncActual < outboundSyncBaseline)) {
    errors.push(
      `expected sync-bearing outbound browser aggregate actual bytes to be less than baseline: baseline=${outboundSyncBaseline} actual=${outboundSyncActual}`,
    );
  }
  if (outboundSyncBaseline > 0) {
    const outboundSyncSavedPercent = savedPercent(
      outboundSyncBaseline,
      outboundSyncActual,
    );
    if (outboundSyncSavedPercent < MIN_SYNC_OUTBOUND_SAVED_PERCENT) {
      errors.push(
        `expected at least ${
          formatPercent(MIN_SYNC_OUTBOUND_SAVED_PERCENT)
        } savings on sync-bearing outbound browser bytes, got ${
          formatPercent(outboundSyncSavedPercent)
        }`,
      );
    }
  }

  if (!(analysis.totals.actualBytes < analysis.totals.baselineBytes)) {
    errors.push(
      `expected overall browser actual bytes to be less than baseline: baseline=${analysis.totals.baselineBytes} actual=${analysis.totals.actualBytes}`,
    );
  }

  return errors;
}

export function formatLunchPollWireAccounting(
  analysis: LunchPollWireAccountingAnalysis,
): string {
  const totals = analysis.totals;
  const lines = [
    `baseline ${totals.baselineBytes} bytes over ${totals.connections} browser connections; actual ${totals.actualBytes} bytes over ${totals.connections} browser connections; saved ${totals.savedBytes} bytes (${
      formatPercent(totals.savedPercent)
    })`,
    "direction | classification | frames | baseline bytes | actual bytes | saved bytes | saved %",
  ];

  for (const row of analysis.rows) {
    lines.push(
      `${row.direction} | ${row.classification} | ${row.frames} | ${row.baselineBytes} | ${row.actualBytes} | ${row.savedBytes} | ${
        formatPercent(row.savedPercent)
      }`,
    );
  }

  return lines.join("\n");
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function sortedSet(values: Set<string>): string[] {
  return [...values].sort();
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
