/// <cts-enable />
/**
 * Record Pattern v2 - True Sub-Charm Architecture
 *
 * A data-up meta-container where each module is its own sub-charm pattern.
 * This enables:
 * - Adding new module types without code changes to Record
 * - User-defined custom modules (future)
 * - Modules that can exist independently
 * - @-reference specific modules by charm ID
 *
 * #record
 */

import {
  Cell,
  computed,
  type Default,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  str,
  toSchema,
  UI,
} from "commontools";
import {
  createSubCharm,
  getAddableTypes,
  getDefinition,
} from "./record/registry.ts";
// Import Note directly - we create it inline with proper linkPattern
// (avoids global state for passing Record's pattern JSON)
import Note from "./note.tsx";
import {
  inferTypeFromModules,
} from "./record/template-registry.ts";
import { TypePickerModule } from "./record/type-picker-module.tsx";
import type { SubCharmEntry, TrashedSubCharmEntry } from "./record/types.ts";

// ===== Types =====

interface RecordInput {
  title?: Default<string, "">;
  subCharms?: Default<SubCharmEntry[], []>;
  trashedSubCharms?: Default<TrashedSubCharmEntry[], []>;
}

interface RecordOutput {
  title?: Default<string, "">;
  subCharms?: Default<SubCharmEntry[], []>;
  trashedSubCharms?: Default<TrashedSubCharmEntry[], []>;
}

// ===== Auto-Initialize Notes + TypePicker (Two-Lift Pattern) =====
// Based on chatbot-list-view.tsx pattern:
// - Outer lift creates the charms and calls inner lift
// - Inner lift receives charms as input and stores them
// This works because the inner lift provides proper cause context
//
// TypePicker is a "controller module" - it receives parent Cells as input
// so it can modify the parent's subCharms list when a template is selected.

// Inner lift: stores the initial charms (receives charms as input)
const storeInitialCharms = lift(
  toSchema<{
    notesCharm: unknown;
    typePickerCharm: unknown;
    subCharms: Cell<SubCharmEntry[]>;
    isInitialized: Cell<boolean>;
  }>(),
  undefined,
  ({ notesCharm, typePickerCharm, subCharms, isInitialized }) => {
    if (!isInitialized.get()) {
      subCharms.set([
        { type: "notes", pinned: true, charm: notesCharm },
        { type: "type-picker", pinned: false, charm: typePickerCharm },
      ]);
      isInitialized.set(true);
      return notesCharm; // Return notes charm as primary reference
    }
  }
);

// Outer lift: checks if empty, creates charms, calls inner lift
// TypePicker receives parent Cells so it can modify subCharms when template selected
// Note: We receive recordPatternJson as input to avoid capturing Record before it's defined
const initializeRecord = lift(
  toSchema<{
    currentCharms: SubCharmEntry[];  // Unwrapped value, not Cell
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    isInitialized: Cell<boolean>;
    // deno-lint-ignore no-explicit-any
    recordPatternJson: any;  // Computed that returns Record JSON string
  }>(),
  undefined,
  ({ currentCharms, subCharms, trashedSubCharms, isInitialized, recordPatternJson }) => {
    if ((currentCharms || []).length === 0) {
      // Create Note directly with Record's pattern JSON for wiki-links
      // deno-lint-ignore no-explicit-any
      const notesCharm = Note({
        embedded: true,
        linkPattern: recordPatternJson,
      } as any);
      // TypePicker receives parent Cells + recordPatternJson for creating Notes
      // deno-lint-ignore no-explicit-any
      const typePickerCharm = TypePickerModule({
        parentSubCharms: subCharms,
        parentTrashedSubCharms: trashedSubCharms,
        recordPatternJson,
      } as any);
      return storeInitialCharms({ notesCharm, typePickerCharm, subCharms, isInitialized });
    }
  }
);

