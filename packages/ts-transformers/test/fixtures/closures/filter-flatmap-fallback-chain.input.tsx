/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  id: string;
  tags?: string[];
}

// FIXTURE: filter-flatmap-fallback-chain
// Verifies: fallback receiver chains keep structural array-method lowering
//   (items ?? []).filter(fn).flatMap(fn).map(fn)
//     → derive(...).filterWithPattern(...).flatMapWithPattern(...).mapWithPattern(...)
// Context: Top-level JSX fallback receiver with chained collection methods and a nested callback fallback
export default pattern<{ items?: Item[] }>(({ items }) => {
  return {
    [UI]: (
      <div>
        {(items ?? [])
          .filter((item) => item.id)
          .flatMap((item) => item.tags ?? [])
          .map((tag) => <span>{tag}</span>)}
      </div>
    ),
  };
});
