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
} from "commontools";

import ReadingItemDetail, {
  type ItemStatus,
  type ItemType,
  type ReadingItemCharm,
} from "./reading-item-detail.tsx";

// Re-export types for consumers and tests
export type { ItemStatus, ItemType, ReadingItemCharm };

interface Input {
  items?: Writable<Default<ReadingItemCharm[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  items: ReadingItemCharm[];
  totalCount: number;
  addItem: Stream<{ title: string; author: string; type: ItemType }>;
  removeItem: Stream<{ item: ReadingItemCharm }>;
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
        // Create a new ReadingItemDetail charm and store its reference
        const newItemCharm = ReadingItemDetail({
          title: trimmedTitle,
          author: author.trim(),
          type,
          addedAt: Date.now(),
        });
        items.push(newItemCharm);
        newTitle.set("");
        newAuthor.set("");
      }
    },
  );

  const removeItem = action(({ item }: { item: ReadingItemCharm }) => {
    const current = items.get();
    const index = current.findIndex((el) => equals(item, el));
    if (index >= 0) {
      items.set(current.toSpliced(index, 1));
    }
  });

  // Computed values
  const totalCount = computed(() => items.get().length);

  // For empty state display
  const hasNoFilteredItems = computed(() => {
    const status = filterStatus.get();
    return status === "all"
      ? items.get().length === 0
      : items.get().filter((item) => item.status === status).length === 0;
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
            {items.map((item) => {
              // Use computed() to conditionally render based on filter status
              return computed(() => {
                const status = filterStatus.get();
                const isVisible = status === "all" || item.status === status;

                return isVisible
                  ? (
                    <ct-card>
                      <ct-hstack gap="2" align="center">
                        <span style="font-size: 1.5rem;">
                          {getTypeEmoji(item.type)}
                        </span>
                        <ct-vstack gap="0" style="flex: 1;">
                          <span style="font-weight: 500;">
                            {item.title || "(untitled)"}
                          </span>
                          {item.author && (
                            <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                              by {item.author}
                            </span>
                          )}
                          <ct-hstack gap="2" align="center">
                            <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">
                              {item.status}
                            </span>
                            {renderStars(item.rating) && (
                              <span style="font-size: 0.75rem; color: var(--ct-color-warning-500);">
                                {renderStars(item.rating)}
                              </span>
                            )}
                          </ct-hstack>
                        </ct-vstack>
                        <ct-button
                          variant="secondary"
                          onClick={() => navigateTo(item)}
                        >
                          Edit
                        </ct-button>
                        <ct-button
                          variant="ghost"
                          onClick={() => removeItem.send({ item })}
                        >
                          ×
                        </ct-button>
                      </ct-hstack>
                    </ct-card>
                  )
                  : null;
              });
            })}

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
