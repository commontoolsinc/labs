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
  WishParams & { candidates: Default<Writable<never>[], []> },
  WishState<never>
>(
  ({ query: _query, context: _context, candidates }) => {
    const selectedIndex = Cell.of(0);
    const result = computed(() => {
      if (candidates.length === 0) return undefined;
      const idx = Math.min(selectedIndex.get(), candidates.length - 1);
      return candidates[idx];
    });

    return {
      result,
      [UI]: (
        <div>
          <ct-card>
            <h2>Wish Results ({candidates.length})</h2>
            <ct-picker $items={candidates} $selectedIndex={selectedIndex} />
            <ct-cell-link $cell={result} />
          </ct-card>
        </div>
      ),
    };
  },
);
