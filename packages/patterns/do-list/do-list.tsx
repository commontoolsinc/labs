/**
 * Do List — a #do checklist whose tasks may eventually do themselves.
 *
 * ## Migrated onto the EditableList primitive (CT-1712)
 *
 * do-list embeds `EditableList` (`../primitives/editable-list.tsx`)
 * **headless**: the primitive owns the id-keyed MODEL (stable-id minting on
 * add, id-addressed `updateItem` / `toggleItem`, and the `total`/`active`/`done`
 * counts), while do-list keeps its rich rows — the `Suggestion` sub-pattern,
 * cell-link attachments, drop-zones, indent gutters, and a completed-items
 * drawer — and `.map()`s them itself.
 *
 * ### Identity, not whole-object equality
 *
 * Items now carry a stable `id` minted by the primitive. Every mutation
 * addresses an item by `{ id }` (was `equals(whole-object)` / array index —
 * fragile under edits/reorders). The title-addressed
 * `removeItemByTitle` / `updateItemByTitle` handlers are kept as do-list's
 * AGENT-FACING CONVENIENCE layer over the id model (the `*ByText` analogue);
 * title is NOT the identity.
 *
 * ### attachments stay a DECLARED field on do-list's own item type
 *
 * `attachments: Writable<any>[]` is a LIVE-CELL field. The primitive's
 * index-signature passthrough carries extras as PLAIN DATA only — a live cell
 * read back through it is NOT re-hydrated (the "any → true schema" gotcha; see
 * primitives.md). So attachments are declared directly on `DoItem` and do-list
 * renders + mutates them itself (`addAttachment` / `removeAttachment` via
 * `items.key(idx).key("attachments")`). This is exactly why do-list is a
 * headless embed and not a default-UI caller.
 *
 * ### do-list keeps its own add / remove handlers
 *
 * `removeItem` is a CASCADE delete (an item plus its indent-children) — richer
 * than the primitive's single-item `removeItem` — so do-list keeps its own,
 * keyed by id. `addItem` / `addItems` carry `indent` / `aiEnabled` /
 * `attachments`, so they go through the primitive's `addItem` (which mints the
 * id) with those fields as the `item` payload. `updateItem` / `toggleItem`
 * (title / done patches) delegate straight to the primitive.
 */
import {
  computed,
  Default,
  equals,
  handler,
  ifElse,
  NAME,
  nonPrivateRandom,
  OpaqueRef,
  pattern,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import Suggestion from "../system/suggestion.tsx";
import EditableList from "../primitives/editable-list.tsx";

// ===== Types =====

/** A #do item — a task that may do itself */
export interface DoItem {
  /** Stable identity, minted by the EditableList primitive on add. */
  id: string;
  title: string;
  done: boolean | Default<false>;
  indent: number | Default<0>; // 0 = root, 1 = child, 2 = grandchild...
  aiEnabled: boolean | Default<false>; // future: flag for AI auto-completion
  attachments: Writable<any>[] | Default<[]>;
  /** Carried for the primitive's default-UI shape; do-list keys off title. */
  label: Default<string, "">;
}

interface DoListInput {
  items?: Writable<DoItem[] | Default<[]>>;
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
  // UI handlers — now id-addressed (identity, not whole-object equality)
  addItem: OpaqueRef<
    Stream<{ title: string; indent?: number; attachments?: Writable<any>[] }>
  >;
  removeItem: OpaqueRef<Stream<{ id: string }>>;
  updateItem: OpaqueRef<
    Stream<{ id: string; title?: string; done?: boolean }>
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
  // LLM-friendly handlers (use title matching) — convenience over the id model
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

// ===== do-list-specific handlers (operate on the shared `items` cell) =====
// These cover do-list concepts the generic primitive does not model: rich
// extras on add (indent / aiEnabled / attachments), cascade delete (item +
// indent-children), and title-addressed agent convenience.

const addItemHandler = handler<
  { title: string; indent?: number; attachments?: Writable<any>[] },
  { items: Writable<DoItem[]> }
>(({ title, indent, attachments }, { items }) => {
  const trimmed = title.trim();
  if (!trimmed) return;

  items.push({
    id: mintId(),
    title: trimmed,
    label: trimmed,
    done: false,
    indent: indent ?? 0,
    aiEnabled: false,
    attachments: attachments ?? [],
  });
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
        id: mintId(),
        title: trimmed,
        label: trimmed,
        done: false,
        indent: indent ?? 0,
        aiEnabled: false,
        attachments: attachments ?? [],
      });
    }
  });
});

