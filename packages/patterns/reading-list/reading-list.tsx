/// <cts-enable />
import {
  action,
  computed,
  Default,
  equals,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import ReadingItemDetail, {
  type ItemStatus,
  type ItemType,
  type ReadingItemPiece,
} from "./reading-item-detail.tsx";

// Re-export types for consumers and tests
export type { ItemStatus, ItemType, ReadingItemPiece };

interface ReadingListInput {
  items?: Writable<Default<ReadingItemPiece[], []>>;
}

interface ReadingListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: ReadingItemPiece[];
  mentionable: ReadingItemPiece[];
  totalCount: number;
  currentFilter: ItemStatus | "all";
  filteredItems: ReadingItemPiece[];
  filteredCount: number;
  summary: string;
  addItem: Stream<{ title: string; author: string; type: ItemType }>;
  removeItem: Stream<{ item: ReadingItemPiece }>;
  setFilter: Stream<{ status: ItemStatus | "all" }>;
  updateItem: Stream<{
    item: ReadingItemPiece;
    status?: ItemStatus;
    rating?: number | null;
    notes?: string;
  }>;
}

const TYPE_EMOJI: Record<ItemType, string> = {
  book: "📚",
  article: "📄",
  paper: "📑",
  video: "🎬",
};

// Pure helper functions - can be called directly in JSX
const getTypeEmoji = (t: ItemType): string => TYPE_EMOJI[t] || "📄";

const renderStars = (rating: number | null): string => {
  if (!rating) return "";
  return "★".repeat(rating) + "☆".repeat(5 - rating);
};

// Safely coerce items.get() to an array — during intermediate reactive
// updates the value can momentarily be a non-array (e.g. object proxy).
const asArray = <T,>(v: readonly T[] | T[]): T[] =>
  Array.isArray(v) ? v as T[] : [];

