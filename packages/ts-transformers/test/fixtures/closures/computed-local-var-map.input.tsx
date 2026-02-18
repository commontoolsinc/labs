/// <cts-enable />
/**
 * Regression: .map() on a computed result assigned to a local variable
 * inside another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
 * so `localVar` is a plain array and .mapWithPattern() doesn't exist on it.
 */
import { computed, pattern, UI } from "commontools";

interface Item {
  name: string;
  price: number;
}

export default pattern<{ items: Item[] }>(({ items }) => {
  const filtered = computed(() => items.filter((i) => i.price > 100));

  return {
    [UI]: (
      <div>
        {computed(() => {
          const localVar = filtered;
          return localVar.map((item) => <li>{item.name}</li>);
        })}
      </div>
    ),
  };
});
