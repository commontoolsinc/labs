import type {
  MemoryWireAccountingRecord,
  MemoryWireAccountingReport,
  MemoryWireCandidate,
  MemoryWireCandidateScope,
  MemoryWireSemanticBytes,
  MemoryWireSemanticCategory,
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
  truncated?: { reason: string };
  totals: LunchPollWireAccountingTotals;
  rows: LunchPollWireAccountingRow[];
  protocolSemanticRows: LunchPollProtocolSemanticRow[];
  candidateRows: LunchPollWireCandidateRow[];
};

export type LunchPollProtocolSemanticRow = {
  direction: string;
  classification: string;
  category: MemoryWireSemanticCategory;
  actualBytes: number;
  percentOfProtocolClass: number;
  percentOfAllTraffic: number;
};

export type LunchPollWireCandidateRow = {
  category: MemoryWireSemanticCategory;
  scope: MemoryWireCandidateScope;
  candidateBytes: number;
  candidateOccurrences: number;
  repeatOccurrencesConnectionLocal: number;
  repeatBytesConnectionLocal: number;
  referenceCostConnectionLocal: number;
  netSavingsConnectionLocal: number;
};

// This is deliberately a simulation cost, not a protocol claim: a compact
// future reference still needs a marker plus a cache key on the wire.
const CACHE_REFERENCE_BYTES = 12;

const SYNC_CLASSIFICATION_SUFFIX = ".sync";
// Fresh cold/warm Lunch Poll browser runs saved 22.6-22.7% on sync-bearing
// outbound Memory text payload bytes; keep the floor below that observed range
// while still requiring a substantial schema-compression win.
const MIN_SYNC_OUTBOUND_SAVED_PERCENT = 15;
const MIN_REQUEST_SCHEMA_CAS_SAVED_PERCENT = 10;
const MIN_OVERALL_SAVED_PERCENT = 10;
const EXPECTED_BROWSER_CONNECTIONS = 6;
const EXPECTED_REQUEST_CLASSES = new Set([
  "client.graph.query",
  "client.session.watch.add",
  "client.transact",
]);
const SEMANTIC_CATEGORIES: readonly MemoryWireSemanticCategory[] = [
  "encoding",
  "identity",
  "sequence",
  "sessionControl",
  "authCapability",
  "schema",
  "documentValue",
  "patchOperation",
  "queryWatch",
  "sqliteScheduler",
  "error",
  "uncategorized",
];
const CANDIDATE_SCOPES: readonly MemoryWireCandidateScope[] = [
  "alreadyContentAddressed",
  "immutableInternable",
  "identityInternable",
  "seqAddressedRepeatMeasurable",
  "contextualControl",
];

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

