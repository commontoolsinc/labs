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

export type ItemType = "book" | "article" | "paper" | "video";
export type ItemStatus = "want" | "reading" | "finished" | "abandoned";

/** Input for creating a new reading item detail piece */
interface ReadingItemDetailInput {
  title?: Writable<Default<string, "">>;
  author?: Writable<Default<string, "">>;
  url?: Writable<Default<string, "">>;
  type?: Writable<Default<ItemType, "article">>;
  status?: Writable<Default<ItemStatus, "want">>;
  rating?: Writable<Default<number | null, null>>;
  notes?: Writable<Default<string, "">>;
  addedAt?: Default<number, 0>;
  finishedAt?: Default<number | null, null>;
}

/** Output shape of the reading item piece - this is what gets stored in lists
 * #book #article #reading
 */
interface ReadingItemDetailOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  author: string;
  url: string;
  type: ItemType;
  status: ItemStatus;
  rating: number | null;
  notes: string;
  addedAt: number;
  finishedAt: number | null;
}

// Re-export the Output type as ReadingItemPiece for use in collections
export type ReadingItemPiece = ReadingItemDetailOutput;

export default pattern<ReadingItemDetailInput, ReadingItemDetailOutput>(
  (
    { title, author, url, type, status, rating, notes, addedAt, finishedAt },
  ) => {
    return {
      [NAME]: computed(() => `Reading: ${title.get() || "New Item"}`),
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header">
            <ct-heading level={4}>
              {computed(() => title.get() || "New Item")}
            </ct-heading>
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="3" style="padding: 1rem;">
              <ct-card>
                <ct-vstack gap="2">
                  <ct-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                      Title
                    </label>
                    <ct-input $value={title} placeholder="Title" />
                  </ct-vstack>

                  <ct-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                      Author
                    </label>
                    <ct-input $value={author} placeholder="Author name" />
                  </ct-vstack>

                  <ct-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                      URL
                    </label>
                    <ct-input
                      $value={url}
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
                        $value={type}
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
                        $value={status}
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
                      $value={rating}
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
                    $value={notes}
                    placeholder="Your thoughts, highlights, quotes..."
                    rows={8}
                  />
                </ct-vstack>
              </ct-card>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      title,
      author,
      url,
      type,
      status,
      rating,
      notes,
      addedAt,
      finishedAt,
    };
  },
);