// Cascade delete: an item plus its consecutive higher-indent children.
const removeItemHandler = handler<
  { id: string },
  { items: Writable<DoItem[]> }
>(({ id }, { items }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((i) => i.id === id);
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

const updateItemHandler = handler<
  { id: string; title?: string; done?: boolean },
  { items: Writable<DoItem[]> }
>(({ id, title, done }, { items }) => {
  const currentItems = items.get();
  const newItems = currentItems.map((i) => {
    if (i.id !== id) return i;

    return {
      ...i,
      ...(title !== undefined ? { title } : {}),
      ...(done !== undefined ? { done } : {}),
    };
  });

  items.set(newItems);
});

// ===== LLM-friendly Handlers (title-based matching) — convenience layer =====

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
  const idx = currentItems.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    items.key(idx).key("attachments").push(cell);
  }
});

const removeAttachment = handler<
  unknown,
  { item: DoItem; attachment: Writable<any>; items: Writable<DoItem[]> }
>((_, { item, attachment, items }) => {
  const currentItems = items.get();
  const idx = currentItems.findIndex((i) => i.id === item.id);
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

// id minting — same scheme as the EditableList primitive. (Add still goes
// through do-list's own handler because it carries indent/aiEnabled/attachments
// extras; the primitive's addItem would not set those.)
function mintId(): string {
  const now = safeDateNow().toString(36);
  const rand = nonPrivateRandom().toString(36).slice(2, 10);
  return `${now}-${rand}`;
}

// ===== Sub-pattern for item rendering =====

const DoItemCard = pattern<
  {
    item: DoItem;
    removeItem: Stream<{ id: string }>;
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
      <cf-drop-zone
        accept="cell-link"
        oncf-drop={addAttachment({ item, items })}
      >
        <cf-card style={`margin-left: ${(item.indent ?? 0) * 24}px;`}>
          <cf-hstack gap="2" align="center">
            <cf-checkbox $checked={item.done} />
            <cf-input
              $value={item.title}
              style="flex: 1;"
              placeholder="Item..."
            />
            <cf-button
              variant="ghost"
              onClick={() => removeItem.send({ id: item.id })}
            >
              x
            </cf-button>
          </cf-hstack>

          {ifElse(
            hasAttachments,
            <cf-hstack
              gap="1"
              style="margin-top: 4px; margin-left: 24px; flex-wrap: wrap;"
            >
              {attachments.map((att: any) => (
                <cf-hstack gap="0" align="center">
                  <cf-cell-link $cell={att} />
                  <cf-button
                    variant="ghost"
                    size="sm"
                    style="font-size: 0.7rem; padding: 0 2px;"
                    onClick={removeAttachment({ item, attachment: att, items })}
                  >
                    ×
                  </cf-button>
                </cf-hstack>
              ))}
            </cf-hstack>,
            null,
          )}

          <details style="margin-top: 8px; margin-left: 24px;">
            <summary style="cursor: pointer; font-size: 0.8rem; color: var(--cf-colors-gray-500);">
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
        </cf-card>
      </cf-drop-zone>
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
      <cf-card
        style={`margin-left: ${(item.indent ?? 0) * 24}px; opacity: 0.7;`}
      >
        <cf-hstack gap="2" align="center">
          <cf-checkbox $checked={item.done} />
          <span style="text-decoration: line-through; flex: 1; color: var(--cf-colors-gray-500);">
            {item.title}
          </span>
        </cf-hstack>
      </cf-card>
    ),
  };
});

