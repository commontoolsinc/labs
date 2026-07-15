import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import { forEachOverlappingWriter } from "./scheduling-writes.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type {
  Action,
  EventPreflightTraceContext,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

export interface DependencyGraphState {
  readonly triggerIndex: TriggerIndexState;
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly nodes: NodeRegistry;
  readonly materializerIndex: Pick<MaterializerIndexState, "isMaterializer">;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
}

export type SchedulerLivenessState = Pick<
  DependencyGraphState,
  "nodes" | "reverseDependencies" | "materializerIndex"
>;

export function isLive(
  state: SchedulerLivenessState,
  node: SchedulerNode,
): boolean {
  if (!isRegisteredNode(state, node)) return false;

  return state.nodes.isEffect(node.action) ||
    node.liveRefs > 0 ||
    node.provisionalDemand ||
    state.materializerIndex.isMaterializer(node.action);
}

export function notifyNodeLivenessChange(
  state: SchedulerLivenessState,
  action: Action,
  wasLive: boolean,
): void {
  const node = state.nodes.get(action);
  if (!node || wasLive === isLive(state, node)) return;
  recomputeLiveRefs(state);
}

export function setNodeProvisionalDemand(
  state: SchedulerLivenessState,
  node: SchedulerNode,
  provisionalDemand: boolean,
  passId?: number,
): void {
  const wasLive = isLive(state, node);
  node.provisionalDemand = provisionalDemand;
  if (provisionalDemand) {
    node.provisionalDemandPass = passId;
  } else {
    node.provisionalDemandPass = undefined;
  }
  // Root removal must rebuild even when a stale internal cycle ref makes the
  // node appear live before recomputation.
  if (wasLive !== isLive(state, node) || !provisionalDemand) {
    recomputeLiveRefs(state);
  }
}

export function groupReadsByEntity(
  reads: readonly IMemorySpaceAddress[],
): Map<SpaceScopeAndURI, IMemorySpaceAddress[]> {
  const readsByEntity = new Map<SpaceScopeAndURI, IMemorySpaceAddress[]>();
  for (const read of reads) {
    const entity = entityKey(read);
    let entityReads = readsByEntity.get(entity);
    if (!entityReads) {
      entityReads = [];
      readsByEntity.set(entity, entityReads);
    }
    entityReads.push(read);
  }
  return readsByEntity;
}

export function hasDependentPath(
  dependentsByAction: WeakMap<Action, Set<Action>>,
  from: Action,
  to: Action,
): boolean {
  const visited = new Set<Action>([from]);
  const pending = [from];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === to) return true;

    const dependents = dependentsByAction.get(current);
    if (!dependents) continue;
    for (const dependent of dependents) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      pending.push(dependent);
    }
  }

  return false;
}

/**
 * True when an invalid/never-ran node is transitively upstream of `action`.
 *
 * Seed from the maintained invalid-node set rather than walking `action`'s
 * whole upstream cone. {@link hasDependentPath} supplies the cycle-safe
 * downstream reachability check over the canonical writer-to-reader edges.
 * `action` itself is excluded: a resubscribe records a run that just completed,
 * so callers use this to decide whether newly-live upstream work needs a wake.
 */
export function hasInvalidUpstream(
  state: Pick<DependencyGraphState, "dependents" | "nodes">,
  action: Action,
): boolean {
  for (const candidate of state.nodes.getInvalidNodes()) {
    if (
      candidate !== action &&
      hasDependentPath(state.dependents, candidate, action)
    ) {
      return true;
    }
  }
  return false;
}

export function collectDirectWritersForLog(state: {
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly trace?: EventPreflightTraceContext;
}, log: ReactivityLog): Set<Action> {
  const directWriters = new Set<Action>();
  if (state.trace) {
    state.trace.logReadCount += log.reads.length;
    state.trace.logShallowReadCount += log.shallowReads.length;
  }

  forEachOverlappingWriter(state, log.reads, log.shallowReads, (writer) => {
    if (state.trace && !directWriters.has(writer)) {
      state.trace.writerOverlapCount++;
    }
    directWriters.add(writer);
  }, {
    filter: (writer) => !state.effects.has(writer),
    onCandidate: () => {
      if (state.trace) state.trace.writerCandidateCount++;
    },
  });

  return directWriters;
}

export function collectReverseDependenciesForLog(
  state: {
    readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
    readonly getSchedulingWrites: (
      action: Action,
    ) => readonly IMemorySpaceAddress[] | undefined;
  },
  action: Action,
  log: ReactivityLog,
): Set<Action> {
  const dependencies = new Set<Action>();

  forEachOverlappingWriter(
    state,
    log.reads,
    log.shallowReads,
    (writer) => {
      dependencies.add(writer);
    },
    {
      filter: (writer) => writer !== action && !dependencies.has(writer),
    },
  );

  return dependencies;
}

