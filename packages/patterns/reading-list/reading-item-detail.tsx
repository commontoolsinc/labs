/// <cts-enable />
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

/** Wrap all fields of T in Writable<> for write access */
type Cellify<T> = { [K in keyof T]: Writable<T[K]> };

export type ItemType = "book" | "article" | "paper" | "video";
export type ItemStatus = "want" | "reading" | "finished" | "abandoned";

/** Raw data shape - use in collection patterns */
export interface ReadingItem {
  title: string;
  author: Default<string, "">;
  url: Default<string, "">;
  type: Default<ItemType, "article">;
  status: Default<ItemStatus, "want">;
  rating: Default<number | null, null>;
  notes: Default<string, "">;
  addedAt: number;
  finishedAt: Default<number | null, null>;
}

interface Input {
  item: Cellify<ReadingItem>;
}

/** #book #article #reading */
interface Output {
  [NAME]: string;
  [UI]: VNode;
  item: ReadingItem;
}

export default pattern<Input, Output>(({ item }) => {
  return {
    [NAME]: computed(() => `Reading: ${item.title}`),
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header">
          <ct-heading level={4}>{item.title || "New Item"}</ct-heading>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="3" style="padding: 1rem;">
            <ct-card>
              <ct-vstack gap="2">
                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    Title
                  </label>
                  <ct-input $value={item.title} placeholder="Title" />
                </ct-vstack>

                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    Author
                  </label>
                  <ct-input $value={item.author} placeholder="Author name" />
                </ct-vstack>

                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    URL
                  </label>
                  <ct-input
                    $value={item.url}
                    placeholder="https://..."
                    type="url"
                  />
                </ct-vstack>

                <ct-hstack gap="2">
                  <ct-vstack gap="1" style="flex: 1;">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                      Type
                    </label>
                    <ct-select
                      $value={item.type}
                      items={[
                        { label: "📄 Article", value: "article" },
                        { label: "📚 Book", value: "book" },
                        { label: "📑 Paper", value: "paper" },
                        { label: "🎬 Video", value: "video" },
                      ]}
                    />
                  </ct-vstack>

                  <ct-vstack gap="1" style="flex: 1;">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                      Status
                    </label>
                    <ct-select
                      $value={item.status}
                      items={[
                        { label: "Want to read", value: "want" },
                        { label: "Reading", value: "reading" },
                        { label: "Finished", value: "finished" },
                        { label: "Abandoned", value: "abandoned" },
                      ]}
                    />
                  </ct-vstack>
                </ct-hstack>

                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    Rating
                  </label>
                  <ct-select
                    $value={item.rating}
                    items={[
                      { label: "No rating", value: null },
                      { label: "★☆☆☆☆ (1)", value: 1 },
                      { label: "★★☆☆☆ (2)", value: 2 },
                      { label: "★★★☆☆ (3)", value: 3 },
                      { label: "★★★★☆ (4)", value: 4 },
                      { label: "★★★★★ (5)", value: 5 },
                    ]}
                  />
                </ct-vstack>
              </ct-vstack>
            </ct-card>

            <ct-card>
              <ct-vstack gap="1">
                <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                  Notes
                </label>
                <ct-textarea
                  $value={item.notes}
                  placeholder="Your thoughts, highlights, quotes..."
                  rows={8}
                />
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    item,
  };
});
