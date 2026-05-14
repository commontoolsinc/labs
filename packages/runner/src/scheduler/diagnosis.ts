import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { getTransactionWriteDetails } from "../storage/transaction-inspection.ts";
import { ignoreReadForScheduling } from "../storage/reactivity-log.ts";
import type {
  CycleReport,
  NonIdempotentReport,
  SchedulerActionInfo,
} from "../telemetry.ts";
import { txToReactivityLog } from "./reactivity.ts";
import { mapsEqual } from "./topology.ts";
import type { Action, ReactivityLog } from "./types.ts";

export type DiagnosisRecord = {
  readValues: Map<string, unknown>;
  writeValues: Map<string, unknown>;
  timestamp: number;
};

export function makeAddressKey(addr: IMemorySpaceAddress): string {
  return `${addr.space}/${addr.id}/${addr.path.join("/")}`;
}

function unwrapTransactionDetailValue(value: unknown): unknown {
  return isRecord(value) && "value" in value ? value.value : value;
}

export function captureTransactionWrites(
  tx: IExtendedStorageTransaction,
  writes: readonly IMemorySpaceAddress[],
  options: { errorValue?: unknown } = {},
): Map<string, unknown> {
  const writeValues = new Map<string, unknown>();
  const writeDetailsBySpace = new Map<string, Map<string, unknown>>();

  for (const write of writes) {
    const key = makeAddressKey(write);
    try {
      let details = writeDetailsBySpace.get(write.space);
      if (!details) {
        details = new Map<string, unknown>();
        for (const detail of getTransactionWriteDetails(tx, write.space)) {
          details.set(
            makeAddressKey(detail.address),
            unwrapTransactionDetailValue(detail.value),
          );
        }
        writeDetailsBySpace.set(write.space, details);
      }
      writeValues.set(key, details.has(key) ? details.get(key) : undefined);
    } catch (error) {
      if (!("errorValue" in options)) throw error;
      writeValues.set(key, options.errorValue);
    }
  }

  return writeValues;
}

export function captureCommittedReads(
  reads: readonly IMemorySpaceAddress[],
  createReadTx: () => IExtendedStorageTransaction,
): Map<string, unknown> {
  const readValues = new Map<string, unknown>();

  for (const read of reads) {
    const key = makeAddressKey(read);
    let readerTx: IExtendedStorageTransaction | undefined;
    try {
      readerTx = createReadTx();
      const result = readerTx.tx.read(
        {
          space: read.space,
          id: read.id,
          path: [...read.path],
        },
        { meta: ignoreReadForScheduling },
      );
      readValues.set(key, result.ok?.value);
    } catch {
      readValues.set(key, "[read-error]");
    } finally {
      readerTx?.abort();
    }
  }

  return readValues;
}

export function findDifferingWriteKeys(
  previousWrites: Map<string, unknown>,
  latestWrites: Map<string, unknown>,
  options: { keySet?: "union" | "latest" } = {},
): string[] {
  const keys = options.keySet === "latest"
    ? latestWrites.keys()
    : new Set([...latestWrites.keys(), ...previousWrites.keys()]).keys();
  const differingKeys: string[] = [];

  for (const key of keys) {
    if (!previousWrites.has(key)) {
      differingKeys.push(key);
      continue;
    }
    if (!deepEqual(previousWrites.get(key), latestWrites.get(key))) {
      differingKeys.push(key);
    }
  }

  return differingKeys;
}

export function findNonIdempotentPair(
  history: DiagnosisRecord[],
): {
  previous: DiagnosisRecord;
  latest: DiagnosisRecord;
  differingWriteKeys: string[];
} | undefined {
  if (history.length < 2) return undefined;

  const latest = history[history.length - 1];
  for (const previous of history.slice(0, -1)) {
    // Same reads with different writes is the diagnosis signal.
    if (!mapsEqual(latest.readValues, previous.readValues)) continue;

    const differingWriteKeys = findDifferingWriteKeys(
      previous.writeValues,
      latest.writeValues,
    );
    if (differingWriteKeys.length > 0) {
      return { previous, latest, differingWriteKeys };
    }
  }

  return undefined;
}

