/// <cts-enable />
import {
  computed,
  Default,
  equals,
  handler,
  ifElse,
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
  attachments: Default<Writable<any>[], []>;
}

interface DoListInput {
  items?: Writable<Default<DoItem[], []>>;
}

interface DoListOutput {
  [NAME]: string;
  [UI]: VNode;
  compactUI: VNode;
  isHidden: true;
  items: DoItem[];
  itemCount: number;
  summary: string;
  mentionable: { [NAME]: string; summary: string; [UI]: VNode }[];
  // UI handlers (use cell references via equals())
  addItem: OpaqueRef<
    Stream<{ title: string; indent?: number; attachments?: Writable<any>[] }>
  >;
  removeItem: OpaqueRef<Stream<{ item: DoItem }>>;
  updateItem: OpaqueRef<
    Stream<{ item: DoItem; title?: string; done?: boolean }>
  >;
  addItems: OpaqueRef<
    Stream<{
      items: Array<{
        title: string;
        indent?: number;
        attachments?: Writable<any>[];
      }>;
    }>
  >;
  // LLM-friendly handlers (use title matching)
  /** Remove a task and its subtasks by title */
  removeItemByTitle: OpaqueRef<Stream<{ title: string }>>;
  /** Update a task by title. Set done to mark complete, newTitle to rename, attachments to add references. */
  updateItemByTitle: OpaqueRef<
    Stream<{
      title: string;
      newTitle?: string;
      done?: boolean;
      attachments?: Writable<any>[];
    }>
  >;
  archiveCompleted: OpaqueRef<Stream<unknown>>;
}

// ===== Module-scope Handlers =====

const addItemHandler = handler<
  { title: string; indent?: number; attachments?: Writable<any>[] },
  { items: Writable<DoItem[]> }
