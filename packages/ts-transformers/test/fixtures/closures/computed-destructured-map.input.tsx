/// <cts-enable />
/**
 * Regression: .map() on a destructured property from a computed result
 * inside another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
 * so destructured `tasks` is a plain array.
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
          const { tasks } = result;
          return tasks.map((task) => <li>{task.name}</li>);
        })}
      </div>
    ),
  };
});
