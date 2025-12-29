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
  pattern,
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

// Output type with only data fields - prevents TypeScript OOM (CT-1143)
interface SimpleListModuleOutput {
  items: SimpleListItem[];
}

// ===== Handlers =====

// Toggle indent on an item
const toggleIndent = handler<
  unknown,
  { items: Cell<SimpleListItem[]>; index: number }
>((_event, { items, index }) => {
  const current = items.get() || [];
  if (index < 0 || index >= current.length) return;

  const updated = [...current];
  updated[index] = {
    ...updated[index],
    indented: !updated[index].indented,
  };
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
export const SimpleListModule = pattern<
  SimpleListModuleInput,
  SimpleListModuleOutput
>(({ items }) => {
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
      <ct-vstack gap="2">
        {/* List items */}
        <ct-vstack gap="0">
          {items.map((item, index: number) => (
            <ct-hstack
              gap="2"
              style={{
                alignItems: "center",
                padding: "6px 8px",
                paddingLeft: item.indented ? "28px" : "8px",
                borderBottom: "1px solid var(--border-subtle, #f0f0f0)",
              }}
            >
              {/* Checkbox */}
              <ct-checkbox
                $checked={item.done}
                style={{ flexShrink: "0" }}
              />

              {/* Editable text with Cmd+[ / Cmd+] for indent */}
              <ct-input
                $value={item.text}
                placeholder="..."
                style={{
                  flex: "1",
                  background: "transparent",
                  border: "none",
                  padding: "2px 4px",
                  fontSize: "14px",
                  textDecoration: item.done ? "line-through" : "none",
                  opacity: item.done ? "0.5" : "1",
                  color: "inherit",
                }}
                onct-keydown={(e: {
                  detail?: {
                    key: string;
                    metaKey?: boolean;
                    ctrlKey?: boolean;
                  };
                }) => {
                  const d = e.detail;
                  if (!d) return;
                  // Cmd+] or Ctrl+] = indent
                  if (d.key === "]" && (d.metaKey || d.ctrlKey)) {
                    const current = items.get() || [];
                    if (index >= 0 && index < current.length) {
                      const updated = [...current];
                      updated[index] = { ...updated[index], indented: true };
                      items.set(updated);
                    }
                  }
                  // Cmd+[ or Ctrl+[ = outdent
                  if (d.key === "[" && (d.metaKey || d.ctrlKey)) {
                    const current = items.get() || [];
                    if (index >= 0 && index < current.length) {
                      const updated = [...current];
                      updated[index] = { ...updated[index], indented: false };
                      items.set(updated);
                    }
                  }
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
                  padding: "2px 6px",
                  fontSize: "12px",
                  color: item.indented ? "#666" : "#ccc",
                  opacity: "0.6",
                  transition: "opacity 0.15s",
                }}
                title={item.indented ? "Outdent" : "Indent"}
              >
                {item.indented ? "←" : "→"}
              </button>

              {/* Delete - subtle until hover */}
              <button
                type="button"
                onClick={deleteItem({ items, index })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 6px",
                  fontSize: "14px",
                  color: "#ccc",
                  opacity: "0.5",
                  transition: "opacity 0.15s",
                }}
                title="Delete"
              >
                ×
              </button>
            </ct-hstack>
          ))}
        </ct-vstack>

        {/* Add item input - at bottom for natural list growth */}
        <ct-message-input
          placeholder="Add item..."
          button-text="+"
          style={{
            fontSize: "14px",
          }}
          onct-send={(e: { detail?: { message?: string } }) => {
            const text = e.detail?.message?.trim();
            if (text) {
              items.push({ text, indented: false, done: false });
            }
          }}
        />
      </ct-vstack>
    ),
    items,
  };
});

export default SimpleListModule;
