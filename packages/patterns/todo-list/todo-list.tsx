/// <cts-enable />
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

/** A #todo item */
export interface TodoItem {
  title: string;
  done: Default<boolean, false>;
}

interface TodoListInput {
  items?: Writable<Default<TodoItem[], []>>;
}

interface TodoListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: TodoItem[];
  mentionable: TodoItem[];
  itemCount: number;
  addItem: Stream<{ title: string }>;
  removeItem: Stream<{ item: TodoItem }>;
}

// ===== Pattern =====

export default pattern<TodoListInput, TodoListOutput>(({ items }) => {
  // Pattern-body actions - preferred for single-use handlers that close over
  // this pattern's state.
  const addItem = action(({ title }: { title: string }) => {
    const trimmed = title.trim();
    if (trimmed) {
      items.push({ title: trimmed, done: false });
    }
  });

  const removeItem = action(({ item }: { item: TodoItem }) => {
    items.remove(item);
  });

  // Computed values
  const itemCount = computed(() => items.get().length);
  const hasNoItems = computed(() => items.get().length === 0);

  return {
    [NAME]: computed(() => `Todo List (${items.get().length})`),
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
            {items.map((item) => (
              <ct-card>
                <ct-hstack gap="2" align="center">
                  <ct-checkbox $checked={item.done} />
                  <ct-input
                    $value={item.title}
                    style="flex: 1;"
                    placeholder="Todo item..."
                  />
                  <ct-button
                    variant="ghost"
                    onClick={() => removeItem.send({ item })}
                  >
                    x
                  </ct-button>
                </ct-hstack>
              </ct-card>
            ))}

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
                addItem.send({ title });
              }
            }}
          />
        </ct-hstack>
      </ct-screen>
    ),
    items,
    mentionable: computed(() =>
      items.map((e) => {
        return {
          ...e,
          [NAME]: e.title,
          [UI]: (
            <div
              style={{
                padding: "12px",
                border: "1px solid #e0e0e0",
                borderRadius: "8px",
                backgroundColor: "#fafafa",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                <ct-checkbox $checked={e.done} />
                <div
                  style={{
                    fontSize: "16px",
                    fontWeight: "bold",
                    color: "#333",
                  }}
                >
                  {e.title}
                </div>
              </div>
            </div>
          ),
        } as TodoItem;
      })
    ),
    itemCount,
    addItem,
    removeItem,
  };
});