export function isMemoryWireAccountingReport(
  payload: unknown,
): payload is MemoryWireAccountingReport {
  if (!isRecord(payload)) return false;
  return isTotals(payload.totals) &&
    isRows(payload.byDirection) &&
    isRows(payload.byConnection) &&
    isRows(payload.byMetadataKind) &&
    isRows(payload.byClassification) &&
    Array.isArray(payload.records) &&
    payload.records.every(isWireAccountingRecord) &&
    (payload.truncated === undefined ||
      (isRecord(payload.truncated) &&
        typeof payload.truncated.reason === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isTotals(value: unknown): boolean {
  return isRecord(value) &&
    isByteCount(value.baselineBytes) &&
    isByteCount(value.actualBytes) &&
    isByteCount(value.frames) &&
    isByteCount(value.connections);
}

function isRows(value: unknown): boolean {
  return Array.isArray(value) &&
    value.every((row) =>
      isRecord(row) && typeof row.key === "string" && isTotals(row)
    );
}

function isWireAccountingRecord(
  value: unknown,
): value is MemoryWireAccountingRecord {
  if (!isRecord(value)) return false;
  return (value.direction === "inbound" || value.direction === "outbound") &&
    typeof value.connectionId === "string" && value.connectionId.length > 0 &&
    typeof value.classification === "string" &&
    value.classification.length > 0 &&
    (value.metadata === undefined ||
      (isRecord(value.metadata) &&
        (value.metadata.kind === undefined ||
          typeof value.metadata.kind === "string"))) &&
    isByteCount(value.baselineBytes) &&
    isByteCount(value.actualBytes) &&
    isSemanticBytes(value.baselineSemanticBytes) &&
    isSemanticBytes(value.actualSemanticBytes) &&
    isCandidates(value.baselineCandidates) &&
    isCandidates(value.actualCandidates);
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSemanticBytes(value: unknown): value is MemoryWireSemanticBytes {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === SEMANTIC_CATEGORIES.length &&
    SEMANTIC_CATEGORIES.every((category) => isByteCount(value[category]));
}

function isCandidates(value: unknown): boolean {
  return value === undefined ||
    (Array.isArray(value) && value.every((candidate) =>
      isRecord(candidate) &&
      SEMANTIC_CATEGORIES.includes(
        candidate.category as MemoryWireSemanticCategory,
      ) &&
      CANDIDATE_SCOPES.includes(
        candidate.scope as MemoryWireCandidateScope,
      ) &&
      typeof candidate.fingerprint === "string" &&
      candidate.fingerprint.length > 0 &&
      isByteCount(candidate.encodedBytes)
    ));
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
  const candidates = new Map<string, {
    category: MemoryWireSemanticCategory;
    scope: MemoryWireCandidateScope;
    candidates: Array<{ candidate: MemoryWireCandidate; connectionId: string }>;
  }>();
  const protocolSemantic = new Map<string, {
    direction: string;
    classification: string;
    category: MemoryWireSemanticCategory;
    actualBytes: number;
  }>();

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

    for (
      const [category, bytes] of Object.entries(
        record.actualSemanticBytes ?? {},
      ) as [MemoryWireSemanticCategory, number][]
    ) {
      if (bytes === 0) continue;
      const protocolKey =
        `${record.direction}\u0000${record.classification}\u0000${category}`;
      let protocolGroup = protocolSemantic.get(protocolKey);
      if (protocolGroup === undefined) {
        protocolGroup = {
          direction: record.direction,
          classification: record.classification,
          category,
          actualBytes: 0,
        };
        protocolSemantic.set(protocolKey, protocolGroup);
      }
      protocolGroup.actualBytes += bytes;
    }

    for (const candidate of record.actualCandidates ?? []) {
      addCandidateRow(candidates, candidate, record.connectionId);
    }
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
  const protocolClassActualBytes = new Map(
    rows.map((row) => [
      `${row.direction}\u0000${row.classification}`,
      row.actualBytes,
    ]),
  );
  const protocolSemanticRows = [...protocolSemantic.values()].map((row) => {
    const protocolActualBytes = protocolClassActualBytes.get(
      `${row.direction}\u0000${row.classification}`,
    ) ?? 0;
    return {
      ...row,
      percentOfProtocolClass: protocolActualBytes === 0
        ? 0
        : (row.actualBytes / protocolActualBytes) * 100,
      percentOfAllTraffic: actualBytes === 0
        ? 0
        : (row.actualBytes / actualBytes) * 100,
    };
  }).sort((left, right) =>
    left.classification.localeCompare(right.classification) ||
    left.direction.localeCompare(right.direction) ||
    left.category.localeCompare(right.category)
  );
  const candidateRows = [...candidates.values()].map((group) => {
    const uniqueConnection = new Set<string>();
    let repeatBytesConnectionLocal = 0;
    let repeatOccurrencesConnectionLocal = 0;
    for (const { candidate, connectionId } of group.candidates) {
      const connectionKey = `${connectionId}\u0000${candidate.fingerprint}`;
      if (uniqueConnection.has(connectionKey)) {
        repeatBytesConnectionLocal += candidate.encodedBytes;
        repeatOccurrencesConnectionLocal += 1;
      }
      uniqueConnection.add(connectionKey);
    }
    const candidateOccurrences = group.candidates.length;
    const referenceCostConnectionLocal = repeatOccurrencesConnectionLocal *
      CACHE_REFERENCE_BYTES;
    return {
      category: group.category,
      scope: group.scope,
      candidateBytes: group.candidates.reduce(
        (sum, item) => sum + item.candidate.encodedBytes,
        0,
      ),
      candidateOccurrences,
      repeatOccurrencesConnectionLocal,
      repeatBytesConnectionLocal,
      referenceCostConnectionLocal,
      netSavingsConnectionLocal: Math.max(
        0,
        repeatBytesConnectionLocal - referenceCostConnectionLocal,
      ),
    };
  }).sort((left, right) =>
    left.category.localeCompare(right.category) ||
    left.scope.localeCompare(right.scope)
  );

  return {
    records,
    truncated: report.truncated === undefined
      ? undefined
      : { ...report.truncated },
    totals: toTotals(baselineBytes, actualBytes, records.length, connections),
    rows,
    protocolSemanticRows,
    candidateRows,
  };
}

function addCandidateRow(
  groups: Map<string, {
    category: MemoryWireSemanticCategory;
    scope: MemoryWireCandidateScope;
    candidates: Array<{ candidate: MemoryWireCandidate; connectionId: string }>;
  }>,
  candidate: MemoryWireCandidate,
  connectionId: string,
): void {
  candidateGroup(groups, candidate.category, candidate.scope).candidates.push({
    candidate,
    connectionId,
  });
}

function candidateGroup(
  groups: Map<string, {
    category: MemoryWireSemanticCategory;
    scope: MemoryWireCandidateScope;
    candidates: Array<{ candidate: MemoryWireCandidate; connectionId: string }>;
  }>,
  category: MemoryWireSemanticCategory,
  scope: MemoryWireCandidateScope,
) {
  const key = `${category}\u0000${scope}`;
  let group = groups.get(key);
  if (group === undefined) {
    group = { category, scope, candidates: [] };
    groups.set(key, group);
  }
  return group;
}

function isOutboundSync(record: MemoryWireAccountingRecord): boolean {
  return record.direction === "outbound" &&
    record.classification.endsWith(SYNC_CLASSIFICATION_SUFFIX);
}

const REQUEST_SCHEMA_CAS_CLASSIFICATIONS = new Set([
  "client.graph.query",
  "client.session.watch.set",
  "client.session.watch.add",
  "client.transact",
]);

function isInboundRequestSchemaCas(
  record: MemoryWireAccountingRecord,
): boolean {
  return record.direction === "inbound" &&
    REQUEST_SCHEMA_CAS_CLASSIFICATIONS.has(record.classification);
}

export function validateLunchPollWireAccounting(
  analysis: LunchPollWireAccountingAnalysis,
  options: { requestSchemaCasEnabled?: boolean } = {},
): string[] {
  const requestSchemaCasEnabled = options.requestSchemaCasEnabled ?? true;
  const errors: string[] = [];
  if (analysis.truncated !== undefined) {
    errors.push(
      `wire accounting report truncated: ${analysis.truncated.reason}`,
    );
  }
  const connectionIds = new Set(
    analysis.records.map((record) => record.connectionId),
  );

  if (analysis.records.length === 0) {
    errors.push("expected at least one browser Memory websocket frame");
  }
  if (connectionIds.size !== EXPECTED_BROWSER_CONNECTIONS) {
    errors.push(
      `expected ${EXPECTED_BROWSER_CONNECTIONS} distinct browser Memory connections for the two-browser Lunch Poll workload, got ${connectionIds.size}`,
    );
  }

  const observedRequestClasses = new Set(
    analysis.records
      .filter((record) => record.direction === "inbound")
      .map((record) => record.classification),
  );
  for (const classification of EXPECTED_REQUEST_CLASSES) {
    if (!observedRequestClasses.has(classification)) {
      errors.push(
        `expected inbound browser traffic for ${classification}`,
      );
    }
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
    validateRecordEvidence(record, errors);
    if (record.actualSemanticBytes !== undefined) {
      const candidateBytes = (record.actualCandidates ?? []).reduce(
        (sum, candidate) => sum + candidate.encodedBytes,
        0,
      );
      if (candidateBytes > record.actualBytes) {
        errors.push(
          `candidate bytes exceed actual bytes for ${record.classification}: candidates=${candidateBytes} actual=${record.actualBytes}`,
        );
      }
    }
    if (
      record.direction === "inbound" &&
      (!requestSchemaCasEnabled || !isInboundRequestSchemaCas(record)) &&
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

  const inboundRequestSchemaCasRecords = analysis.records.filter(
    isInboundRequestSchemaCas,
  );
  const inboundRequestSchemaCasBaseline = inboundRequestSchemaCasRecords.reduce(
    (sum, record) => sum + record.baselineBytes,
    0,
  );
  const inboundRequestSchemaCasActual = inboundRequestSchemaCasRecords.reduce(
    (sum, record) => sum + record.actualBytes,
    0,
  );
  if (inboundRequestSchemaCasRecords.length === 0) {
    errors.push("expected at least one request-schema-CAS browser frame");
  } else if (
    requestSchemaCasEnabled &&
    !(inboundRequestSchemaCasActual < inboundRequestSchemaCasBaseline)
  ) {
    errors.push(
      `expected request-schema-CAS inbound browser aggregate actual bytes to be less than baseline: baseline=${inboundRequestSchemaCasBaseline} actual=${inboundRequestSchemaCasActual}`,
    );
  } else if (
    !requestSchemaCasEnabled &&
    inboundRequestSchemaCasActual !== inboundRequestSchemaCasBaseline
  ) {
    errors.push(
      `expected request-schema-CAS-capable inbound browser aggregate bytes to remain inline when disabled: baseline=${inboundRequestSchemaCasBaseline} actual=${inboundRequestSchemaCasActual}`,
    );
  }
  if (requestSchemaCasEnabled && inboundRequestSchemaCasBaseline > 0) {
    const requestSchemaCasSavedPercent = savedPercent(
      inboundRequestSchemaCasBaseline,
      inboundRequestSchemaCasActual,
    );
    if (requestSchemaCasSavedPercent < MIN_REQUEST_SCHEMA_CAS_SAVED_PERCENT) {
      errors.push(
        `expected at least ${
          formatPercent(MIN_REQUEST_SCHEMA_CAS_SAVED_PERCENT)
        } savings on request-schema-CAS inbound browser bytes, got ${
          formatPercent(requestSchemaCasSavedPercent)
        }`,
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
  if (analysis.totals.baselineBytes > 0) {
    const overallSavedPercent = savedPercent(
      analysis.totals.baselineBytes,
      analysis.totals.actualBytes,
    );
    if (overallSavedPercent < MIN_OVERALL_SAVED_PERCENT) {
      errors.push(
        `expected at least ${
          formatPercent(MIN_OVERALL_SAVED_PERCENT)
        } overall browser-byte savings, got ${
          formatPercent(overallSavedPercent)
        }`,
      );
    }
  }

  return errors;
}

function validateRecordEvidence(
  record: MemoryWireAccountingRecord,
  errors: string[],
): void {
  if (!isByteCount(record.baselineBytes) || !isByteCount(record.actualBytes)) {
    errors.push(
      `invalid byte count for ${record.classification} on ${record.connectionId}`,
    );
    return;
  }
  if (
    !isCandidates(record.baselineCandidates) ||
    !isCandidates(record.actualCandidates)
  ) {
    errors.push(
      `invalid candidate evidence for ${record.classification}`,
    );
  }
  validateSemanticEvidence(
    "baseline",
    record.baselineSemanticBytes,
    record.baselineBytes,
    record.classification,
    errors,
  );
  validateSemanticEvidence(
    "actual",
    record.actualSemanticBytes,
    record.actualBytes,
    record.classification,
    errors,
  );
}

function validateSemanticEvidence(
  label: "baseline" | "actual",
  semanticBytes: MemoryWireSemanticBytes | undefined,
  bytes: number,
  classification: string,
  errors: string[],
): void {
  if (!isSemanticBytes(semanticBytes)) {
    errors.push(`invalid ${label} semantic map for ${classification}`);
    return;
  }
  const semanticTotal = Object.values(semanticBytes).reduce(
    (sum, categoryBytes) => sum + categoryBytes,
    0,
  );
  if (semanticTotal !== bytes) {
    errors.push(
      `${label} semantic bytes differ for ${classification}: semantic=${semanticTotal} ${label}=${bytes}`,
    );
  }
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

  lines.push(
    "direction | classification | category | actual bytes | % of protocol class | % of all traffic",
  );
  for (const row of analysis.protocolSemanticRows) {
    lines.push(
      `${row.direction} | ${row.classification} | ${row.category} | ${row.actualBytes} | ${
        formatPercent(row.percentOfProtocolClass)
      } | ${formatPercent(row.percentOfAllTraffic)}`,
    );
  }

  lines.push(
    "category | scope | candidate bytes | candidates | repeats (connection) | repeat bytes (connection) | reference cost (connection) | net savings (connection)",
  );
  for (const row of analysis.candidateRows) {
    lines.push(
      `${row.category} | ${row.scope} | ${row.candidateBytes} | ${row.candidateOccurrences} | ${row.repeatOccurrencesConnectionLocal} | ${row.repeatBytesConnectionLocal} | ${row.referenceCostConnectionLocal} | ${row.netSavingsConnectionLocal}`,
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