export function updateDependentEdgesForLog(
  state: DependencyGraphState,
  action: Action,
  log: ReactivityLog,
): void {
  const previousDependencies = state.reverseDependencies.get(action) ??
    new Set<Action>();
  const newDependencies = collectReverseDependenciesForLog(
    state,
    action,
    log,
  );

  let changed = false;
  for (const dependency of previousDependencies) {
    if (!newDependencies.has(dependency)) {
      changed = unregisterDependentEdge(state, dependency, action, {
        recompute: false,
      }) || changed;
    }
  }
  for (const dependency of newDependencies) {
    if (!previousDependencies.has(dependency)) {
      changed = registerDependentEdge(state, dependency, action, {
        recompute: false,
      }) || changed;
    }
  }

  state.reverseDependencies.set(action, newDependencies);
  if (changed) recomputeLiveRefs(state);
}

export function registerDependentEdge(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
  options: { recompute?: boolean } = {},
): boolean {
  if (writer === dependent) return false;

  let dependents = state.dependents.get(writer);
  if (!dependents) {
    dependents = new Set();
    state.dependents.set(writer, dependents);
  }
  const alreadyDependent = dependents.has(dependent);
  dependents.add(dependent);

  let reverse = state.reverseDependencies.get(dependent);
  if (!reverse) {
    reverse = new Set();
    state.reverseDependencies.set(dependent, reverse);
  }
  reverse.add(writer);

  if (!alreadyDependent && (options.recompute ?? true)) {
    recomputeLiveRefs(state);
  }
  return !alreadyDependent;
}

export function registerDependentsForWriterSurface(
  state: DependencyGraphState,
  writer: Action,
  writes: readonly IMemorySpaceAddress[],
): void {
  const readers = new Set<Action>();
  for (const write of writes) {
    for (const action of state.triggerIndex.collectReadersForWrite(write)) {
      readers.add(action);
    }
  }
  readers.delete(writer);

  let changed = false;
  for (const action of readers) {
    changed = registerDependentEdge(state, writer, action, {
      recompute: false,
    }) || changed;
  }
  if (changed) recomputeLiveRefs(state);
}

export function unregisterDependentEdge(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
  options: { recompute?: boolean } = {},
): boolean {
  const dependents = state.dependents.get(writer);
  const hadDependent = dependents?.delete(dependent) ?? false;
  if (dependents && dependents.size === 0) {
    state.dependents.delete(writer);
  }

  const reverse = state.reverseDependencies.get(dependent);
  reverse?.delete(writer);
  if (reverse && reverse.size === 0) {
    state.reverseDependencies.delete(dependent);
  }

  if (hadDependent && (options.recompute ?? true)) {
    recomputeLiveRefs(state);
  }
  return hadDependent;
}

/**
 * Rebuild demand refcounts from the explicit demand roots.
 *
 * A local delta walk cannot use one visited set for both cycle protection and
 * reference accounting: doing so counts a diamond's shared writer only once,
 * so removing either arm can incorrectly make that writer dormant. Conversely,
 * naively counting every live edge lets a rootless cycle keep itself alive.
 *
 * Edge changes are rare compared with value changes, so derive the reachable
 * live set from effects/materializers/provisional roots, then count only edges
 * whose reader is in that root-reachable set. This is both diamond-accurate and
 * cycle-safe; `liveRefs` remains the number of live direct readers.
 */
export function recomputeLiveRefs(state: SchedulerLivenessState): void {
  const records = [...state.nodes.nodes()];
  const reachable = new Set<Action>();
  const stack: Action[] = [];

  for (const record of records) {
    record.liveRefs = 0;
    if (
      state.nodes.isEffect(record.action) ||
      record.provisionalDemand ||
      state.materializerIndex.isMaterializer(record.action)
    ) {
      reachable.add(record.action);
      stack.push(record.action);
    }
  }

  while (stack.length > 0) {
    const reader = stack.pop()!;
    const writers = state.reverseDependencies.get(reader);
    if (!writers) continue;
    for (const writer of writers) {
      const writerRecord = state.nodes.get(writer);
      if (!writerRecord || !isRegisteredNode(state, writerRecord)) continue;
      if (!reachable.has(writer)) {
        reachable.add(writer);
        stack.push(writer);
      }
    }
  }

  for (const reader of reachable) {
    const writers = state.reverseDependencies.get(reader);
    if (!writers) continue;
    for (const writer of writers) {
      const writerRecord = state.nodes.get(writer);
      if (
        writerRecord &&
        reachable.has(writer) &&
        isRegisteredNode(state, writerRecord)
      ) {
        writerRecord.liveRefs++;
      }
    }
  }
}

function isRegisteredNode(
  state: SchedulerLivenessState,
  node: SchedulerNode,
): boolean {
  return state.nodes.isEffect(node.action) ||
    state.nodes.isComputation(node.action);
}