export default pattern<ReadingListInput, ReadingListOutput>(({ items }) => {
  const filterStatus = Writable.of<ItemStatus | "all">("all");
  const newTitle = Writable.of("");
  const newAuthor = Writable.of("");
  const newType = Writable.of<ItemType>("article");

  // Pattern-body actions - preferred for single-use handlers
  const addItem = action(
    (
      { title, author, type }: {
        title: string;
        author: string;
        type: ItemType;
      },
    ) => {
      const trimmedTitle = title.trim();
      if (trimmedTitle) {
        // Create a new ReadingItemDetail piece and store its reference
        const newItemPiece = ReadingItemDetail({
          title: trimmedTitle,
          author: author.trim(),
          type,
          addedAt: Date.now(),
        });
        items.push(newItemPiece);
        newTitle.set("");
        newAuthor.set("");
      }
    },
  );

  const removeItem = action(({ item }: { item: ReadingItemPiece }) => {
    const current = asArray(items.get());
    const index = current.findIndex((el) => equals(item, el));
    if (index >= 0) {
      items.set(current.toSpliced(index, 1));
    }
  });

  const setFilter = action(({ status }: { status: ItemStatus | "all" }) => {
    filterStatus.set(status);
  });

  const updateItem = action(
    ({
      item,
      status,
      rating,
      notes,
    }: {
      item: ReadingItemPiece;
      status?: ItemStatus;
      rating?: number | null;
      notes?: string;
    }) => {
      // Use the item's actions to update properties
      if (status !== undefined) item.setStatus.send({ status });
      if (rating !== undefined) item.setRating.send({ rating });
      if (notes !== undefined) item.setNotes.send({ notes });
    },
  );

  // Computed values
  const totalCount = computed(() => asArray(items.get()).length);

  const filteredItems = computed((): ReadingItemPiece[] => {
    const status = filterStatus.get();
    const allItems = asArray(items.get());
    if (status === "all") {
      return allItems.filter((item) => item);
    }
    return allItems.filter((item) => item && item.status === status);
  });

  const filteredCount = computed(() => filteredItems.length);

  const summary = computed(() => {
    return asArray(items.get())
      .filter((item) => item)
      .map((item) => `${item.title ?? ""} (${item.status ?? ""})`)
      .join(", ");
  });

  // For empty state display
  const hasNoFilteredItems = computed(() => filteredCount === 0);

  // Expose current filter as a computed (read-only)
  const currentFilter = computed(() => filterStatus.get());

  return {
    [NAME]: computed(() => `Reading List (${asArray(items.get()).length})`),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="2">
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>Reading List ({totalCount})</cf-heading>
          </cf-hstack>

          <cf-tabs $value={filterStatus}>
            <cf-tab-list>
              <cf-tab value="all">All</cf-tab>
              <cf-tab value="want">Want</cf-tab>
              <cf-tab value="reading">Reading</cf-tab>
              <cf-tab value="finished">Done</cf-tab>
              <cf-tab value="abandoned">Dropped</cf-tab>
            </cf-tab-list>
          </cf-tabs>
        </cf-vstack>

        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="2" style="padding: 1rem;">
            {computed(() => {
              return filteredItems.filter((item) => item).map((
                item: ReadingItemPiece,
              ) => (
                <cf-card>
                  <cf-hstack gap="2" align="center">
                    <span style="font-size: 1.5rem;">
                      {getTypeEmoji(item.type)}
                    </span>
                    <cf-vstack gap="0" style="flex: 1;">
                      <span style="font-weight: 500;">
                        {item.title || "(untitled)"}
                      </span>
                      {item.author && (
                        <span style="font-size: 0.875rem; color: var(--cf-color-gray-500);">
                          by {item.author}
                        </span>
                      )}
                      <cf-hstack gap="2" align="center">
                        <span style="font-size: 0.75rem; color: var(--cf-color-gray-400);">
                          {item.status}
                        </span>
                        {renderStars(item.rating) && (
                          <span style="font-size: 0.75rem; color: var(--cf-color-warning-500);">
                            {renderStars(item.rating)}
                          </span>
                        )}
                      </cf-hstack>
                      {item.notes && (
                        <span style="font-size: 0.75rem; color: var(--cf-color-gray-500); font-style: italic; margin-top: 0.25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;">
                          {item.notes}
                        </span>
                      )}
                    </cf-vstack>
                    <cf-button
                      variant="secondary"
                      onClick={() => navigateTo(item)}
                    >
                      Edit
                    </cf-button>
                    <cf-button
                      variant="ghost"
                      onClick={() => removeItem.send({ item })}
                    >
                      ×
                    </cf-button>
                  </cf-hstack>
                </cf-card>
              ));
            })}

            {hasNoFilteredItems
              ? (
                <div style="text-align: center; color: var(--cf-color-gray-500); padding: 2rem;">
                  No items yet. Add something to read!
                </div>
              )
              : null}
          </cf-vstack>
        </cf-vscroll>

        <cf-vstack slot="footer" gap="2" style="padding: 1rem;">
          <cf-hstack gap="2">
            <cf-input
              $value={newTitle}
              placeholder="Title..."
              style="flex: 1;"
            />
            <cf-input
              $value={newAuthor}
              placeholder="Author..."
              style="width: 150px;"
            />
            <cf-select
              $value={newType}
              items={[
                { label: "📄 Article", value: "article" },
                { label: "📚 Book", value: "book" },
                { label: "📑 Paper", value: "paper" },
                { label: "🎬 Video", value: "video" },
              ]}
              style="width: 120px;"
            />
            <cf-button
              variant="primary"
              onClick={() =>
                addItem.send({
                  title: newTitle.get(),
                  author: newAuthor.get(),
                  type: newType.get(),
                })}
            >
              Add
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      </cf-screen>
    ),
    items,
    mentionable: items,
    totalCount,
    currentFilter,
    filteredItems,
    filteredCount,
    summary,
    addItem,
    removeItem,
    setFilter,
    updateItem,
  };
});
