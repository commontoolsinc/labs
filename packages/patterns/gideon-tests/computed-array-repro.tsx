/// <cts-enable />
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

/**
 * MINIMAL BUG REPRODUCTION
 *
 * Bug: computed() returning array with onClick handler "sticks" empty
 *
 * Root cause: When computed() returns JSX array containing onClick handlers,
 * and the array becomes empty (e.g. filtering to no results), the UI
 * permanently shows empty even when the computed should return items again.
 *
 * To reproduce:
 * 1. Add some "Pending" items
 * 2. Switch to "Done" tab (shows empty - no done items)
 * 3. Switch back to "All" or "Pending" tab
 * 4. BUG: Items don't reappear!
 *
 * Workaround: Use items.map() with computed style to hide/show instead of
 * computed() returning filtered array.
 */

type Status = "pending" | "done";

interface Item {
  name: string;
  status: Status;
}

interface Input {
  items?: Writable<Default<Item[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  items: Item[];
}

export default pattern<Input, Output>(({ items }) => {
  const filter = Writable.of<Status | "all">("all");
  const counter = Writable.of(1);

  return {
    [NAME]: "Computed Array Bug",
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="2">
          <ct-tabs $value={filter}>
            <ct-tab-list>
              <ct-tab value="all">All</ct-tab>
              <ct-tab value="pending">Pending</ct-tab>
              <ct-tab value="done">Done</ct-tab>
            </ct-tab-list>
          </ct-tabs>
        </ct-vstack>

        <ct-vscroll flex>
          <ct-vstack gap="2" style="padding: 1rem;">
            <ct-button
              variant="secondary"
              onClick={() => {
                const c = counter.get();
                items.push({ name: `Item ${c}`, status: "pending" });
                counter.set(c + 1);
              }}
            >
              Add Pending Item
            </ct-button>

            <p>
              Filter: {filter} | Total: {computed(() => items.get().length)}
            </p>

            {/* BUG: This breaks after visiting empty tab */}
            {computed(() =>
              (filter.get() === "all"
                ? items.get().filter((i) => i != null)
                : items.get().filter((i) => i && i.status === filter.get()))
                .map((item) => (
                  <div style="padding: 0.5rem; background: #eee; border-radius: 4px;">
                    {item.name}
                    <button type="button" onClick={() => console.log(item)}>
                      log
                    </button>
                  </div>
                ))
            )}
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    items,
  };
});
