/**
 * Tags Module - Pattern for tag/label management
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides add/remove tag functionality with chip display.
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "tags",
  label: "Tags",
  icon: "\u{1F3F7}", // label emoji
  schema: {
    tags: { type: "array", items: { type: "string" }, description: "Tags" },
  },
  fieldMapping: ["tags"],
};

// ===== Types =====
export interface TagsModuleInput {
  /** Tags or labels */
  tags: Default<string[], []>;
}

// ===== Handlers =====

// Handler to add a new tag
const addTag = handler<
  unknown,
  { tags: Writable<string[]>; tagInput: Writable<string> }
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
  { tags: Writable<string[]>; index: number }
>((_event, { tags, index }) => {
  const current = tags.get() || [];
  tags.set(current.toSpliced(index, 1));
});

// ===== The Pattern =====
export const TagsModule = pattern<TagsModuleInput, TagsModuleInput>(
  ({ tags }) => {
    const tagInput = Writable.of<string>("");
    const displayText = computed(() => {
      const count = (tags || []).length || 0;
      return count > 0 ? `${count} tag${count !== 1 ? "s" : ""}` : "No tags";
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Tags: ${displayText}`),
      [UI]: (
        <cf-vstack style={{ gap: "12px" }}>
          {/* Tag input */}
          <cf-hstack style={{ gap: "8px" }}>
            <cf-input
              $value={tagInput}
              placeholder="Add a tag..."
              style={{ flex: "1" }}
            />
            <cf-button onClick={addTag({ tags, tagInput })}>Add</cf-button>
          </cf-hstack>

          {/* Tag chips */}
          <cf-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
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
                  type="button"
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
          </cf-hstack>
        </cf-vstack>
      ),
      tags,
    };
  },
);

export default TagsModule;
