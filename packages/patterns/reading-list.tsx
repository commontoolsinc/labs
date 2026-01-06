/// <cts-enable />
import {
  computed,
  Default,
  ifElse,
  lift,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";

import ReadingItemDetail, {
  type ItemStatus,
  type ItemType,
  type ReadingItem,
} from "./reading-item-detail.tsx";

interface Input {
  items: Writable<Default<ReadingItem[], []>>;
}

interface Output {
  items: ReadingItem[];
}

const typeEmoji: Record<ItemType, string> = {
  book: "📚",
  article: "📄",
  paper: "📑",
  video: "🎬",
};

const filterByStatus = lift(
  (
    args: { items: ReadingItem[]; status: ItemStatus | "all" },
  ): ReadingItem[] => {
    const { items, status } = args;
    if (!Array.isArray(items)) return [];
    if (status === "all") return items;
    return items.filter((item) => item.status === status);
  },
);

const renderStars = lift((rating: number | null): string => {
  if (!rating) return "";
  return "★".repeat(rating) + "☆".repeat(5 - rating);
});

export default pattern<Input, Output>(({ items }) => {
  const filterStatus = Cell.of<ItemStatus | "all">("all");

  const newTitle = Cell.of("");
  const newAuthor = Cell.of("");
  const newType = Cell.of<ItemType>("article");

  const totalCount = computed(() => items.get().length);
  const filteredItems = filterByStatus({ items, status: filterStatus });
  const filteredCount = lift((arr: ReadingItem[]) => arr.length)(filteredItems);

  return {
    [NAME]: "Reading List",
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
            {filteredItems.map((item) => (
              <ct-card
                style="cursor: pointer;"
                onClick={() => {
                  const detail = ReadingItemDetail({ item });
                  return navigateTo(detail);
                }}
              >
                <ct-hstack gap="2" align="center">
                  <span style="font-size: 1.5rem;">
                    {lift((t: ItemType) => typeEmoji[t] || "📄")(item.type)}
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
                      {item.rating && (
                        <span style="font-size: 0.75rem; color: var(--ct-color-warning-500);">
                          {renderStars(item.rating)}
                        </span>
                      )}
                    </ct-hstack>
                  </ct-vstack>
                  <ct-button
                    variant="ghost"
                    onClick={() => {
                      const current = items.get();
                      const idx = current.findIndex((i) =>
                        Cell.equals(item, i)
                      );
                      if (idx >= 0) {
                        items.set(current.toSpliced(idx, 1));
                      }
                    }}
                  >
                    ×
                  </ct-button>
                </ct-hstack>
              </ct-card>
            ))}

            {ifElse(
              lift((count: number) => count === 0)(filteredCount),
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                No items yet. Add something to read!
              </div>,
              null,
            )}
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
              onClick={() => {
                const title = newTitle.get().trim();
                if (title) {
                  items.push({
                    title,
                    author: newAuthor.get().trim(),
                    url: "",
                    type: newType.get(),
                    status: "want",
                    rating: null,
                    notes: "",
                    addedAt: Date.now(),
                    finishedAt: null,
                  });
                  newTitle.set("");
                  newAuthor.set("");
                }
              }}
            >
              Add
            </ct-button>
          </ct-hstack>
        </ct-vstack>
      </ct-screen>
    ),
    items,
  };
});