// Helper to get module display info (icon + label) from type
const getModuleDisplay = lift(({ type }: { type: string }) => {
  const def = getDefinition(type);
  return {
    icon: def?.icon || "📋",
    label: def?.label || type,
  };
});

// ===== Module-Scope Handlers (avoid closures, use references not indices) =====

// Toggle pin state for a sub-charm - uses entry reference, not index
const togglePin = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; entry: SubCharmEntry }
>((_event, { subCharms: sc, entry }) => {
  const current = sc.get() || [];
  // Find by reference using charm identity
  const index = current.findIndex((e) => e?.charm === entry?.charm);
  if (index < 0) return;

  const updated = [...current];
  updated[index] = { ...entry, pinned: !entry.pinned };
  sc.set(updated);
});

// Add a new sub-charm
// Note: Receives recordPatternJson to create Notes with correct wiki-link target
const addSubCharm = handler<
  { detail: { value: string } },
  // deno-lint-ignore no-explicit-any
  { subCharms: Cell<SubCharmEntry[]>; selectedAddType: Cell<string>; recordPatternJson: any }
>(({ detail }, { subCharms: sc, selectedAddType: sat, recordPatternJson }) => {
  const type = detail?.value;
  if (!type) return;

  // Create the sub-charm and add it (multiple modules of same type allowed)
  const current = sc.get() || [];
  // Special case: create Note directly with Record pattern for wiki-links
  // deno-lint-ignore no-explicit-any
  const charm = type === "notes"
    ? Note({
        embedded: true,
        linkPattern: recordPatternJson,
      } as any)
    : createSubCharm(type);
  sc.set([...current, { type, pinned: false, charm }]);
  sat.set("");
});

// Move sub-charm to trash (soft delete) - uses Cell.push() and Cell.remove()
const trashSubCharm = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; trashedSubCharms: Cell<TrashedSubCharmEntry[]>; entry: SubCharmEntry }
>((_event, { subCharms: sc, trashedSubCharms: trash, entry }) => {
  // Move to trash with timestamp
  trash.push({ ...entry, trashedAt: new Date().toISOString() });

  // Remove from active
  sc.remove(entry);
});

// Restore sub-charm from trash - uses Cell.push() and Cell.remove()
const restoreSubCharm = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; trashedSubCharms: Cell<TrashedSubCharmEntry[]>; entry: TrashedSubCharmEntry }
>((_event, { subCharms: sc, trashedSubCharms: trash, entry }) => {
  // Restore to active (without trashedAt)
  const { trashedAt: _trashedAt, ...restored } = entry;
  sc.push(restored);

  // Remove from trash
  trash.remove(entry);
});

// Permanently delete from trash - uses Cell.remove() with entry reference
const permanentlyDelete = handler<
  unknown,
  { trashedSubCharms: Cell<TrashedSubCharmEntry[]>; entry: TrashedSubCharmEntry }
>((_event, { trashedSubCharms: trash, entry }) => {
  trash.remove(entry);
});

// Empty all trash
const emptyTrash = handler<
  unknown,
  { trashedSubCharms: Cell<TrashedSubCharmEntry[]> }
>((_event, { trashedSubCharms: trash }) => {
  trash.set([]);
});

// Toggle trash section expanded/collapsed
const toggleTrashExpanded = handler<unknown, { expanded: Cell<boolean> }>(
  (_event, { expanded }) => expanded.set(!expanded.get())
);

