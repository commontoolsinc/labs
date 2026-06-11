/**
 * Simple List Module - A checklist with indent support
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides rapid keyboard entry, checkboxes, and indent toggle.
 *
 * ## Migrated onto the EditableList primitive (CT-1712)
 *
 * The add / remove / toggle / model now live in the `EditableList` primitive
 * (`../primitives/editable-list.tsx`). simple-list embeds it **headless**: it
 * does NOT render EditableList's default `[UI]` because simple-list has its own
 * row chrome (indent gutter, Cmd+[ / Cmd+] keyboard indent, indent-toggle
 * button) that the default row does not provide. Instead it consumes
 * EditableList's id-keyed streams + counts and `.map()`s its own rows.
 *
 * Identity, not index: rows are now addressed by a stable `id` minted by the
 * primitive (was array index — fragile under reorder/concurrent edits). The
 * indent fields (`text`, `indented`) ride along as plain-data extras on the
 * item; they round-trip through the primitive's index-signature passthrough
 * untouched. simple-list's own indent + text-add streams are thin id-keyed
 * handlers bound to the SAME shared `items` cell the primitive mutates.
 */
import {
  computed,
  Default,
  handler,
  NAME,
  nonPrivateRandom,
  pattern,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { ModuleMetadata } from "../container-protocol.ts";
import EditableList from "../primitives/editable-list.tsx";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "simple-list",
  label: "Simple List",
  icon: "☑", // ballot box with check
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
export interface SimpleListItem {
  /** Stable identity (minted by the EditableList primitive). */
  id: string;
  text: string;
  indented: boolean | Default<false>;
  done: boolean | Default<false>;
  /** Carried for the primitive's default-UI shape; simple-list keys off text. */
  label: Default<string, "">;
}

export interface SimpleListInput {
  items?: Writable<SimpleListItem[] | Default<[]>>;
}

interface SimpleListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: SimpleListItem[];
  summary: string;
  toggleIndent: Stream<{ id: string }>;
  setIndent: Stream<{ id: string; indented: boolean }>;
  deleteItem: Stream<{ id: string }>;
  addItem: Stream<{ text: string }>;
}

// ===== simple-list-specific handlers (id-keyed, share the primitive's cell) =====
// These operate on the SAME `items` cell the embedded EditableList mutates.
// They exist because indent + the `text` field are simple-list concepts the
// generic primitive does not model. All address items by stable id, never index.

const toggleIndentHandler = handler<
  { id: string },
  { items: Writable<SimpleListItem[]> }
>(({ id }, { items }) => {
  const current = items.get() ?? [];
  let touched = false;
  const next = current.map((i) => {
    if (i.id !== id) return i;
    touched = true;
    return { ...i, indented: !i.indented };
  });
  if (touched) items.set(next);
});

const setIndentHandler = handler<
  { id: string; indented: boolean },
  { items: Writable<SimpleListItem[]> }
>(({ id, indented }, { items }) => {
  const current = items.get() ?? [];
  let touched = false;
  const next = current.map((i) => {
    if (i.id !== id) return i;
    touched = true;
    return { ...i, indented };
  });
  if (touched) items.set(next);
});

// simple-list's external `addItem({ text })` mints a stable id (same scheme as
// the primitive) and carries simple-list's `text`/`indented` fields. It pushes
// onto the SAME shared cell the primitive mutates, so the model stays unified.
const addItemHandler = handler<
  { text: string },
  { items: Writable<SimpleListItem[]> }
>(({ text }, { items }) => {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  const id = `${safeDateNow().toString(36)}-${
    nonPrivateRandom().toString(36).slice(2, 10)
  }`;
  items.push({
    id,
    text: trimmed,
    label: trimmed,
    indented: false,
    done: false,
  });
});

// ===== The Pattern =====
export const SimpleListModule = pattern<
  SimpleListInput,
  SimpleListOutput
>(({ items }) => {
  // Embed the primitive for the id-keyed model (remove / toggle / counts).
  // Headless: simple-list renders its own rows below, not list[UI].
  const list = EditableList({ items });

  // simple-list-specific streams, bound to the same shared cell.
  const toggleIndent = toggleIndentHandler({ items });
  const setIndent = setIndentHandler({ items });
  const addItem = addItemHandler({ items });

  // Computed summary for NAME
  const displayText = computed(() => {
    const total = list.total;
    if (total === 0) return "Empty";
    return `${list.done}/${total}`;
  });

  const summary = computed(() => {
    return (items.get() || [])
      .map((item) => `${item.done ? "✓" : "○"} ${item.text}`)
      .join(", ");
  });

  return {
    [NAME]: computed(() => `${MODULE_METADATA.icon} List: ${displayText}`),
    [UI]: (
      <cf-vstack gap="2">
        {/* List items */}
        <cf-vstack gap="0">
          {items.map((item: SimpleListItem) => (
            <cf-hstack
              gap="2"
              style={{
                alignItems: "center",
                padding: "6px 8px",
                paddingLeft: item.indented ? "28px" : "8px",
                borderBottom: "1px solid var(--border-subtle, #f0f0f0)",
              }}
            >
              {/* Checkbox */}
              <cf-checkbox $checked={item.done} style={{ flexShrink: "0" }} />

              {/* Editable text with Cmd+[ / Cmd+] for indent */}
              <cf-input
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
                oncf-keydown={(e: {
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
                    setIndent.send({ id: item.id, indented: true });
                  }
                  // Cmd+[ or Ctrl+[ = outdent
                  if (d.key === "[" && (d.metaKey || d.ctrlKey)) {
                    setIndent.send({ id: item.id, indented: false });
                  }
                }}
              />

              {/* Indent toggle */}
              <button
                type="button"
                onClick={() => toggleIndent.send({ id: item.id })}
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

              {
                /* Delete - subtle until hover. Reuses the primitive's id-keyed
                  removeItem (one remove path). */
              }
              <button
                type="button"
                onClick={() => list.removeItem.send({ id: item.id })}
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
                x
              </button>
            </cf-hstack>
          ))}
        </cf-vstack>

        {/* Add item input - at bottom for natural list growth */}
        <cf-message-input
          placeholder="Add item..."
          button-text="+"
          style={{
            fontSize: "14px",
          }}
          oncf-send={(e: { detail?: { message?: string } }) => {
            const text = e.detail?.message?.trim();
            if (text) {
              addItem.send({ text });
            }
          }}
        />
      </cf-vstack>
    ),
    items,
    summary,
    toggleIndent,
    setIndent,
    deleteItem: list.removeItem,
    addItem,
  };
});

export default SimpleListModule;
