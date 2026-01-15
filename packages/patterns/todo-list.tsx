/// <cts-enable />
import {
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";

// ===== Types =====

interface TodoItem {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Writable<Default<TodoItem[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  items: TodoItem[];
  itemCount: number;
  addItem: Stream<{ title: string }>;
  removeItem: Stream<{ item: TodoItem }>;
}

// ===== Handlers at module scope =====

const addItem = handler<
  { title: string },
  { items: Writable<TodoItem[]> }
>(({ title }, { items }) => {
  const trimmed = title.trim();
  if (trimmed) {
    items.push({ title: trimmed, done: false });
  }
});

const removeItem = handler<
  { item: TodoItem },
  { items: Writable<TodoItem[]> }
>(({ item }, { items }) => {
  const current = items.get();
  const index = current.findIndex((el) => equals(item, el));
  if (index >= 0) {
    items.set(current.toSpliced(index, 1));
  }
});

// ===== Pattern =====

export default pattern<Input, Output>(({ items }) => {
  // Bind handlers with their required context
  const boundAddItem = addItem({ items });
  const boundRemoveItem = removeItem({ items });

  // Computed values
  const itemCount = computed(() => items.get().length);
  const hasNoItems = computed(() => items.get().length === 0);

  return {
    [NAME]: "Todo with Suggestions",
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>Todo List</ct-heading>
            <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
              {itemCount} items
            </span>
          </ct-hstack>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {items.map((item) => {
              // AI suggestion based on current todo item
              const wishResult = wish({
                query: item.title,
                context: { item, items },
              });

              return (
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-hstack gap="2" align="center">
                      <ct-checkbox $checked={item.done} />
                      <ct-input
                        $value={item.title}
                        style="flex: 1;"
                        placeholder="Todo item..."
                      />
                      <ct-button
                        variant="ghost"
                        onClick={() => boundRemoveItem.send({ item })}
                      >
                        x
                      </ct-button>
                    </ct-hstack>

                    <details>
                      <summary style="cursor: pointer; font-size: 0.875rem; color: var(--ct-color-gray-500);">
                        AI Suggestion
                      </summary>
                      <div style="margin-top: 0.5rem; padding: 0.5rem; background: var(--ct-color-gray-50); border-radius: 4px;">
                        {wishResult.$UI}
                      </div>
                    </details>
                  </ct-vstack>
                </ct-card>
              );
            })}

            {hasNoItems
              ? (
                <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                  No items yet. Add one below!
                </div>
              )
              : null}
          </ct-vstack>
        </ct-vscroll>

        <ct-hstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-message-input
            placeholder="Add a todo item..."
            style="flex: 1;"
            onct-send={(e: { detail?: { message?: string } }) => {
              const title = e.detail?.message?.trim();
              if (title) {
                boundAddItem.send({ title });
              }
            }}
          />
        </ct-hstack>
      </ct-screen>
    ),
    items,
    itemCount,
    addItem: boundAddItem,
    removeItem: boundRemoveItem,
  };
});
