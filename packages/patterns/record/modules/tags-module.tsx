/// <cts-enable />
/**
 * Tags Module - Sub-charm for tag/label management
 */
import { Cell, computed, type Default, handler, NAME, recipe, UI } from "commontools";

export interface TagsModuleInput {
  tags: Default<string[], []>;
}

// Handler to add a new tag
const addTag = handler<
  unknown,
  { tags: Cell<string[]>; tagInput: Cell<string> }
>((_event, { tags, tagInput }) => {
  const newTag = tagInput.get().trim();
  if (!newTag) return;

  const current = tags.get() || [];
  if (!current.includes(newTag)) {
    tags.set([...current, newTag]);
  }
  tagInput.set("");
});

// Handler to remove a tag by index
const removeTag = handler<
  unknown,
  { tags: Cell<string[]>; index: number }
>((_event, { tags, index }) => {
  const current = tags.get() || [];
  tags.set(current.toSpliced(index, 1));
});

export const TagsModule = recipe<TagsModuleInput, TagsModuleInput>(
  "TagsModule",
  ({ tags }) => {
    const tagInput = Cell.of<string>("");
    const displayText = computed(() => {
      const count = (tags || []).length || 0;
      return count > 0 ? `${count} tag${count !== 1 ? "s" : ""}` : "No tags";
    });

    return {
      [NAME]: computed(() => `🏷️ Tags: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          {/* Tag input */}
          <ct-hstack style={{ gap: "8px" }}>
            <ct-input
              $value={tagInput}
              placeholder="Add a tag..."
              style={{ flex: "1" }}
            />
            <ct-button onClick={addTag({ tags, tagInput })}>Add</ct-button>
          </ct-hstack>

          {/* Tag chips */}
          <ct-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
            {tags.map((tag: string, index: number) => (
              <span
                key={index}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  background: "#e5e7eb",
                  borderRadius: "16px",
                  padding: "4px 12px",
                  fontSize: "14px",
                }}
              >
                {tag}
                <button
                  onClick={removeTag({ tags, index })}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "0",
                    fontSize: "16px",
                    color: "#6b7280",
                    lineHeight: "1",
                  }}
                  title="Remove tag"
                >
                  ×
                </button>
              </span>
            ))}
          </ct-hstack>
        </ct-vstack>
      ),
      tags,
    };
  }
);

export default TagsModule;
