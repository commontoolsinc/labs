/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  ifElse,
  lift,
  NAME,
  pattern,
  UI,
} from "commontools";

type ItemType = "book" | "article" | "paper" | "video";
type ItemStatus = "want" | "reading" | "finished" | "abandoned";

interface ReadingItem {
  title: string;
  author: Default<string, "">;
  url: Default<string, "">;
  type: Default<ItemType, "article">;
  status: Default<ItemStatus, "want">;
  rating: Default<number | null, null>;  // 1-5 stars
  notes: Default<string, "">;
  addedAt: number;
  finishedAt: Default<number | null, null>;
}

interface Input {
  items: Cell<Default<ReadingItem[], []>>;
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

const statusColors: Record<ItemStatus, string> = {
  want: "var(--ct-color-gray-500)",
  reading: "var(--ct-color-primary-500)",
  finished: "var(--ct-color-success-500)",
  abandoned: "var(--ct-color-gray-400)",
};

// Filter items by status
const filterByStatus = lift((args: { items: ReadingItem[]; status: ItemStatus | "all" }): ReadingItem[] => {
  const { items, status } = args;
  if (!Array.isArray(items)) return [];
  if (status === "all") return items;
  return items.filter((item) => item.status === status);
});

export default pattern<Input, Output>(({ items }) => {
  const filterStatus = Cell.of<ItemStatus | "all">("all");

  // Form state
  const newTitle = Cell.of("");
  const newAuthor = Cell.of("");
  const newType = Cell.of<ItemType>("article");

  const totalCount = computed(() => items.get().length);
  const filteredItems = filterByStatus({ items, status: filterStatus });

  return {
    [NAME]: "Reading List",
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="2">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>Reading List ({totalCount})</ct-heading>
          </ct-hstack>

          {/* Status filter tabs */}
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
              <ct-card>
                <ct-hstack gap="2" align="start">
                  <span style="font-size: 1.5rem;">
                    {lift((t: ItemType) => typeEmoji[t] || "📄")(item.type)}
                  </span>
                  <ct-vstack gap="1" style="flex: 1;">
                    <ct-hstack gap="2" align="center">
                      <span style="font-weight: 500;">{item.title || "(untitled)"}</span>
                      {item.author && (
                        <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                          by {item.author}
                        </span>
                      )}
                    </ct-hstack>

                    <ct-hstack gap="2" align="center">
                      <ct-select
                        $value={item.status}
                        items={[
                          { label: "Want to read", value: "want" },
                          { label: "Reading", value: "reading" },
                          { label: "Finished", value: "finished" },
                          { label: "Abandoned", value: "abandoned" },
                        ]}
                        style="width: 130px;"
                      />
                      <ct-select
                        $value={item.rating}
                        items={[
                          { label: "No rating", value: null },
                          { label: "★☆☆☆☆", value: 1 },
                          { label: "★★☆☆☆", value: 2 },
                          { label: "★★★☆☆", value: 3 },
                          { label: "★★★★☆", value: 4 },
                          { label: "★★★★★", value: 5 },
                        ]}
                        style="width: 100px;"
                      />
                    </ct-hstack>

                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        style="font-size: 0.75rem; color: var(--ct-color-primary-500);"
                      >
                        {item.url}
                      </a>
                    )}

                    <ct-textarea
                      $value={item.notes}
                      placeholder="Notes..."
                      rows={2}
                      style="font-size: 0.875rem;"
                    />
                  </ct-vstack>

                  <ct-button
                    variant="ghost"
                    onClick={() => {
                      const current = items.get();
                      const idx = current.findIndex((i) => Cell.equals(item, i));
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
              computed(() => items.get().length === 0),
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                No items yet. Add something to read!
              </div>,
              null
            )}
          </ct-vstack>
        </ct-vscroll>

        <ct-vstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-hstack gap="2">
            <ct-input $value={newTitle} placeholder="Title..." style="flex: 1;" />
            <ct-input $value={newAuthor} placeholder="Author..." style="width: 150px;" />
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
