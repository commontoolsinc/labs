/// <cts-enable />
/**
 * Regression: .map() on a property access of a computed result inside
 * another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
 * so `result.tasks` is a plain array.
 */
import { computed, pattern, UI } from "commontools";

interface Item {
  name: string;
  done: boolean;
}

export default pattern<{ items: Item[] }>(({ items }) => {
  const result = computed(() => ({
    tasks: items.filter((i) => !i.done),
    view: "inbox",
  }));

  return {
    [UI]: (
      <div>
        {computed(() => {
          return result.tasks.map((task) => <li>{task.name}</li>);
        })}
      </div>
    ),
  };
});
