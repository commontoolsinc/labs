/// <cts-enable />
/**
 * Bug repro: computed() array result used with .map() inside a conditional branch.
 *
 * sorted is OpaqueRef<Item[]> (from computed()). In the ternary's truthy branch,
 * sorted.map() should be rewritten to sorted.mapWithPattern() — but the branch
 * should NOT be wrapped in a derive, since the .map() → .mapWithPattern() rewrite
 * is handled by ClosureTransformer directly.
 */
import { computed, pattern, UI, Writable } from "commontools";

interface Item {
  name: string;
  value: number;
}

export default pattern<{ items: Item[] }>((state) => {
  const showList = Writable.of(true);

  // computed() returning an array — transformer converts to derive()
  const sorted = computed(() =>
    [...state.items].sort((a, b) => a.value - b.value)
  );

  return {
    [UI]: (
      <div>
        {showList
          ? (
            <div>
              {sorted.map((item) => (
                <span>{item.name}</span>
              ))}
            </div>
          )
          : <span>Hidden</span>}
      </div>
    ),
  };
});