>(({ title, indent, attachments }, { items }) => {
  const trimmed = title.trim();
  if (!trimmed) return;

  items.push({
    title: trimmed,
    done: false,
    indent: indent ?? 0,
    aiEnabled: false,
    attachments: attachments ?? [],
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
  {
    items: Array<{
      title: string;
      indent?: number;
      attachments?: Writable<any>[];
    }>;
  },
  { items: Writable<DoItem[]> }
>(({ items: newItems }, { items }) => {
  newItems.forEach(({ title, indent, attachments }) => {
    const trimmed = title.trim();
    if (trimmed) {
      items.push({
        title: trimmed,
        done: false,
        indent: indent ?? 0,
        aiEnabled: false,
        attachments: attachments ?? [],
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

/** Update a task by title. Set done to mark complete, newTitle to rename, attachments to add references. */
const updateItemByTitleHandler = handler<
  {
    title: string;
    newTitle?: string;
    done?: boolean;
    attachments?: Writable<any>[];
  },
  { items: Writable<DoItem[]> }
>(({ title, newTitle, done, attachments }, { items }) => {
  const currentItems = items.get();
  const newItems = currentItems.map((i) => {
    if (i.title?.toLowerCase() !== title.toLowerCase()) return i;

    return {
      ...i,
      ...(newTitle !== undefined ? { title: newTitle } : {}),
      ...(done !== undefined ? { done } : {}),
      ...(attachments !== undefined
        ? { attachments: [...(i.attachments ?? []), ...attachments] }
        : {}),
    };
  });

  items.set(newItems);
});

const addAttachment = handler<
  { detail: { sourceCell: Writable<any> } },
  { item: DoItem; items: Writable<DoItem[]> }
>((e, { item, items }) => {
  const cell = e.detail?.sourceCell;
  if (!cell) return;
  const currentItems = items.get();
  const idx = currentItems.findIndex((i) => equals(i, item));
  if (idx >= 0) {
    items.key(idx).key("attachments").push(cell);
  }
});

const removeAttachment = handler<
  unknown,
  { item: DoItem; attachment: Writable<any>; items: Writable<DoItem[]> }
>((_, { item, attachment, items }) => {
  const currentItems = items.get();
  const idx = currentItems.findIndex((i) => equals(i, item));
  if (idx >= 0) {
    const attachments = items.key(idx).key("attachments");
    const currentAttachments = attachments.get();
    const attIdx = currentAttachments.findIndex((a: any) =>
      equals(a, attachment)
    );
    if (attIdx >= 0) {
      attachments.set(currentAttachments.toSpliced(attIdx, 1));
    }
  }
});

const archiveCompletedHandler = handler<
  unknown,
  { items: Writable<DoItem[]> }
>((_, { items }) => {
  items.set(items.get().filter((i) => !i.done));
});

// ===== Sub-pattern for item rendering =====

const DoItemCard = pattern<
  {
    item: DoItem;
    removeItem: Stream<{ item: DoItem }>;
    items: Writable<DoItem[]>;
  },
  { [UI]: VNode; [NAME]: string; summary: string }
>(({ item, removeItem, items }) => {
  const attachments = computed(() => item.attachments ?? []);
  const hasAttachments = computed(() => attachments.length > 0);

  return {
    [NAME]: computed(() => item.title),
    summary: computed(() => item.title),
    [UI]: (
      <ct-drop-zone
        accept="cell-link"
        onct-drop={addAttachment({ item, items })}
      >
        <ct-card style={`margin-left: ${(item.indent ?? 0) * 24}px;`}>
          <ct-hstack gap="2" align="center">
            <ct-checkbox $checked={item.done} />
            <ct-input
              $value={item.title}
              style="flex: 1;"
              placeholder="Item..."
            />
            <ct-button
              variant="ghost"
              onClick={() => removeItem.send({ item })}
            >
              x
            </ct-button>
          </ct-hstack>

          {ifElse(
            hasAttachments,
            <ct-hstack
              gap="1"
              style="margin-top: 4px; margin-left: 24px; flex-wrap: wrap;"
            >
              {attachments.map((att: any) => (
                <ct-hstack gap="0" align="center">
                  <ct-cell-link $cell={att} />
                  <ct-button
                    variant="ghost"
                    size="sm"
                    style="font-size: 0.7rem; padding: 0 2px;"
                    onClick={removeAttachment({ item, attachment: att, items })}
                  >
                    ×
                  </ct-button>
                </ct-hstack>
              ))}
            </ct-hstack>,
            null,
          )}

          <details style="margin-top: 8px; margin-left: 24px;">
            <summary style="cursor: pointer; font-size: 0.8rem; color: var(--ct-color-gray-500);">
              AI Suggestions
            </summary>
            <Suggestion
              situation={computed(
                () => `Help the user complete this task: "${item.title}"`,
              )}
              context={{ title: item.title, attachments: attachments }}
              initialResults={[]}
            />
          </details>
        </ct-card>
      </ct-drop-zone>
    ),
  };
});

const CompletedItemCard = pattern<
  {
    item: DoItem;
  },
  { [UI]: VNode; [NAME]: string; summary: string }
>(({ item }) => {
  return {
    [NAME]: computed(() => item.title),
    summary: computed(() => item.title),
    [UI]: (
      <ct-card
        style={`margin-left: ${(item.indent ?? 0) * 24}px; opacity: 0.7;`}
      >
        <ct-hstack gap="2" align="center">
          <ct-checkbox $checked={item.done} />
          <span style="text-decoration: line-through; flex: 1; color: var(--ct-color-gray-500);">
            {item.title}
          </span>
        </ct-hstack>
      </ct-card>
    ),
  };
});

// ===== Pattern =====

export default pattern<DoListInput, DoListOutput>(({ items }) => {
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

  // Bind handlers
  const addItem = addItemHandler({ items });
  const removeItem = removeItemHandler({ items });
  const updateItem = updateItemHandler({ items });
  const addItems = addItemsHandler({ items });
  const removeItemByTitle = removeItemByTitleHandler({ items });
  const updateItemByTitle = updateItemByTitleHandler({ items });
  const archiveCompleted = archiveCompletedHandler({ items });

  // Map items to sub-pattern instances once — reused for UI and mentionable
  const itemCards = activeItems.map((item: DoItem) => (
    <DoItemCard item={item} removeItem={removeItem} items={items} />
  ));

  const completedCards = completedItems.map((item: DoItem) => (
    <CompletedItemCard item={item} />
  ));

  // Compact UI - embeddable widget without ct-screen wrapper
  const compactUI = (
    <ct-vstack gap="2">
      <ct-vstack gap="2">
        {itemCards}

        {hasNoItems
          ? (
            <div style="text-align: center; color: var(--ct-color-gray-500); padding: 1rem;">
              No items yet. Add one below!
            </div>
          )
          : null}
      </ct-vstack>

      {ifElse(
        hasCompleted,
        <ct-hstack justify="end" style="padding: 0 0.5rem;">
          <ct-button
            variant="ghost"
            size="sm"
            style="font-size: 0.8rem; color: var(--ct-color-gray-500);"
            onClick={() => archiveCompleted.send({})}
          >
            Archive completed
          </ct-button>
        </ct-hstack>,
        null,
      )}

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
              {computed(() => activeItems.length)} items
            </span>
          </ct-hstack>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {itemCards}

            {hasNoItems
              ? (
                <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                  No items yet. Add one below!
                </div>
              )
              : null}

            {ifElse(
              hasCompleted,
              <details style="margin-top: 1rem;">
                <summary style="cursor: pointer; font-size: 0.875rem; color: var(--ct-color-gray-500); padding: 0.5rem 0;">
                  Completed ({computed(() => completedItems.length)})
                </summary>
                <ct-vstack gap="2" style="padding-top: 0.5rem;">
                  {completedCards}
                  <ct-hstack justify="end">
                    <ct-button
                      variant="ghost"
                      size="sm"
                      style="font-size: 0.8rem; color: var(--ct-color-gray-500);"
                      onClick={() => archiveCompleted.send({})}
                    >
                      Archive all
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              </details>,
              null,
            )}
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
    isHidden: true,
    items,
    itemCount,
    summary,
    mentionable: itemCards,
    addItem,
    removeItem,
    updateItem,
    addItems,
    removeItemByTitle,
    updateItemByTitle,
    archiveCompleted,
  };
});
