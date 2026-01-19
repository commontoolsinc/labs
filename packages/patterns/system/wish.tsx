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
  ({ query: _query, context: _context, candidates }) => {
    const selectedIndex = Writable.of(0);
    // Persisted confirmation state - once set, the selection is permanent
    const confirmedIndex = Writable.of<number | null>(null);

    // Result computed - once confirmed, always returns that specific cell
    // Use array indexing since pattern inputs are unwrapped to plain arrays
    const result = computed(() => {
      if (candidates.length === 0) return undefined;
      const confirmed = confirmedIndex.get();
      if (confirmed !== null) {
        // Permanent selection - always return this cell
        return candidates[Math.min(confirmed, candidates.length - 1)];
      }
      // Browsing mode - follows selectedIndex
      return candidates[Math.min(selectedIndex.get(), candidates.length - 1)];
    });

    return {
      result,
      [UI]: (
        <div>
          {computed(() => {
            const confirmed = confirmedIndex.get();
            if (confirmed !== null) {
              // Confirmed - render the selected candidate's UI directly
              const selectedCell =
                candidates[Math.min(confirmed, candidates.length - 1)];
              return selectedCell;
            }
            // Picking - show picker with confirm button
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
          })}
        </div>
      ),
    };
  },
);
