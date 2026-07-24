import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { arraysOverlap } from "../reactive-dependencies.ts";
import {
  type NormalizedFullLink,
  toMemorySpaceAddress,
} from "../link-utils.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageTransaction,
  TransactionReactivityLog,
} from "../storage/interface.ts";
import { reactivityLogFromActivities } from "../storage/reactivity-log.ts";
import {
  getDirectTransactionReactivityLog,
  getTransactionWriteDetails,
} from "../storage/transaction-inspection.ts";
import type {
  AnnotatedEventHandler,
  EventHandler,
  ReactivityLog,
} from "./types.ts";

export function hasAnnotatedWrites(
  handler: EventHandler,
): handler is AnnotatedEventHandler {
  return "writes" in handler && Array.isArray(handler.writes);
}

export function trustedEventWriteCandidatesFromTransaction(
  tx: IExtendedStorageTransaction,
  handler: EventHandler,
  fallbackSpaces: Iterable<MemorySpace> = [],
): NormalizedFullLink[] {
  const candidates: NormalizedFullLink[] = [];
  const seen = new Map<string, number>();
  const detailSpaces = new Set<MemorySpace>(fallbackSpaces);

  const addCandidate = (write: NormalizedFullLink | IMemorySpaceAddress) => {
    const path = write.path[0] === "value" ? write.path.slice(1) : write.path;
    const candidate: NormalizedFullLink = {
      space: write.space,
      id: write.id,
      // Transaction memory addresses may omit scope for legacy/default-space writes.
      scope: write.scope ?? "space",
      path: [...path],
      ...("schema" in write && write.schema !== undefined
        ? { schema: write.schema }
        : {}),
    };
    const key = `${candidate.space}/${candidate.id}/${
      candidate.path.join("/")
    }`;
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (
        candidates[existingIndex].schema === undefined &&
        candidate.schema !== undefined
      ) {
        candidates[existingIndex] = {
          ...candidates[existingIndex],
          schema: candidate.schema,
        };
      }
      return;
    }
    seen.set(key, candidates.length);
    candidates.push(candidate);
  };

  if (hasAnnotatedWrites(handler)) {
    for (const write of handler.writes) {
      addCandidate(write);
      detailSpaces.add(write.space);
    }
  }

  const transactionLog = txToTransactionReactivityLog(tx);
  for (
    const write of [
      ...transactionLog.writes,
      ...(transactionLog.attemptedWrites ?? []),
    ]
  ) {
    addCandidate(write);
    detailSpaces.add(write.space);
  }

  for (const input of tx.getCfcState().writePolicyInputs) {
    if (input.kind === "schema") {
      addCandidate({
        space: input.target.space,
        id: input.target.id as URI,
        path: input.target.path,
        ...(input.schema !== undefined ? { schema: input.schema } : {}),
      });
      detailSpaces.add(input.target.space);
    }
  }

  for (const space of detailSpaces) {
    for (const detail of getTransactionWriteDetails(tx, space)) {
      addCandidate(detail.address);
    }
  }

  return candidates;
}

function addressMatchesLinkPrefix(
  address: IMemorySpaceAddress,
  link: NormalizedFullLink,
): boolean {
  const documentAddress = toMemorySpaceAddress(link);
  return address.space === link.space &&
    address.id === link.id &&
    normalizeCellScope(address.scope) === link.scope &&
    arraysOverlap(documentAddress.path, address.path);
}

export function filterIgnoredAddresses(
  addresses: readonly IMemorySpaceAddress[] | undefined,
  ignoredWrites: readonly NormalizedFullLink[],
): IMemorySpaceAddress[] {
  if (!addresses?.length || ignoredWrites.length === 0) {
    return addresses ? [...addresses] : [];
  }

  return addresses.filter((address) =>
    !ignoredWrites.some((link) => addressMatchesLinkPrefix(address, link))
  );
}

export function txToReactivityLog(
  tx: IExtendedStorageTransaction,
): ReactivityLog {
  return toSchedulerReactivityLog(txToTransactionReactivityLog(tx));
}

/**
 * Counts event-commit write targets for telemetry without widening the
 * scheduler's dependency ReactivityLog. Changed writes are transaction writes;
 * attempted targets that do not overlap a changed write are no-op candidates.
 */
export function eventCommitTelemetryWriteCounts(
  tx: IStorageTransaction | IExtendedStorageTransaction,
  changedWrites: readonly IMemorySpaceAddress[],
): { writeCount: number; changedWriteCount: number } {
  return classifyTelemetryWriteCounts(
    changedWrites,
    txToTransactionReactivityLog(tx).attemptedWrites ?? [],
  );
}

export function classifyTelemetryWriteCounts(
  changedWrites: readonly IMemorySpaceAddress[],
  attemptedWrites: readonly IMemorySpaceAddress[],
): { writeCount: number; changedWriteCount: number } {
  const attemptedTargets = new Map<string, IMemorySpaceAddress>();
  for (const address of attemptedWrites) {
    attemptedTargets.set(normalizedAddressKey(address), address);
  }
  const changedByDocument = new Map<
    string,
    ChangedPathNode
  >();
  for (const changed of changedWrites) {
    const documentKey = normalizedDocumentKey(changed);
    const root = changedByDocument.get(documentKey) ?? changedPathNode();
    let node = root;
    for (const segment of changed.path) {
      const child = node.children.get(segment) ?? changedPathNode();
      node.children.set(segment, child);
      node = child;
    }
    node.terminal = true;
    changedByDocument.set(documentKey, root);
  }
  const noOpCandidates = [...attemptedTargets.values()].filter((attempted) => {
    let node = changedByDocument.get(normalizedDocumentKey(attempted));
    if (!node) return true;
    if (node.terminal) return false;
    for (const segment of attempted.path) {
      node = node.children.get(segment);
      if (!node) return true;
      if (node.terminal) return false;
    }
    // The attempted path is a prefix of at least one changed path.
    return node.children.size === 0;
  });
  return {
    changedWriteCount: changedWrites.length,
    writeCount: changedWrites.length + noOpCandidates.length,
  };
}

interface ChangedPathNode {
  terminal: boolean;
  children: Map<string, ChangedPathNode>;
}

function changedPathNode(): ChangedPathNode {
  return { terminal: false, children: new Map() };
}

function normalizedAddressKey(address: IMemorySpaceAddress): string {
  return JSON.stringify([
    normalizedDocumentKey(address),
    address.path,
  ]);
}

function normalizedDocumentKey(address: IMemorySpaceAddress): string {
  return JSON.stringify([
    address.space,
    normalizeCellScope(address.scope),
    address.id,
  ]);
}

function txToTransactionReactivityLog(
  tx: IStorageTransaction | IExtendedStorageTransaction,
): TransactionReactivityLog {
  const direct = getDirectTransactionReactivityLog(tx);
  if (direct) {
    return direct;
  }
  return reactivityLogFromActivities(tx.journal.activity());
}

function toSchedulerReactivityLog(
  log: TransactionReactivityLog,
): ReactivityLog {
  return {
    reads: log.reads,
    shallowReads: log.shallowReads,
    writes: log.writes,
  };
}
