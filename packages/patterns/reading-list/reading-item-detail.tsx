/// <cts-enable />
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

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
  summary: string;
  addedAt: number;
  finishedAt: number | null;
  // Actions to update properties
  setStatus: Stream<{ status: ItemStatus }>;
  setRating: Stream<{ rating: number | null }>;
  setNotes: Stream<{ notes: string }>;
}

// Re-export the Output type as ReadingItemPiece for use in collections
export type ReadingItemPiece = ReadingItemDetailOutput;

export default pattern<ReadingItemDetailInput, ReadingItemDetailOutput>(
  (
    { title, author, url, type, status, rating, notes, addedAt, finishedAt },
  ) => {
    // Actions to modify properties
    const setStatus = action(
      ({ status: newStatus }: { status: ItemStatus }) => {
        status.set(newStatus);
      },
    );

    const setRating = action(
      ({ rating: newRating }: { rating: number | null }) => {
        rating.set(newRating);
      },
    );

    const setNotes = action(({ notes: newNotes }: { notes: string }) => {
      notes.set(newNotes);
    });

    return {
      [NAME]: computed(() => `Reading: ${title.get() || "New Item"}`),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header">
            <cf-heading level={4}>
              {computed(() => title.get() || "New Item")}
            </cf-heading>
          </cf-vstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="3" style="padding: 1rem;">
              <cf-card>
                <cf-vstack gap="2">
                  <cf-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-color-gray-500);">
                      Title
                    </label>
                    <cf-input $value={title} placeholder="Title" />
                  </cf-vstack>

                  <cf-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-color-gray-500);">
                      Author
                    </label>
                    <cf-input $value={author} placeholder="Author name" />
                  </cf-vstack>

                  <cf-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-color-gray-500);">
                      URL
                    </label>
                    <cf-input
                      $value={url}
                      placeholder="https://..."
                      type="url"
                    />
                  </cf-vstack>

                  <cf-hstack gap="2">
                    <cf-vstack gap="1" style="flex: 1;">
                      <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-color-gray-500);">
                        Type
                      </label>
                      <cf-select
                        $value={type}
                        items={[
                          { label: "📄 Article", value: "article" },
                          { label: "📚 Book", value: "book" },
                          { label: "📑 Paper", value: "paper" },
                          { label: "🎬 Video", value: "video" },
                        ]}
                      />
                    </cf-vstack>

                    <cf-vstack gap="1" style="flex: 1;">
                      <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-color-gray-500);">
                        Status
                      </label>
                      <cf-select
                        $value={status}
                        items={[
                          { label: "Want to read", value: "want" },
                          { label: "Reading", value: "reading" },
                          { label: "Finished", value: "finished" },
                          { label: "Abandoned", value: "abandoned" },
                        ]}
                      />
                    </cf-vstack>
                  </cf-hstack>

                  <cf-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-color-gray-500);">
                      Rating
                    </label>
                    <cf-select
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
                  </cf-vstack>
                </cf-vstack>
              </cf-card>

              <cf-card>
                <cf-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-color-gray-500);">
                    Notes
                  </label>
                  <cf-textarea
                    $value={notes}
                    placeholder="Your thoughts, highlights, quotes..."
                    rows={8}
                  />
                </cf-vstack>
              </cf-card>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      title,
      author,
      url,
      type,
      status,
      rating,
      notes,
      summary: computed(() => {
        const parts = [title.get()];
        if (author.get()) parts.push(`by ${author.get()}`);
        parts.push(`(${status.get()})`);
        if (notes.get()) parts.push(notes.get().slice(0, 150));
        return parts.join(" ");
      }),
      addedAt,
      finishedAt,
      setStatus,
      setRating,
      setNotes,
    };
  },
);
