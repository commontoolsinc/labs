import type { Cell } from "@commontools/runner";
import { charmId } from "@commontools/charm";

/**
 * Navigate to a charm from outside the React UI
 * This dispatches a global event that the CommandCenter component listens to
 */
export function navigateToCharm(charm: Cell<any>, replicaName?: string): void {
  const id = charmId(charm);

  if (!id) {
    console.warn("navigateToCharm: charmId is required");
    return;
  }

  globalThis.dispatchEvent(
    new CustomEvent("navigate-to-charm", {
      detail: { charmId: id, charm, replicaName },
    }),
  );
}