// ===== Pattern =====

export default pattern<DoListInput, DoListOutput>(({ items }) => {
  // Embed the primitive for the id-keyed model (id minting, id-addressed
  // update/toggle, counts). Headless: do-list renders its own rich rows below.
  const list = EditableList({ items });

  // Computed values (counts from the primitive; filtered views local).
  const itemCount = list.total;
  const activeItems = computed(() => items.get().filter((i) => i && !i.done));
  const completedItems = computed(() => items.get().filter((i) => i && i.done));
  const hasCompleted = computed(() => completedItems.length > 0);
  const hasNoItems = computed(() => activeItems.length === 0);

  const summary = computed(() => {
    return items.get()
      .filter((item) => item)
      .map((item) => `${item.done ? "✓" : "○"} ${item.title}`)
      .join(", ");
  });

  // Bind do-list's own handlers (extras + cascade + title convenience).
  const addItem = addItemHandler({ items });
  const addItems = addItemsHandler({ items });
  const removeItem = removeItemHandler({ items });
  const updateItem = updateItemHandler({ items });
  const removeItemByTitle = removeItemByTitleHandler({ items });
  const updateItemByTitle = updateItemByTitleHandler({ items });
  // archiveCompleted maps onto the primitive's clearDone (drop every done item).
  const archiveCompleted = list.clearDone;

  // Map items to sub-pattern instances once — reused for UI and mentionable
  const itemCards = activeItems.map((item: DoItem) => (
    <DoItemCard item={item} removeItem={removeItem} items={items} />
  ));

  const completedCards = completedItems.map((item: DoItem) => (
    <CompletedItemCard item={item} />
  ));

  // Compact UI - embeddable widget without cf-screen wrapper
  const compactUI = (
    <cf-vstack gap="2">
      <cf-vstack gap="2">
        {itemCards}

        {hasNoItems
          ? (
            <div style="text-align: center; color: var(--cf-colors-gray-500); padding: 1rem;">
              No items yet. Add one below!
            </div>
          )
          : null}
      </cf-vstack>

      {ifElse(
        hasCompleted,
        <cf-hstack justify="end" style="padding: 0 0.5rem;">
          <cf-button
            variant="ghost"
            size="sm"
            style="font-size: 0.8rem; color: var(--cf-colors-gray-500);"
            onClick={() => archiveCompleted.send({})}
          >
            Archive completed
          </cf-button>
        </cf-hstack>,
        null,
      )}

      <cf-message-input
        placeholder="Add an item..."
        oncf-send={(e: { detail?: { message?: string } }) => {
          const title = e.detail?.message?.trim();
          if (title) {
            addItem.send({ title });
          }
        }}
      />
    </cf-vstack>
  );

  return {
    [NAME]: computed(() => `Do List (${list.total})`),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>Do List</cf-heading>
            <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
              {computed(() => activeItems.length)} items
            </span>
          </cf-hstack>
        </cf-vstack>

        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="2" style="padding: 1rem;">
            {itemCards}

            {hasNoItems
              ? (
                <div style="text-align: center; color: var(--cf-colors-gray-500); padding: 2rem;">
                  No items yet. Add one below!
                </div>
              )
              : null}

            {ifElse(
              hasCompleted,
              <details style="margin-top: 1rem;">
                <summary style="cursor: pointer; font-size: 0.875rem; color: var(--cf-colors-gray-500); padding: 0.5rem 0;">
                  Completed ({computed(() => completedItems.length)})
                </summary>
                <cf-vstack gap="2" style="padding-top: 0.5rem;">
                  {completedCards}
                  <cf-hstack justify="end">
                    <cf-button
                      variant="ghost"
                      size="sm"
                      style="font-size: 0.8rem; color: var(--cf-colors-gray-500);"
                      onClick={() => archiveCompleted.send({})}
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
            placeholder="Add an item..."
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
