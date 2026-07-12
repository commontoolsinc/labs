import type {
  SchedulerWriterCandidate as DurableSchedulerWriterCandidate,
} from "@commonfabric/memory/v2";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { arraysOverlap } from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type {
  IMemorySpaceAddress,
  IStorageProviderWithReplica,
  MemorySpace,
} from "../storage/interface.ts";
import { getSchedulerActionTelemetryInfo } from "./diagnostics.ts";
import { entityKey } from "./keys.ts";
import type { SchedulerMaterializers } from "./materializers.ts";
import type { NodeRegistry, NodeStatus } from "./node-record.ts";
import type { SchedulerActionKind } from "./persistent-observation.ts";
import {
  schedulerImplementationFingerprint,
  schedulerRuntimeFingerprint,
} from "./run.ts";
import type { SchedulerWriteIndex } from "./scheduling-writes.ts";
import type { Action, TelemetryAnnotations } from "./types.ts";
import { resolveRegistrationSurface } from "./registration.ts";

export type LiveSchedulerMatchedWrite = {
  kind: "current-known" | "materializer";
  write: IMemorySpaceAddress;
};

export interface LiveSchedulerWriterEvidence {
  action: Action;
  status: NodeStatus;
  registrationOrdinal: number;
  matchedWrites: LiveSchedulerMatchedWrite[];
}

export interface SchedulerWriterCandidate {
  branch: string;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  actionKind: SchedulerActionKind;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  source: "live" | "durable" | "live+durable";
  live?: LiveSchedulerWriterEvidence;
  durable?: DurableSchedulerWriterCandidate;
}

export type SchedulerDurableWriterProvider = Pick<
  IStorageProviderWithReplica,
  "writersForTargets"
>;

export interface SchedulerWriterLookupState {
  nodes: NodeRegistry;
  writeIndex: SchedulerWriteIndex;
  materializers: SchedulerMaterializers;
  getActionId(action: Action): string;
}

type LiveSchedulerWriterCandidate =
  & Omit<
    SchedulerWriterCandidate,
    "source" | "durable"
  >
  & { live: LiveSchedulerWriterEvidence };

type LiveCandidateAccumulator = {
  action: Action;
  matchedWrites: Map<string, LiveSchedulerMatchedWrite>;
};

export async function schedulerWritersForTargets(
  state: SchedulerWriterLookupState,
  options: {
    branch: string;
    space: MemorySpace;
    targets: readonly IMemorySpaceAddress[];
    provider?: SchedulerDurableWriterProvider;
  },
): Promise<SchedulerWriterCandidate[]> {
  if (options.targets.some((target) => target.space !== options.space)) {
    return [];
  }
  const targets = options.targets;
  const live = collectLiveSchedulerWriters(state, {
    branch: options.branch,
    targets,
  });
  let durable: DurableSchedulerWriterCandidate[] = [];
  const lookup = options.provider?.writersForTargets;
  if (lookup && targets.length > 0) {
    try {
      const result = await lookup.call(options.provider, {
        branch: options.branch,
        targets,
      });
      durable = result.writers;
    } catch {
      // Durable lookup is an index optimization. Missing capability, stale
      // server, or a transient query failure must preserve the live/fail-open
      // discovery path.
    }
  }
  return mergeSchedulerWriterCandidates(live, durable);
}

function collectLiveSchedulerWriters(
  state: SchedulerWriterLookupState,
  options: {
    branch: string;
    targets: readonly IMemorySpaceAddress[];
  },
): LiveSchedulerWriterCandidate[] {
  const accumulators = new Map<Action, LiveCandidateAccumulator>();
  const addMatches = (
    target: IMemorySpaceAddress,
    actions: ReadonlySet<Action> | undefined,
    kind: LiveSchedulerMatchedWrite["kind"],
    writesForAction: (
      action: Action,
    ) => readonly IMemorySpaceAddress[] | undefined,
  ) => {
    if (!actions) return;
    const targetEntity = entityKey(target);
    for (const action of actions) {
      const record = state.nodes.get(action);
      if (!record) continue;
      const identity = (action as Partial<TelemetryAnnotations>)
        .schedulerObservationIdentity;
      if (
        identity?.ownerSpace !== target.space ||
        (identity.branch ?? "") !== options.branch
      ) {
        continue;
      }
      for (const write of writesForAction(action) ?? []) {
        if (
          entityKey(write) !== targetEntity ||
          !arraysOverlap(write.path, target.path)
        ) {
          continue;
        }
        let accumulator = accumulators.get(action);
        if (!accumulator) {
          accumulator = { action, matchedWrites: new Map() };
          accumulators.set(action, accumulator);
        }
        const match: LiveSchedulerMatchedWrite = {
          kind,
          write: cloneAddress(write),
        };
        accumulator.matchedWrites.set(liveMatchedWriteKey(match), match);
      }
    }
  };

  for (const target of options.targets) {
    const key = entityKey(target);
    addMatches(
      target,
      state.writeIndex.writersByEntity.get(key),
      "current-known",
      (action) => state.writeIndex.getSchedulingWrites(action),
    );
    // Effects are intentionally absent from the computation write index: they
    // must not become scheduler producers merely because W1.4 needs to inspect
    // whether the server can broker them. Discover their transformer-declared
    // surface directly, without changing dependency propagation semantics.
    addMatches(
      target,
      state.nodes.effects,
      "current-known",
      (action) => resolveRegistrationSurface(action, undefined),
    );
    addMatches(
      target,
      state.materializers.materializersByEntity.get(key),
      "materializer",
      (action) => state.materializers.getMaterializerWriteEnvelopes(action),
    );
  }

  const candidates: LiveSchedulerWriterCandidate[] = [];
  for (const { action, matchedWrites } of accumulators.values()) {
    const record = state.nodes.get(action);
    const identity = (action as Partial<TelemetryAnnotations>)
      .schedulerObservationIdentity;
    if (!record || !identity?.ownerSpace) continue;
    const actionId = state.getActionId(action);
    candidates.push({
      branch: identity.branch ?? "",
      ownerSpace: identity.ownerSpace,
      pieceId: identity.pieceId,
      processGeneration: identity.processGeneration ?? 0,
      actionId,
      actionKind: record.kind,
      implementationFingerprint: schedulerImplementationFingerprint(
        action,
        actionId,
        getSchedulerActionTelemetryInfo(action),
      ),
      runtimeFingerprint: schedulerRuntimeFingerprint(),
      live: {
        action,
        status: record.status,
        registrationOrdinal: record.ordinal,
        matchedWrites: [...matchedWrites.values()].sort(compareMatchedWrites),
      },
    });
  }
  return candidates;
}

