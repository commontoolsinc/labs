/** Keeps embedded controls out of React Flow's node-selection lifecycle. */
export function stopNodeControlPropagation(
  event: Pick<Event, "stopPropagation">,
): void {
  event.stopPropagation();
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
