// @deno-types="npm:@types/react@19.2.18"
// deno-lint-ignore no-external-import
import { createElement, type ReactNode } from "npm:react@19.2.8";

/** Keeps embedded controls out of React Flow's node-selection lifecycle. */
export function stopNodeControlPropagation(
  event: Pick<Event, "stopPropagation">,
): void {
  event.stopPropagation();
}

/** Props shared by every embedded node-control boundary. */
export const NODE_CONTROL_BOUNDARY_PROPS = {
  className: "node-parameters nodrag nopan",
  onClick: stopNodeControlPropagation,
} as const;

/** Contains node controls without leaking their clicks into React Flow. */
export function NodeControls(
  { children }: Readonly<{ children: ReactNode }>,
) {
  return createElement("div", NODE_CONTROL_BOUNDARY_PROPS, children);
}

/** Clears only the local position draft acknowledged by a completed write. */
export function clearCommittedPositionDraft<
  T extends Readonly<{ x: number; y: number }>,
>(
  drafts: Record<string, T>,
  nodeId: string,
  committed: T,
): Record<string, T> {
  const latest = drafts[nodeId];
  if (
    latest === undefined || latest.x !== committed.x ||
    latest.y !== committed.y
  ) {
    return drafts;
  }
  const next = { ...drafts };
  delete next[nodeId];
  return next;
}

/** Clears a committed draft from both the synchronous and rendered stores. */
export function settleCommittedPositionDraft<
  T extends Readonly<{ x: number; y: number }>,
>(
  draftsRef: { current: Record<string, T> },
  setDrafts: (
    update: (current: Record<string, T>) => Record<string, T>,
  ) => void,
  nodeId: string,
  committed: T,
): void {
  draftsRef.current = clearCommittedPositionDraft(
    draftsRef.current,
    nodeId,
    committed,
  );
  setDrafts((current) =>
    clearCommittedPositionDraft(current, nodeId, committed)
  );
}

/** Converts an unknown action failure into the UI's error value. */
export function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** State setters used by the serialized action runner. */
export interface ActionRunnerSetters {
  setGlobalPending(value: boolean): void;
  setActionError(value: Error | undefined): void;
  setBusyNodeCounts(
    update: (
      current: Readonly<Record<string, number>>,
    ) => Readonly<Record<string, number>>,
  ): void;
}

/** Serialized actions with node-local pending state for embedded controls. */
export interface ActionRunner {
  run(action: () => Promise<void>): Promise<void>;
  runNode(nodeId: string, action: () => Promise<void>): Promise<void>;
}

/** Queues writes while keeping unrelated canvas controls interactive. */
export function createActionRunner(setters: ActionRunnerSetters): ActionRunner {
  let tail = Promise.resolve();

  function updateNodeBusyCount(nodeId: string, delta: 1 | -1): void {
    setters.setBusyNodeCounts((current) => {
      const count = (current[nodeId] ?? 0) + delta;
      const next = { ...current };
      if (count > 0) next[nodeId] = count;
      else delete next[nodeId];
      return next;
    });
  }

  function enqueue(
    action: () => Promise<void>,
    nodeId?: string,
  ): Promise<void> {
    if (nodeId !== undefined) updateNodeBusyCount(nodeId, 1);
    const next = tail.then(async () => {
      if (nodeId === undefined) setters.setGlobalPending(true);
      setters.setActionError(undefined);
      try {
        await action();
      } catch (cause) {
        setters.setActionError(errorFrom(cause));
      } finally {
        if (nodeId === undefined) setters.setGlobalPending(false);
      }
    });
    tail = next;
    return nodeId === undefined
      ? next
      : next.finally(() => updateNodeBusyCount(nodeId, -1));
  }

  return {
    run: (action) => enqueue(action),
    runNode: (nodeId, action) => enqueue(action, nodeId),
  };
}

/** Ordering state for PerUser node-selection writes. */
export interface SelectionRequestTracker {
  reconcile(authoritativeSelection: string | null): void;
  request(
    nodeId: string,
    writeSelection: (nodeId: string) => Promise<unknown>,
  ): Promise<void>;
}

/** Keeps rapid node selections ordered without repeating the latest request. */
export function createSelectionRequestTracker(
  initialSelection: string | null,
): SelectionRequestTracker {
  let authoritativeSelection = initialSelection;
  let latestRequestedSelection = initialSelection;
  let pendingCount = 0;

  return {
    reconcile(selection) {
      authoritativeSelection = selection;
      if (pendingCount === 0) latestRequestedSelection = selection;
    },
    async request(nodeId, writeSelection) {
      if (latestRequestedSelection === nodeId) return;
      latestRequestedSelection = nodeId;
      pendingCount++;
      try {
        await writeSelection(nodeId);
      } finally {
        pendingCount--;
        if (pendingCount === 0) {
          latestRequestedSelection = authoritativeSelection;
        }
      }
    },
  };
}