function mergeSchedulerWriterCandidates(
  live: readonly LiveSchedulerWriterCandidate[],
  durable: readonly DurableSchedulerWriterCandidate[],
): SchedulerWriterCandidate[] {
  const liveByIdentity = new Map<string, LiveSchedulerWriterCandidate[]>();
  for (const candidate of live) {
    const key = schedulerWriterIdentityKey(candidate);
    const candidates = liveByIdentity.get(key) ?? [];
    candidates.push(candidate);
    liveByIdentity.set(key, candidates);
  }

  const result: SchedulerWriterCandidate[] = [];
  const mergedLive = new Set<LiveSchedulerWriterCandidate>();
  for (const durableCandidate of durable) {
    const exactLive = liveByIdentity.get(
      schedulerWriterIdentityKey(durableCandidate),
    ) ?? [];
    if (exactLive.length === 0) {
      result.push({
        ...writerIdentityFromDurable(durableCandidate),
        source: "durable",
        durable: durableCandidate,
      });
      continue;
    }
    for (const liveCandidate of exactLive) {
      mergedLive.add(liveCandidate);
      result.push({
        ...liveCandidate,
        source: "live+durable",
        durable: durableCandidate,
      });
    }
  }
  for (const liveCandidate of live) {
    if (mergedLive.has(liveCandidate)) continue;
    result.push({ ...liveCandidate, source: "live" });
  }
  return result.sort(compareWriterCandidates);
}

function writerIdentityFromDurable(
  candidate: DurableSchedulerWriterCandidate,
): Omit<SchedulerWriterCandidate, "source" | "live" | "durable"> {
  return {
    branch: candidate.branch,
    ...(candidate.ownerSpace !== undefined
      ? { ownerSpace: candidate.ownerSpace }
      : {}),
    pieceId: candidate.pieceId,
    processGeneration: candidate.processGeneration,
    actionId: candidate.actionId,
    actionKind: candidate.actionKind,
    implementationFingerprint: candidate.implementationFingerprint,
    runtimeFingerprint: candidate.runtimeFingerprint,
  };
}

function schedulerWriterIdentityKey(candidate: {
  branch: string;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  actionKind: SchedulerActionKind;
  implementationFingerprint: string;
  runtimeFingerprint: string;
}): string {
  return [
    candidate.branch,
    candidate.ownerSpace ?? "",
    candidate.pieceId,
    String(candidate.processGeneration),
    candidate.actionId,
    candidate.actionKind,
    candidate.implementationFingerprint,
    candidate.runtimeFingerprint,
  ].join("\0");
}

function compareWriterCandidates(
  left: SchedulerWriterCandidate,
  right: SchedulerWriterCandidate,
): number {
  const leftKey = [
    schedulerWriterIdentityKey(left),
    left.durable?.executionContextKey ?? "",
    left.source,
  ].join("\0");
  const rightKey = [
    schedulerWriterIdentityKey(right),
    right.durable?.executionContextKey ?? "",
    right.source,
  ].join("\0");
  return compareKeys(leftKey, rightKey);
}

function compareMatchedWrites(
  left: LiveSchedulerMatchedWrite,
  right: LiveSchedulerMatchedWrite,
): number {
  return compareKeys(liveMatchedWriteKey(left), liveMatchedWriteKey(right));
}

function liveMatchedWriteKey(match: LiveSchedulerMatchedWrite): string {
  return [
    match.kind,
    match.write.space,
    normalizeCellScope(match.write.scope),
    match.write.id,
    JSON.stringify(match.write.path),
  ].join("\0");
}

function cloneAddress(address: IMemorySpaceAddress): IMemorySpaceAddress {
  return { ...address, path: [...address.path] };
}

function compareKeys(left: string, right: string): number {
  return utf8Compare(left, right);
}
