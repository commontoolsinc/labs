/// <cts-enable />
import {
  computed,
  Default,
  equals,
  handler,
  NAME,
  OpaqueRef,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";
import Suggestion from "../system/suggestion.tsx";

// ===== Types =====

/** A #do item — a task that may do itself */
export interface DoItem {
  title: string;
  done: Default<boolean, false>;
  indent: Default<number, 0>; // 0 = root, 1 = child, 2 = grandchild...
  aiEnabled: Default<boolean, false>; // future: flag for AI auto-completion
}

interface DoListInput {
  items?: Writable<Default<DoItem[], []>>;
}

interface DoListOutput {
  [NAME]: string;
  [UI]: VNode;
  compactUI: VNode;
  items: DoItem[];
  itemCount: number;
  // UI handlers (use cell references via equals())
  addItem: OpaqueRef<Stream<{ title: string; indent?: number }>>;
  removeItem: OpaqueRef<Stream<{ item: DoItem }>>;
  updateItem: OpaqueRef<
    Stream<{ item: DoItem; title?: string; done?: boolean }>
  >;
  addItems: OpaqueRef<
    Stream<{ items: Array<{ title: string; indent?: number }> }>
  >;
  // LLM-friendly handlers (use title matching)
  /** Remove a task and its subtasks by title */
  removeItemByTitle: OpaqueRef<Stream<{ title: string }>>;
  /** Update a task by title. Set done to mark complete, newTitle to rename. */
  updateItemByTitle: OpaqueRef<
    Stream<{ title: string; newTitle?: string; done?: boolean }>
  >;
}

// ===== Module-scope Handlers =====

const addItemHandler = handler<
  { title: string; indent?: number },
  { items: Writable<DoItem[]> }
>(({ title, indent }, { items }) => {
  const trimmed = title.trim();
  if (!trimmed) return;

  items.push({
    title: trimmed,
    done: false,
    indent: indent ?? 0,
    aiEnabled: false,
  });
});

const removeItemHandler = handler<
  { item: DoItem },
  { items: Writable<DoItem[]> }
>(({ item }, { items }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((i) => equals(i, item));

  if (index === -1) return;

  // Count consecutive children (items with higher indent)
  const itemIndent = item.indent ?? 0;
  let childCount = 0;
  for (let i = index + 1; i < currentItems.length; i++) {
    const nextIndent = currentItems[i].indent ?? 0;
    if (nextIndent > itemIndent) {
      childCount++;
    } else {
      break;
    }
  }

  // Remove item and all its children
  const newItems = [
    ...currentItems.slice(0, index),
    ...currentItems.slice(index + 1 + childCount),
  ];
  items.set(newItems);
});

const updateItemHandler = handler<
  { item: DoItem; title?: string; done?: boolean },
  { items: Writable<DoItem[]> }
>(({ item, title, done }, { items }) => {
  const currentItems = items.get();
  const newItems = currentItems.map((i) => {
    if (!equals(i, item)) return i;

    return {
      ...i,
      ...(title !== undefined ? { title } : {}),
      ...(done !== undefined ? { done } : {}),
    };
  });

  items.set(newItems);
});

const addItemsHandler = handler<
  { items: Array<{ title: string; indent?: number }> },
  { items: Writable<DoItem[]> }
>(({ items: newItems }, { items }) => {
  newItems.forEach(({ title, indent }) => {
    const trimmed = title.trim();
    if (trimmed) {
      items.push({
        title: trimmed,
        done: false,
        indent: indent ?? 0,
        aiEnabled: false,
      });
    }
  });
});

// ===== LLM-friendly Handlers (title-based matching) =====

/** Remove a task and its subtasks by title */
const removeItemByTitleHandler = handler<
  { title: string },
  { items: Writable<DoItem[]> }
>(({ title }, { items }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex(
    (i) => i.title?.toLowerCase() === title.toLowerCase(),
  );

  if (index === -1) return;

  const itemIndent = currentItems[index].indent ?? 0;
  let childCount = 0;
  for (let i = index + 1; i < currentItems.length; i++) {
    const nextIndent = currentItems[i].indent ?? 0;
    if (nextIndent > itemIndent) {
      childCount++;
    } else {
      break;
    }
  }

  const newItems = [
    ...currentItems.slice(0, index),
    ...currentItems.slice(index + 1 + childCount),
  ];
  items.set(newItems);
});

/** Update a task by title. Set done to mark complete, newTitle to rename. */
const updateItemByTitleHandler = handler<
  { title: string; newTitle?: string; done?: boolean },
  { items: Writable<DoItem[]> }
>(({ title, newTitle, done }, { items }) => {
  const currentItems = items.get();
  const newItems = currentItems.map((i) => {
    if (i.title?.toLowerCase() !== title.toLowerCase()) return i;

    return {
      ...i,
      ...(newTitle !== undefined ? { title: newTitle } : {}),
      ...(done !== undefined ? { done } : {}),
    };
  });

  items.set(newItems);
});

// ===== Sub-pattern for item rendering =====

const DoItemCard = pattern<
  { item: DoItem; removeItem: Stream<{ item: DoItem }> },
  { [UI]: VNode; [NAME]: string }
>(({ item, removeItem }) => {
  return {
    [NAME]: "Do Item",
    [UI]: (
      <ct-card style={`margin-left: ${(item.indent ?? 0) * 24}px;`}>
        <ct-hstack gap="2" align="center">
          <ct-checkbox $checked={item.done} />
          <ct-input
            $value={item.title}
            style="flex: 1;"
            placeholder="Item..."
          />
          <ct-button variant="ghost" onClick={() => removeItem.send({ item })}>
            x
          </ct-button>
        </ct-hstack>

        <details style="margin-top: 8px; margin-left: 24px;">
          <summary style="cursor: pointer; font-size: 0.8rem; color: var(--ct-color-gray-500);">
            AI Suggestions
          </summary>
          <Suggestion
            situation={computed(
              () => `Help the user complete this task: "${item.title}"`,
            )}
            context={{ title: item.title }}
            initialResults={[]}
          />
        </details>
      </ct-card>
    ),
  };
});

// ===== Pattern =====

export default pattern<DoListInput, DoListOutput>(({ items }) => {
  // Computed values
  const itemCount = computed(() => items.get().length);
  const hasNoItems = computed(() => items.get().length === 0);

  // Bind handlers
  const addItem = addItemHandler({ items });
  const removeItem = removeItemHandler({ items });
  const updateItem = updateItemHandler({ items });
  const addItems = addItemsHandler({ items });
  const removeItemByTitle = removeItemByTitleHandler({ items });
  const updateItemByTitle = updateItemByTitleHandler({ items });

  // Compact UI - embeddable widget without ct-screen wrapper
  const compactUI = (
    <ct-vstack gap="2">
      <ct-vstack gap="2">
        {items.map((item) => (
          <DoItemCard item={item} removeItem={removeItem} />
        ))}

        {hasNoItems ? (
          <div style="text-align: center; color: var(--ct-color-gray-500); padding: 1rem;">
            No items yet. Add one below!
          </div>
        ) : null}
      </ct-vstack>

      <ct-message-input
        placeholder="Add an item..."
        onct-send={(e: { detail?: { message?: string } }) => {
          const title = e.detail?.message?.trim();
          if (title) {
            addItem.send({ title });
          }
        }}
      />
    </ct-vstack>
  );

  return {
    [NAME]: computed(() => `Do List (${items.get().length})`),
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>Do List</ct-heading>
            <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
              {itemCount} items
            </span>
          </ct-hstack>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {items.map((item) => (
              <DoItemCard item={item} removeItem={removeItem} />
            ))}

            {hasNoItems ? (
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                No items yet. Add one below!
              </div>
            ) : null}
          </ct-vstack>
        </ct-vscroll>

        <ct-hstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-message-input
            placeholder="Add an item..."
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
    compactUI,
    items,
    itemCount,
    addItem,
    removeItem,
    updateItem,
    addItems,
    removeItemByTitle,
    updateItemByTitle,
  };
});
