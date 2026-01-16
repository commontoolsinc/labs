/// <cts-enable />
import {
  action,
  computed,
  Default,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

import ReadingItemDetail, {
  type ItemStatus,
  type ItemType,
  type ReadingItem,
} from "./reading-item-detail.tsx";

// Re-export types for consumers and tests
export type { ItemStatus, ItemType, ReadingItem };

// Pre-computed item data for rendering (avoids closure issues in .map())
interface ItemDisplayData {
  item: ReadingItem;
  typeEmoji: string;
  stars: string;
}

interface Input {
  items?: Writable<Default<ReadingItem[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  items: ReadingItem[];
  totalCount: number;
  addItem: Stream<{ title: string; author: string; type: ItemType }>;
  removeItem: Stream<{ item: ReadingItem }>;
}

const TYPE_EMOJI: Record<ItemType, string> = {
  book: "📚",
  article: "📄",
  paper: "📑",
  video: "🎬",
};

// Pure helper functions (used inside computed())
const getTypeEmoji = (t: ItemType): string => TYPE_EMOJI[t] || "📄";

const renderStars = (rating: number | null): string => {
  if (!rating) return "";
  return "★".repeat(rating) + "☆".repeat(5 - rating);
};

export default pattern<Input, Output>(({ items }) => {
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
        items.push({
          title: trimmedTitle,
          author: author.trim(),
          url: "",
          type,
          status: "want",
          rating: null,
          notes: "",
          addedAt: Date.now(),
          finishedAt: null,
        });
        newTitle.set("");
        newAuthor.set("");
      }
    },
  );

  const removeItem = action(({ item }: { item: ReadingItem }) => {
    items.remove(item);
  });

  // Computed values
  const totalCount = computed(() => items.get().length);

  // Pre-compute filtered items with display data to avoid closure issues in .map()
  const filteredDisplayData = computed((): ItemDisplayData[] => {
    const itemList = items.get();
    const status = filterStatus.get();

    const filtered = status === "all"
      ? itemList
      : itemList.filter((item) => item.status === status);

    return filtered.map((item) => ({
      item,
      typeEmoji: getTypeEmoji(item.type),
      stars: renderStars(item.rating),
    }));
  });

  // Compute hasNoFilteredItems directly from source data (not from another computed)
  const hasNoFilteredItems = computed(() => {
    const itemList = items.get();
    const status = filterStatus.get();
    if (status === "all") return itemList.length === 0;
    return itemList.filter((item) => item.status === status).length === 0;
  });

  return {
    [NAME]: computed(() => `Reading List (${items.get().length})`),
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="2">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>Reading List ({totalCount})</ct-heading>
          </ct-hstack>

          <ct-tabs $value={filterStatus}>
            <ct-tab-list>
              <ct-tab value="all">All</ct-tab>
              <ct-tab value="want">Want</ct-tab>
              <ct-tab value="reading">Reading</ct-tab>
              <ct-tab value="finished">Done</ct-tab>
              <ct-tab value="abandoned">Dropped</ct-tab>
            </ct-tab-list>
          </ct-tabs>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {filteredDisplayData.map((data) => (
              <ct-card
                style="cursor: pointer;"
                onClick={() => {
                  const detail = ReadingItemDetail({ item: data.item });
                  return navigateTo(detail);
                }}
              >
                <ct-hstack gap="2" align="center">
                  <span style="font-size: 1.5rem;">
                    {data.typeEmoji}
                  </span>
                  <ct-vstack gap="0" style="flex: 1;">
                    <span style="font-weight: 500;">
                      {data.item.title || "(untitled)"}
                    </span>
                    {data.item.author && (
                      <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                        by {data.item.author}
                      </span>
                    )}
                    <ct-hstack gap="2" align="center">
                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">
                        {data.item.status}
                      </span>
                      {data.stars && (
                        <span style="font-size: 0.75rem; color: var(--ct-color-warning-500);">
                          {data.stars}
                        </span>
                      )}
                    </ct-hstack>
                  </ct-vstack>
                  <ct-button
                    variant="ghost"
                    onClick={() => removeItem.send({ item: data.item })}
                  >
                    ×
                  </ct-button>
                </ct-hstack>
              </ct-card>
            ))}

            {hasNoFilteredItems
              ? (
                <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                  No items yet. Add something to read!
                </div>
              )
              : null}
          </ct-vstack>
        </ct-vscroll>

        <ct-vstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-hstack gap="2">
            <ct-input
              $value={newTitle}
              placeholder="Title..."
              style="flex: 1;"
            />
            <ct-input
              $value={newAuthor}
              placeholder="Author..."
              style="width: 150px;"
            />
            <ct-select
              $value={newType}
              items={[
                { label: "📄 Article", value: "article" },
                { label: "📚 Book", value: "book" },
                { label: "📑 Paper", value: "paper" },
                { label: "🎬 Video", value: "video" },
              ]}
              style="width: 120px;"
            />
            <ct-button
              variant="primary"
              onClick={() =>
                addItem.send({
                  title: newTitle.get(),
                  author: newAuthor.get(),
                  type: newType.get(),
                })}
            >
              Add
            </ct-button>
          </ct-hstack>
        </ct-vstack>
      </ct-screen>
    ),
    items,
    totalCount,
    addItem,
    removeItem,
  };
});