// ===== The Record Pattern =====
const Record = pattern<RecordInput, RecordOutput>(
  ({ title, subCharms, trashedSubCharms }) => {

    // Local state
    const selectedAddType = Cell.of<string>("");
    const trashExpanded = Cell.of(false);

    // Create Record pattern JSON for wiki-links in Notes
    // Using computed() defers evaluation until render time, avoiding circular dependency
    const recordPatternJson = computed(() => JSON.stringify(Record));

    // ===== Auto-initialize Notes + TypePicker =====
    const isInitialized = Cell.of(false);
    initializeRecord({ currentCharms: subCharms, subCharms, trashedSubCharms, isInitialized, recordPatternJson });

    // ===== Computed Values =====

    // Display name with fallback
    const displayName = computed(() => title?.trim() || "(Untitled Record)");

    // Split sub-charms by pin status
    // No longer need indices - we use entry references directly
    const pinnedEntries = lift(({ sc }: { sc: SubCharmEntry[] }) =>
      (sc || []).filter((entry) => entry?.pinned)
    )({ sc: subCharms });

    const unpinnedEntries = lift(({ sc }: { sc: SubCharmEntry[] }) =>
      (sc || []).filter((entry) => !entry?.pinned)
    )({ sc: subCharms });

    // All subcharms (for grid layout when no split needed)
    const allEntries = lift(({ sc }: { sc: SubCharmEntry[] }) =>
      (sc || [])
    )({ sc: subCharms });

    // Check layout mode based on pinned count
    const pinnedCount = lift(({ arr }: { arr: SubCharmEntry[] }) =>
      (arr || []).length
    )({ arr: pinnedEntries });

    const hasUnpinned = lift(({ arr }: { arr: SubCharmEntry[] }) =>
      (arr || []).length > 0
    )({ arr: unpinnedEntries });

    // Check if there are any module types available to add
    // (always true unless registry is empty - multiple of same type allowed)
    const hasTypesToAdd = getAddableTypes().length > 0;

    // Build dropdown items from registry, separating new types from existing ones
    const addSelectItems = lift(({ sc }: { sc: SubCharmEntry[] }) => {
      const existingTypes = new Set((sc || []).map((e) => e?.type).filter(Boolean));
      const allTypes = getAddableTypes();

      const newTypes = allTypes.filter((def) => !existingTypes.has(def.type));
      const existingTypesDefs = allTypes.filter((def) => existingTypes.has(def.type));

      const items: { value: string; label: string; disabled?: boolean }[] = [];

      // Add new types first
      for (const def of newTypes) {
        items.push({ value: def.type, label: `${def.icon} ${def.label}` });
      }

      // Add divider and existing types if any
      if (existingTypesDefs.length > 0) {
        if (newTypes.length > 0) {
          items.push({ value: "", label: "── Add another ──", disabled: true });
        }
        for (const def of existingTypesDefs) {
          items.push({ value: def.type, label: `${def.icon} ${def.label}` });
        }
      }

      return items;
    })({ sc: subCharms });

    // Infer record type from modules (data-up philosophy)
    const inferredType = lift(({ sc }: { sc: SubCharmEntry[] }) => {
      const moduleTypes = (sc || []).map((e) => e?.type).filter(Boolean);
      return inferTypeFromModules(moduleTypes as string[]);
    })({ sc: subCharms });

    // Extract icon from inferred type for NAME display
    const recordIcon = lift(({ inferred }: { inferred: { icon: string } }) =>
      inferred?.icon || "\u{1F4CB}"
    )({ inferred: inferredType });

    // ===== Trash Section Computed Values =====

    // Compute trash count directly
    const trashCount = lift(({ t }: { t: TrashedSubCharmEntry[] }) =>
      (t || []).length
    )({ t: trashedSubCharms });

    // Check if there are any trashed items
    const hasTrash = lift(({ t }: { t: TrashedSubCharmEntry[] }) =>
      (t || []).length > 0
    )({ t: trashedSubCharms });

    // ===== Main UI =====
    return {
      [NAME]: str`${recordIcon} ${displayName}`,
      [UI]: (
        <ct-vstack style={{ height: "100%", gap: "0" }}>
          {/* Header toolbar */}
          <ct-hstack
            style={{
              padding: "8px 12px",
              gap: "8px",
              borderBottom: "1px solid #e5e7eb",
              alignItems: "center",
            }}
          >
            <ct-input
              $value={title}
              placeholder="Record title..."
              style={{ flex: "1", fontWeight: "600", fontSize: "16px" }}
            />
            {hasTypesToAdd && (
              <ct-select
                $value={selectedAddType}
                placeholder="+ Add"
                items={addSelectItems}
                onct-change={addSubCharm({ subCharms, selectedAddType, recordPatternJson })}
                style={{ width: "130px" }}
              />
            )}
          </ct-hstack>

          {/* Main content area */}
          <div
            style={{
              flex: "1",
              overflow: "auto",
              padding: "12px",
              background: "#f9fafb",
            }}
          >
            {/* Adaptive layout based on pinned count */}
            {ifElse(
                pinnedCount > 0,
                // Primary + Rail layout (when items are pinned)
                <div style={{ display: "flex", gap: "16px" }}>
                  {/* Left: Pinned items (2/3 width) */}
                  <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: "12px" }}>
                    {pinnedEntries.map((entry: SubCharmEntry) => {
                      const displayInfo = getModuleDisplay({ type: entry.type });
                      return (
                        <div
                          style={{
                            background: "white",
                            borderRadius: "8px",
                            border: "1px solid #e5e7eb",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "8px 12px",
                              borderBottom: "1px solid #f3f4f6",
                              background: "#fafafa",
                            }}
                          >
                            <span style={{ fontSize: "14px", fontWeight: "500", flex: "1" }}>
                              {displayInfo.icon} {displayInfo.label}
                            </span>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                              <button
                                onClick={togglePin({ subCharms, entry })}
                                style={{
                                  background: "#e0f2fe",
                                  border: "1px solid #7dd3fc",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  color: "#0369a1",
                                }}
                                title="Unpin"
                              >
                                📌
                              </button>
                              <button
                                onClick={trashSubCharm({ subCharms, trashedSubCharms, entry })}
                                style={{
                                  background: "transparent",
                                  border: "1px solid #e5e7eb",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  color: "#6b7280",
                                }}
                                title="Remove"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                          <div style={{ padding: "12px" }}>
                            {(entry.charm as any)?.[UI]}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Right: Unpinned items in rail (1/3 width) */}
                  {ifElse(
                    hasUnpinned,
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px" }}>
                      {unpinnedEntries.map((entry: SubCharmEntry) => {
                        const displayInfo = getModuleDisplay({ type: entry.type });
                        return (
                          <div
                            style={{
                              background: "white",
                              borderRadius: "8px",
                              border: "1px solid #e5e7eb",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                padding: "8px 12px",
                                borderBottom: "1px solid #f3f4f6",
                                background: "#fafafa",
                              }}
                            >
                              <span style={{ fontSize: "14px", fontWeight: "500", flex: "1" }}>
                                {displayInfo.icon} {displayInfo.label}
                              </span>
                              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                                <button
                                  onClick={togglePin({ subCharms, entry })}
                                  style={{
                                    background: "transparent",
                                    border: "1px solid #e5e7eb",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    color: "#6b7280",
                                  }}
                                  title="Pin"
                                >
                                  📌
                                </button>
                                <button
                                  onClick={trashSubCharm({ subCharms, trashedSubCharms, entry })}
                                  style={{
                                    background: "transparent",
                                    border: "1px solid #e5e7eb",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    color: "#6b7280",
                                  }}
                                  title="Remove"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                            <div style={{ padding: "12px" }}>
                              {(entry.charm as any)?.[UI]}
                            </div>
                          </div>
                        );
                      })}
                    </div>,
                    null
                  )}
                </div>,
                // Grid layout (no pinned items)
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 500px))",
                    gap: "12px",
                  }}
                >
                  {allEntries.map((entry: SubCharmEntry) => {
                    const displayInfo = getModuleDisplay({ type: entry.type });
                    return (
                      <div
                        style={{
                          background: "white",
                          borderRadius: "8px",
                          border: "1px solid #e5e7eb",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "8px 12px",
                            borderBottom: "1px solid #f3f4f6",
                            background: "#fafafa",
                          }}
                        >
                          <span style={{ fontSize: "14px", fontWeight: "500", flex: "1" }}>
                            {displayInfo.icon} {displayInfo.label}
                          </span>
                          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                            <button
                              onClick={togglePin({ subCharms, entry })}
                              style={{
                                background: "transparent",
                                border: "1px solid #e5e7eb",
                                borderRadius: "4px",
                                cursor: "pointer",
                                padding: "4px 8px",
                                fontSize: "12px",
                                color: "#6b7280",
                              }}
                              title="Pin"
                            >
                              📌
                            </button>
                            <button
                              onClick={trashSubCharm({ subCharms, trashedSubCharms, entry })}
                              style={{
                                background: "transparent",
                                border: "1px solid #e5e7eb",
                                borderRadius: "4px",
                                cursor: "pointer",
                                padding: "4px 8px",
                                fontSize: "12px",
                                color: "#6b7280",
                              }}
                              title="Remove"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <div style={{ padding: "12px" }}>
                          {(entry.charm as any)?.[UI]}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            }

            {/* Collapsible Trash Section */}
            {ifElse(
              hasTrash,
              <div
                style={{
                  marginTop: "16px",
                  borderTop: "1px solid #e5e7eb",
                  paddingTop: "12px",
                }}
              >
                <button
                  onClick={toggleTrashExpanded({ expanded: trashExpanded })}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    color: "#6b7280",
                    fontSize: "13px",
                    width: "100%",
                    padding: "8px",
                  }}
                >
                  <span
                    style={{
                      transform: trashExpanded ? "rotate(90deg)" : "rotate(0deg)",
                      transition: "transform 0.2s",
                    }}
                  >
                    ▶
                  </span>
                  🗑️ Trash ({trashCount})
                </button>

                {ifElse(
                  trashExpanded,
                  <div style={{ paddingLeft: "16px", marginTop: "8px" }}>
                    {trashedSubCharms.map(
                      (entry: TrashedSubCharmEntry) => {
                        const displayInfo = getModuleDisplay({ type: entry.type });
                        return (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "8px 12px",
                              background: "#f9fafb",
                              borderRadius: "6px",
                              marginBottom: "4px",
                              opacity: "0.7",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "13px",
                                color: "#6b7280",
                                flex: "1",
                              }}
                            >
                              {displayInfo.icon} {displayInfo.label}
                            </span>
                            <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                              <button
                                onClick={restoreSubCharm({
                                  subCharms,
                                  trashedSubCharms,
                                  entry,
                                })}
                                style={{
                                  background: "#e0f2fe",
                                  border: "1px solid #7dd3fc",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  color: "#0369a1",
                                }}
                                title="Restore"
                              >
                                ↩️
                              </button>
                              <button
                                onClick={permanentlyDelete({
                                  trashedSubCharms,
                                  entry,
                                })}
                                style={{
                                  background: "transparent",
                                  border: "1px solid #fecaca",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  color: "#dc2626",
                                }}
                                title="Delete permanently"
                              >
                                🗑️
                              </button>
                            </div>
                          </div>
                        );
                      }
                    )}

                    <button
                      onClick={emptyTrash({ trashedSubCharms })}
                      style={{
                        marginTop: "8px",
                        background: "transparent",
                        border: "1px solid #fecaca",
                        borderRadius: "4px",
                        cursor: "pointer",
                        padding: "6px 12px",
                        fontSize: "12px",
                        color: "#dc2626",
                        width: "100%",
                      }}
                    >
                      Empty Trash
                    </button>
                  </div>,
                  null
                )}
              </div>,
              null
            )}
          </div>
        </ct-vstack>
      ),
      title,
      subCharms,
      trashedSubCharms,
      "#record": true,
    };
  }
);

export default Record;
