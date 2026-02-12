/// <cts-enable />
import {
  computed,
  type Default,
  pattern,
  UI,
  type WishState,
  Writable,
} from "commontools";

// Copy of the original with less fancy types, since we ran into limits of the
// schema translation here.
export type WishParams = {
  query: string;
  path?: string[];
  context?: Record<string, any>;
  schema?: any;
  scope?: string[];
};

export default pattern<
  WishParams & { candidates: Default<Writable<unknown>[], []> },
  WishState<unknown>
>(
  ({ candidates }) => {
    const selectedIndex = Writable.of(0);
    // User's confirmed selection (null = not yet confirmed by user)
    const userConfirmedIndex = Writable.of<number | null>(null);

    // Effective confirmed index: auto-confirm if single candidate, else use user selection
    const confirmedIndex = computed(() => {
      if (candidates.length === 1) return 0;
      return userConfirmedIndex.get();
    });

    // Result: the confirmed cell, or current selection while browsing
    const result = computed(() => {
      if (candidates.length === 0) return undefined;
      const idx = confirmedIndex ?? selectedIndex.get();
      return candidates[Math.min(idx, candidates.length - 1)];
    });

    return {
      result,
      candidates,
      error: undefined,
      [UI]: computed(() => {
        if (candidates.length === 0) return <div>No candidates</div>;
        // Auto-confirmed single match or user-confirmed: show the result
        if (confirmedIndex !== null) return result;
        // Multiple candidates: show picker UI
        return (
          <ct-card>
            <h2>Choose Result ({candidates.length})</h2>
            <ct-picker $items={candidates} $selectedIndex={selectedIndex} />
            <ct-button
              variant="primary"
              onClick={() => userConfirmedIndex.set(selectedIndex.get())}
            >
              Confirm Selection
            </ct-button>
          </ct-card>
        );
      }),
    };
  },
);
