/// <cts-enable />
import {
  type Cell,
  computed,
  type Default,
  pattern,
  UI,
  type WishState,
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
  WishParams & { candidates: Default<Cell<never>[], []> },
  WishState<never>
>(
  ({ query: _query, context: _context, candidates }) => {
    return {
      result: computed(() => candidates.length > 0 ? candidates[0] : undefined),
      [UI]: (
        <div>
          {candidates.map((candidate) => (
            /* TODO(seefeld/ben): Implement picker that updates `result` */
            <div>
              <ct-cell-link
                $cell={candidate}
              />
            </div>
          ))}
        </div>
      ),
    };
  },
);
