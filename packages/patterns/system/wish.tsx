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
    const confirmedIndex = Writable.of<number | null>(null);

    // Result: the confirmed cell, or current selection while browsing
    const result = computed(() => {
      if (candidates.length === 0) return undefined;
      const idx = confirmedIndex.get() ?? selectedIndex.get();
      return candidates[Math.min(idx, candidates.length - 1)];
    });

    return {
      result,
      [UI]: computed(() => {
        if (candidates.length === 0) return <div>No candidates</div>;
        if (confirmedIndex.get() !== null) return result;
        return (
          <ct-card>
            <h2>Choose Result ({candidates.length})</h2>
            <ct-picker $items={candidates} $selectedIndex={selectedIndex} />
            <ct-button
              variant="primary"
              onClick={() => confirmedIndex.set(selectedIndex.get())}
            >
              Confirm Selection
            </ct-button>
          </ct-card>
        );
      }),
    };
  },
);
