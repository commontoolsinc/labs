import {
  action,
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

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
  mentionable: { [NAME]: string; summary: string; [UI]: VNode }[];
  itemCount: number;
  summary: string;
  addItem: Stream<{ title: string }>;
  removeItem: Stream<{ item: TodoItem }>;
  archiveCompleted: Stream<unknown>;
}

// ===== Pattern =====

export const TodoItemPiece = pattern<
  {
    item: TodoItem;
    removeItem: Stream<{ item: TodoItem }>;
  },
  { [UI]: VNode; [NAME]: string; summary: string }
>(({ item, removeItem }) => {
  return {
    [NAME]: computed(() => item.title),
    summary: computed(() => item.title),
    [UI]: (
      <cf-card>
        <cf-hstack gap="2" align="center">
          <cf-checkbox $checked={item.done} />
          <cf-input
            $value={item.title}
            style="flex: 1;"
            placeholder="Todo item..."
          />
          <cf-button variant="ghost" onClick={() => removeItem.send({ item })}>
            x
          </cf-button>
        </cf-hstack>
      </cf-card>
    ),
  };
});

const CompletedTodoItem = pattern<
  { item: TodoItem },
  { [UI]: VNode; [NAME]: string; summary: string }
>(({ item }) => {
  return {
    [NAME]: computed(() => item.title),
    summary: computed(() => item.title),
    [UI]: (
      <cf-card style="opacity: 0.7;">
        <cf-hstack gap="2" align="center">
          <cf-checkbox $checked={item.done} />
          <span style="text-decoration: line-through; flex: 1; color: var(--cf-color-gray-500);">
            {item.title}
          </span>
        </cf-hstack>
      </cf-card>
    ),
  };
});

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

  const archiveCompleted = action(() => {
    items.set(items.get().filter((i) => !i.done));
  });

  // Computed values
  const itemCount = computed(() => items.get().length);
  const activeItems = computed(() => items.get().filter((i) => !i.done));
  const completedItems = computed(() => items.get().filter((i) => i.done));
  const hasCompleted = computed(() => completedItems.length > 0);
  const hasNoItems = computed(() => activeItems.length === 0);

  const summary = computed(() => {
    return items.get()
      .map((item) => `${item.done ? "✓" : "○"} ${item.title}`)
      .join(", ");
  });

  // Map items to sub-pattern instances — reused for UI and mentionable
  const itemCards = activeItems.map((item: TodoItem) => (
    <TodoItemPiece item={item} removeItem={removeItem} />
  ));

  const completedCards = completedItems.map((item: TodoItem) => (
    <CompletedTodoItem item={item} />
  ));

  return {
    [NAME]: computed(() => `Todo List (${items.get().length})`),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>Todo List</cf-heading>
            <span style="font-size: 0.875rem; color: var(--cf-color-gray-500);">
              {computed(() => activeItems.length)} items
            </span>
          </cf-hstack>
        </cf-vstack>

        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="2" style="padding: 1rem;">
            {itemCards}

            {hasNoItems
              ? (
                <div style="text-align: center; color: var(--cf-color-gray-500); padding: 2rem;">
                  No items yet. Add one below!
                </div>
              )
              : null}

            {ifElse(
              hasCompleted,
              <details style="margin-top: 1rem;">
                <summary style="cursor: pointer; font-size: 0.875rem; color: var(--cf-color-gray-500); padding: 0.5rem 0;">
                  Completed ({computed(() => completedItems.length)})
                </summary>
                <cf-vstack gap="2" style="padding-top: 0.5rem;">
                  {completedCards}
                  <cf-hstack justify="end">
                    <cf-button
                      variant="ghost"
                      size="sm"
                      style="font-size: 0.8rem; color: var(--cf-color-gray-500);"
                      onClick={() => archiveCompleted.send()}
                    >
                      Archive all
                    </cf-button>
                  </cf-hstack>
                </cf-vstack>
              </details>,
              null,
            )}
          </cf-vstack>
        </cf-vscroll>

        <cf-hstack slot="footer" gap="2" style="padding: 1rem;">
          <cf-message-input
            placeholder="Add a todo item..."
            style="flex: 1;"
            oncf-send={(e: { detail?: { message?: string } }) => {
              const title = e.detail?.message?.trim();
              if (title) {
                addItem.send({ title });
              }
            }}
          />
        </cf-hstack>
      </cf-screen>
    ),
    items,
    mentionable: itemCards,
    itemCount,
    summary,
    addItem,
    removeItem,
    archiveCompleted,
  };
});