export function runIdempotencyRecheck(
  state: {
    readonly idempotencyViolations: NonIdempotentReport[];
    readonly createTx: () => IExtendedStorageTransaction;
    readonly invoke: (fn: () => unknown) => unknown;
    readonly getActionId: (action: Action) => string;
    readonly getActionTelemetryInfo: (
      action: Action,
    ) => SchedulerActionInfo | undefined;
  },
  action: Action,
  tx: IExtendedStorageTransaction,
  log: ReactivityLog,
): void {
  const writes1 = captureTransactionWrites(tx, log.writes);

  const tx2 = state.createTx();
  let isAsync = false;
  try {
    const result = state.invoke(() => action(tx2));
    // Async actions (e.g. raw module actions like wish) can't be safely
    // rechecked: their continuations may fire side effects (runtime.runSynced,
    // sub-pattern instantiation) that persist beyond tx2.abort(). Skip the
    // comparison entirely and just swallow the dangling promise.
    if (result && typeof (result as Promise<unknown>).then === "function") {
      isAsync = true;
      (result as Promise<unknown>).then(undefined, () => {});
    }
  } catch { /* ignore errors */ }
  const log2 = txToReactivityLog(tx2);
  const writes2 = isAsync
    ? new Map()
    : captureTransactionWrites(tx2, log2.writes);
  tx2.abort();

  // Skip comparison for async actions; writes are incomplete/unreliable.
  if (isAsync) return;

  const differingKeys = findDifferingWriteKeys(writes1, writes2, {
    keySet: "latest",
  });

  if (differingKeys.length === 0) return;

  const actionId = state.getActionId(action);
  // Deduplicate: only record first violation per action.
  if (state.idempotencyViolations.some((v) => v.actionId === actionId)) {
    return;
  }

  state.idempotencyViolations.push({
    actionId,
    actionInfo: state.getActionTelemetryInfo(action),
    runs: [
      {
        timestamp: performance.now(),
        reads: {},
        writes: Object.fromEntries(writes1),
      },
      {
        timestamp: performance.now(),
        reads: {},
        writes: Object.fromEntries(writes2),
      },
    ],
    differingWriteKeys: differingKeys,
  });
}

export function captureDiagnosisRecord(state: {
  readonly diagnosisHistory: Map<string, DiagnosisRecord[]>;
  readonly diagnosisNonIdempotent: NonIdempotentReport[];
  readonly createReadTx: () => IExtendedStorageTransaction;
  readonly getActionTelemetryInfo: (
    action: Action,
  ) => SchedulerActionInfo | undefined;
}, args: {
  readonly actionId: string;
  readonly action: Action;
  readonly tx: IExtendedStorageTransaction;
  readonly log: ReactivityLog;
}): void {
  const record = {
    // Committed reads model what a later run with the same inputs would see.
    readValues: captureCommittedReads(args.log.reads, state.createReadTx),
    writeValues: captureTransactionWrites(args.tx, args.log.writes, {
      errorValue: "[write-error]",
    }),
    timestamp: performance.now(),
  };

  // Store in ring buffer (max 10 per action).
  let history = state.diagnosisHistory.get(args.actionId);
  if (!history) {
    history = [];
    state.diagnosisHistory.set(args.actionId, history);
  }
  history.push(record);
  if (history.length > 10) {
    history.shift();
  }

  const nonIdempotent = findNonIdempotentPair(history);
  if (!nonIdempotent) return;

  // Non-idempotent detected. Only report once per action.
  const existing = state.diagnosisNonIdempotent.find(
    (r) => r.actionId === args.actionId,
  );
  if (existing) return;

  state.diagnosisNonIdempotent.push({
    actionId: args.actionId,
    actionInfo: state.getActionTelemetryInfo(args.action),
    runs: [
      {
        timestamp: nonIdempotent.previous.timestamp,
        reads: Object.fromEntries(nonIdempotent.previous.readValues),
        writes: Object.fromEntries(nonIdempotent.previous.writeValues),
      },
      {
        timestamp: nonIdempotent.latest.timestamp,
        reads: Object.fromEntries(nonIdempotent.latest.readValues),
        writes: Object.fromEntries(nonIdempotent.latest.writeValues),
      },
    ],
    differingWriteKeys: nonIdempotent.differingWriteKeys,
  });
}

export function detectCausalCycles(
  causalEdges: readonly { writer: string; triggered: string; cell: string }[],
): CycleReport[] {
  // Build adjacency list: writer -> [{ triggered, cell }]
  const adj = new Map<string, { triggered: string; cell: string }[]>();
  for (const edge of causalEdges) {
    let neighbors = adj.get(edge.writer);
    if (!neighbors) {
      neighbors = [];
      adj.set(edge.writer, neighbors);
    }
    neighbors.push({ triggered: edge.triggered, cell: edge.cell });
  }

  const cycles: CycleReport[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: { actionId: string; writesCell: string }[] = [];

  const dfs = (node: string) => {
    if (inStack.has(node)) {
      // Found a cycle - extract it from the stack
      const cycleStart = stack.findIndex((s) => s.actionId === node);
      if (cycleStart !== -1) {
        const cycle = stack.slice(cycleStart);
        cycles.push({
          cycle: [...cycle],
          timestamp: performance.now(),
        });
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    const neighbors = adj.get(node) ?? [];
    for (const { triggered, cell } of neighbors) {
      stack.push({ actionId: node, writesCell: cell });
      dfs(triggered);
      stack.pop();
    }

    inStack.delete(node);
  };

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}
