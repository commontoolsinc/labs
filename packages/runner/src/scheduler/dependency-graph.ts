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
  if (!node) return;

  const nowLive = isLive(state, node);
  if (wasLive === nowLive) return;

  if (nowLive) {
    addLiveRefsFromWriters(state, node, new Set<Action>());
  } else {
    dropLiveRefsFromWriters(state, node, new Set<Action>());
  }
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
  notifyNodeLivenessChange(state, node.action, wasLive);
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
  visited = new Set<Action>(),
): boolean {
  if (from === to) return true;
  if (visited.has(from)) return false;
  visited.add(from);

  const dependents = dependentsByAction.get(from);
  if (!dependents) return false;

  for (const dependent of dependents) {
    if (hasDependentPath(dependentsByAction, dependent, to, visited)) {
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
  const previousDependencies = state.reverseDependencies.get(action);
  if (previousDependencies) {
    for (const dependency of [...previousDependencies]) {
      unregisterDependentEdge(state, dependency, action);
    }
    state.reverseDependencies.delete(action);
  }

  const newDependencies = collectReverseDependenciesForLog(
    state,
    action,
    log,
  );

  for (const dependency of newDependencies) {
    registerDependentEdge(state, dependency, action);
  }

  state.reverseDependencies.set(action, newDependencies);
}

export function registerDependentEdge(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
): void {
  if (writer === dependent) return;

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

  if (!alreadyDependent) {
    const dependentRecord = state.nodes.get(dependent);
    if (dependentRecord && isLive(state, dependentRecord)) {
      addLiveRef(state, writer, new Set<Action>());
    }
  }
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

  for (const action of readers) {
    registerDependentEdge(state, writer, action);
  }
}

export function unregisterDependentEdge(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
): void {
  const dependentRecord = state.nodes.get(dependent);
  const dependentWasLive = dependentRecord
    ? isLive(state, dependentRecord)
    : false;
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

  if (hadDependent) {
    if (dependentWasLive) {
      dropLiveRef(state, writer, new Set<Action>());
    }
  }
}

// Spec §5.2: refcount deltas propagate upstream with a visited-set cycle
// guard — each node is updated AT MOST ONCE per propagation pass. Guarding
// the increment itself (not just the recursion) keeps a cycle's back edge
// from double-counting its origin, which would leave the cycle live forever
// once its only root unsubscribes. Caveat (recorded in PROGRESS.md): this
// per-pass dedup undercounts multi-path (diamond) graphs relative to
// per-edge accounting when an individual edge is later unregistered while
// its reader stays live.
function addLiveRef(
  state: SchedulerLivenessState,
  action: Action,
  visited: Set<Action>,
): void {
  if (visited.has(action)) return;
  visited.add(action);

  const node = state.nodes.get(action);
  if (!node || !isRegisteredNode(state, node)) return;

  const wasLive = isLive(state, node);
  node.liveRefs++;
  if (!wasLive && isLive(state, node)) {
    addLiveRefsFromWriters(state, node, visited);
  }
}

function dropLiveRef(
  state: SchedulerLivenessState,
  action: Action,
  visited: Set<Action>,
): void {
  if (visited.has(action)) return;
  visited.add(action);

  const node = state.nodes.get(action);
  if (!node || !isRegisteredNode(state, node) || node.liveRefs === 0) {
    return;
  }

  const wasLive = isLive(state, node);
  node.liveRefs--;
  if (wasLive && !isLive(state, node)) {
    dropLiveRefsFromWriters(state, node, visited);
  }
}

function addLiveRefsFromWriters(
  state: SchedulerLivenessState,
  node: SchedulerNode,
  visited: Set<Action>,
): void {
  updateLiveRefsFromWriters(state, node, visited, addLiveRef);
}

function dropLiveRefsFromWriters(
  state: SchedulerLivenessState,
  node: SchedulerNode,
  visited: Set<Action>,
): void {
  updateLiveRefsFromWriters(state, node, visited, dropLiveRef);
}

function updateLiveRefsFromWriters(
  state: SchedulerLivenessState,
  node: SchedulerNode,
  visited: Set<Action>,
  update: (
    state: SchedulerLivenessState,
    action: Action,
    visited: Set<Action>,
  ) => void,
): void {
  // Direction convention: `dependents` is writer -> readers, and
  // `reverseDependencies` is reader -> writers. Liveness therefore propagates
  // from a live reader upstream through `reverseDependencies`. Mark the
  // origin so cyclic back edges cannot update it again this pass; the
  // per-node guard lives in addLiveRef/dropLiveRef.
  visited.add(node.action);

  const writers = state.reverseDependencies.get(node.action);
  if (!writers) return;

  for (const writer of writers) {
    update(state, writer, visited);
  }
}

function isRegisteredNode(
  state: SchedulerLivenessState,
  node: SchedulerNode,
): boolean {
  return state.nodes.isEffect(node.action) ||
    state.nodes.isComputation(node.action);
}
