/// <cts-enable />
/**
 * Simple List Module - A checklist with indent support
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides rapid keyboard entry, checkboxes, and indent toggle.
 */
import {
  Cell,
  computed,
  type Default,
  handler,
  NAME,
  recipe,
  UI,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "simple-list",
  label: "Simple List",
  icon: "\u2611", // ☑ ballot box with check
  allowMultiple: true,
  schema: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "Item text" },
          indented: {
            type: "boolean",
            description: "Whether item is indented",
          },
          done: { type: "boolean", description: "Whether item is completed" },
        },
      },
      description: "List items",
    },
  },
  fieldMapping: ["items", "checklist", "list"],
};

// ===== Types =====
interface SimpleListItem {
  text: string;
  indented: Default<boolean, false>;
  done: Default<boolean, false>;
}

export interface SimpleListModuleInput {
  items: Cell<Default<SimpleListItem[], []>>;
}

// ===== Handlers =====

// Toggle indent state on an item
const toggleIndent = handler<
  unknown,
  { items: Cell<SimpleListItem[]>; index: number }
>((_event, { items, index }) => {
  const current = items.get() || [];
  if (index < 0 || index >= current.length) return;

  const updated = [...current];
  updated[index] = { ...updated[index], indented: !updated[index].indented };
  items.set(updated);
});

// Delete an item
const deleteItem = handler<
  unknown,
  { items: Cell<SimpleListItem[]>; index: number }
>((_event, { items, index }) => {
  const current = items.get() || [];
  if (index < 0 || index >= current.length) return;

  items.set(current.toSpliced(index, 1));
});

// ===== The Pattern =====
export const SimpleListModule = recipe<
  SimpleListModuleInput,
  SimpleListModuleInput
>(
  "SimpleListModule",
  ({ items }) => {
    // Computed summary for NAME
    const displayText = computed(() => {
      const list = items.get() || [];
      const total = list.length;
      if (total === 0) return "Empty";
      const done = list.filter((item) => item.done).length;
      return `${done}/${total}`;
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} List: ${displayText}`),
      [UI]: (
        <ct-vstack gap="3">
          {/* Add item input */}
          <ct-message-input
            placeholder="Add item..."
            button-text="Add"
            onct-send={(e: { detail?: { message?: string } }) => {
              const text = e.detail?.message?.trim();
              if (text) {
                items.push({ text, indented: false, done: false });
              }
            }}
          />

          {/* List items */}
          <ct-vstack gap="1">
            {items.map((item, index: number) => (
              <ct-hstack
                gap="2"
                style={{
                  alignItems: "center",
                  padding: "8px 12px",
                  paddingLeft: item.indented ? "32px" : "12px",
                  background: "var(--bg-secondary, #f9fafb)",
                  borderRadius: "6px",
                }}
              >
                {/* Checkbox */}
                <ct-checkbox $checked={item.done} />

                {/* Editable text */}
                <ct-input
                  $value={item.text}
                  style={{
                    flex: "1",
                    background: "transparent",
                    border: "none",
                    textDecoration: item.done ? "line-through" : "none",
                    opacity: item.done ? "0.6" : "1",
                  }}
                />

                {/* Indent toggle */}
                <button
                  type="button"
                  onClick={toggleIndent({ items, index })}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "4px",
                    fontSize: "14px",
                    color: item.indented ? "#3b82f6" : "#9ca3af",
                  }}
                  title={item.indented ? "Outdent" : "Indent"}
                >
                  ↳
                </button>

                {/* Delete */}
                <button
                  type="button"
                  onClick={deleteItem({ items, index })}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "4px",
                    fontSize: "14px",
                    color: "#6b7280",
                  }}
                  title="Delete"
                >
                  ×
                </button>
              </ct-hstack>
            ))}
          </ct-vstack>
        </ct-vstack>
      ),
      items,
    };
  },
);

export default SimpleListModule;
