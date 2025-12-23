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
import { inferTypeFromModules } from "./record/template-registry.ts";
import { TypePickerModule } from "./type-picker.tsx";
import { ExtractorModule } from "./record/extraction/extractor-module.tsx";
import { getResultSchema } from "./record/extraction/schema-utils.ts";
import type { ContainerCoordinationContext } from "./container-protocol.ts";
import type { SubCharmEntry, TrashedSubCharmEntry } from "./record/types.ts";

// ===== Standard Labels for Smart Defaults =====
// When adding a second module of same type, pick next unused standard label
const STANDARD_LABELS: Record<string, string[]> = {
  email: ["Personal", "Work", "School", "Other"],
  phone: ["Mobile", "Home", "Work", "Other"],
  address: ["Home", "Work", "Billing", "Shipping", "Other"],
};

// Helper to get next unused standard label for a module type
function getNextUnusedLabel(
  type: string,
  existingCharms: readonly SubCharmEntry[],
): string | undefined {
  const standards = STANDARD_LABELS[type];
  if (!standards || standards.length === 0) return undefined;

  // Collect labels already used by modules of this type
  const usedLabels = new Set<string>();
  for (const entry of existingCharms) {
    if (entry.type === type) {
      try {
        // Access the label field from the charm pattern output
        // Property access is reactive - framework handles Cell unwrapping
        // deno-lint-ignore no-explicit-any
        const charm = entry.charm as any;
        const labelValue = charm?.label;
        if (typeof labelValue === "string" && labelValue) {
          usedLabels.add(labelValue);
        }
      } catch {
        // Ignore errors from charms without label field
      }
    }
  }

  // Return first unused standard label (or undefined if all used)
  return standards.find((label) => !usedLabels.has(label));
}

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
    notesSchema: unknown;
    typePickerCharm: unknown;
    typePickerSchema: unknown;
    subCharms: Cell<SubCharmEntry[]>;
    isInitialized: Cell<boolean>;
  }>(),
  undefined,
  ({
    notesCharm,
    notesSchema,
    typePickerCharm,
    typePickerSchema,
    subCharms,
    isInitialized,
  }) => {
    if (!isInitialized.get()) {
      subCharms.set([
        { type: "notes", pinned: true, charm: notesCharm, schema: notesSchema },
        {
          type: "type-picker",
          pinned: false,
          charm: typePickerCharm,
          schema: typePickerSchema,
        },
      ]);
      isInitialized.set(true);
      return notesCharm; // Return notes charm as primary reference
    }
  },
);

// Outer lift: checks if empty, creates charms, calls inner lift
// TypePicker uses ContainerCoordinationContext protocol for parent access
// Note: We receive recordPatternJson as input to avoid capturing Record before it's defined
const initializeRecord = lift(
  toSchema<{
    currentCharms: SubCharmEntry[]; // Unwrapped value, not Cell
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    isInitialized: Cell<boolean>;
    recordPatternJson: string; // Computed that returns Record JSON string
  }>(),
  undefined,
  (
    {
      currentCharms,
      subCharms,
      trashedSubCharms,
      isInitialized,
      recordPatternJson,
    },
  ) => {
    if ((currentCharms || []).length === 0) {
      // Create Note directly with Record's pattern JSON for wiki-links
      // deno-lint-ignore no-explicit-any
      const notesCharm = Note({
        embedded: true,
        linkPattern: recordPatternJson,
      } as any);

      // Build ContainerCoordinationContext for TypePicker
      const context: ContainerCoordinationContext<SubCharmEntry> = {
        entries: subCharms,
        trashedEntries: trashedSubCharms as Cell<
          (SubCharmEntry & { trashedAt: string })[]
        >,
        createModule: (type: string) => {
          if (type === "notes") {
            // deno-lint-ignore no-explicit-any
            return Note(
              { embedded: true, linkPattern: recordPatternJson } as any,
            );
          }
          return createSubCharm(type);
        },
      };

      // Capture schema for dynamic discovery
      const notesSchema = getResultSchema(notesCharm);

      // TypePicker uses the ContainerCoordinationContext protocol
      // deno-lint-ignore no-explicit-any
      const typePickerCharm = TypePickerModule({ context } as any);

      // Capture schema for dynamic discovery
      const typePickerSchema = getResultSchema(typePickerCharm);

      return storeInitialCharms({
        notesCharm,
        notesSchema,
        typePickerCharm,
        typePickerSchema,
        subCharms,
        isInitialized,
      });
    }
  },
);

// Helper to get module display info (icon + label) from type and optional charm label
const getModuleDisplay = lift(
  // deno-lint-ignore no-explicit-any
  ({ type, charm }: { type: string; charm?: any }) => {
    const def = getDefinition(type);
    // Use charm's label if available (for email/phone/address modules)
    // Property access is reactive - framework handles Cell unwrapping
    const charmLabel = charm?.label;
    return {
      icon: def?.icon || "📋",
      label: charmLabel || def?.label || type,
    };
  },
);

// ===== Module-Scope Handlers (avoid closures, use references not indices) =====

// Toggle pin state for a sub-charm - uses entry reference, not index
const togglePin = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; entry: SubCharmEntry }
>((_event, { subCharms: sc, entry }) => {
  const current = sc.get() || [];
  // Find by reference using charm identity
  const index = current.findIndex((e) =>
    Cell.equals(e?.charm as object, entry?.charm as object)
  );
  if (index < 0) return;

  const updated = [...current];
  updated[index] = { ...entry, pinned: !entry.pinned };
  sc.set(updated);
});

// Toggle collapsed state for a sub-charm - uses entry reference, not index
const toggleCollapsed = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; entry: SubCharmEntry }
>((_event, { subCharms: sc, entry }) => {
  const current = sc.get() || [];
  // Find by reference using charm identity
  const index = current.findIndex((e) =>
    Cell.equals(e?.charm as object, entry?.charm as object)
  );
  if (index < 0) return;

  const updated = [...current];
  updated[index] = { ...entry, collapsed: !entry.collapsed };
  sc.set(updated);
});

// Toggle expanded (maximize) state for a module - shows it in full-screen overlay
const toggleExpanded = handler<
  unknown,
  { expandedCharm: Cell<unknown>; entry: SubCharmEntry }
>((_event, { expandedCharm, entry }) => {
  const current = expandedCharm.get();
  // Use Cell.equals in handler context for comparing charms
  if (current !== undefined && Cell.equals(current as object, entry?.charm as object)) {
    // Already expanded, close it
    expandedCharm.set(undefined);
  } else {
    // Expand this module
    expandedCharm.set(entry?.charm);
  }
});

// Close expanded module (used by Escape key and backdrop click)
const closeExpanded = handler<
  unknown,
  { expandedCharm: Cell<unknown> }
>((_event, { expandedCharm }) => {
  expandedCharm.set(undefined);
});

// Add a new sub-charm
// Note: Receives recordPatternJson to create Notes with correct wiki-link target
// Note: Controller modules (extractor) also receive parent Cells
const addSubCharm = handler<
  { detail: { value: string } },
  {
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    selectedAddType: Cell<string>;
    recordPatternJson: string;
  }
>((
  { detail },
  {
    subCharms: sc,
    trashedSubCharms: trash,
    selectedAddType: sat,
    recordPatternJson,
  },
) => {
  const type = detail?.value;
  if (!type) return;

  // Create the sub-charm and add it (multiple modules of same type allowed)
  const current = sc.get() || [];

  // Get smart default label for modules that support it
  const nextLabel = getNextUnusedLabel(type, current);
  const initialValues = nextLabel ? { label: nextLabel } : undefined;

  // Special case: create Note directly with Record pattern for wiki-links
  // Special case: create ExtractorModule as controller with parent Cells
  // deno-lint-ignore no-explicit-any
  const charm = type === "notes"
    ? Note({
      embedded: true,
      linkPattern: recordPatternJson,
    } as any)
    : type === "extractor"
    ? ExtractorModule({
      parentSubCharms: sc,
      parentTrashedSubCharms: trash,
    } as any)
    : createSubCharm(type, initialValues);

  // Capture schema at creation time for dynamic discovery
  const schema = getResultSchema(charm);
  sc.set([...current, {
    type,
    pinned: false,
    collapsed: false,
    charm,
    schema,
  }]);
  sat.set("");
});

// Move sub-charm to trash (soft delete) - uses Cell.push() and Cell.remove()
const trashSubCharm = handler<
  unknown,
  {
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    entry: SubCharmEntry;
  }
>((_event, { subCharms: sc, trashedSubCharms: trash, entry }) => {
  // Move to trash with timestamp
  trash.push({ ...entry, trashedAt: new Date().toISOString() });

  // Remove from active
  sc.remove(entry);
});

// Restore sub-charm from trash - uses Cell.push() and Cell.remove()
const restoreSubCharm = handler<
  unknown,
  {
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    entry: TrashedSubCharmEntry;
  }
>((_event, { subCharms: sc, trashedSubCharms: trash, entry }) => {
  // Restore to active (without trashedAt, reset collapsed state)
  const { trashedAt: _trashedAt, ...restored } = entry;
  sc.push({ ...restored, collapsed: false });

  // Remove from trash
  trash.remove(entry);
});

// Permanently delete from trash - uses Cell.remove() with entry reference
const permanentlyDelete = handler<
  unknown,
  {
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    entry: TrashedSubCharmEntry;
  }
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

// Open the note editor modal for a module
const openNoteEditor = handler<
  unknown,
  {
    subCharms: Cell<SubCharmEntry[]>;
    editingNoteIndex: Cell<number | undefined>;
    editingNoteText: Cell<string | undefined>;
    entry: SubCharmEntry;
  }
>((_event, { subCharms, editingNoteIndex, editingNoteText, entry }) => {
  if (!entry) return;
  // Find the index of this entry in subCharms
  const current = subCharms.get() || [];
  const index = current.findIndex((e) =>
    Cell.equals(e?.charm as object, entry?.charm as object)
  );
  if (index < 0) return;
  editingNoteIndex.set(index);
  editingNoteText.set(entry.note || "");
});

// Save the note and close the modal
const saveNote = handler<
  unknown,
  {
    subCharms: Cell<SubCharmEntry[]>;
    editingNoteIndex: Cell<number | undefined>;
    editingNoteText: Cell<string | undefined>;
  }
>((_event, { subCharms: sc, editingNoteIndex, editingNoteText }) => {
  const index = editingNoteIndex.get();
  const noteValue = (editingNoteText.get() || "").trim();

  // Close modal FIRST before any other operations
  editingNoteIndex.set(undefined);
  editingNoteText.set(undefined);

  // Validate we have an index to save
  if (index === undefined || index < 0) return;

  const current = sc.get() || [];
  if (index >= current.length) return;

  const originalEntry = current[index];
  const updated = [...current];
  updated[index] = { ...originalEntry, note: noteValue || undefined };
  sc.set(updated);
});

// Close the note editor without saving
const closeNoteEditor = handler<
  unknown,
  {
    editingNoteIndex: Cell<number | undefined>;
    editingNoteText: Cell<string | undefined>;
  }
>((_event, { editingNoteIndex, editingNoteText }) => {
  editingNoteIndex.set(undefined);
  editingNoteText.set(undefined);
});

// Toggle trash section expanded/collapsed
const toggleTrashExpanded = handler<unknown, { expanded: Cell<boolean> }>(
  (_event, { expanded }) => expanded.set(!expanded.get()),
);

// Create sibling module (same type, inserted after current)
// Used by '+' button in module headers for email/phone/address
const createSibling = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; entry: SubCharmEntry }
>((_event, { subCharms: sc, entry }) => {
  const current = sc.get() || [];
  const currentIndex = current.findIndex((e) =>
    Cell.equals(e?.charm as object, entry?.charm as object)
  );
  if (currentIndex < 0) return;

  // Get smart default label
  const nextLabel = getNextUnusedLabel(entry.type, current);
  const initialValues = nextLabel ? { label: nextLabel } : undefined;

  // Create new module of same type
  const charm = createSubCharm(entry.type, initialValues);

  // Insert after current position
  const updated = [...current];
  updated.splice(currentIndex + 1, 0, {
    type: entry.type,
    pinned: false,
    collapsed: false,
    charm,
  });
  sc.set(updated);
});

// ===== The Record Pattern =====
const Record = pattern<RecordInput, RecordOutput>(
  ({ title, subCharms, trashedSubCharms }) => {
    // Local state
    const selectedAddType = Cell.of<string>("");
    const trashExpanded = Cell.of(false);

    // Note editor modal state
    // NOTE: In the future, this should use a <ct-modal> component instead of inline implementation.
    // A ct-modal component would follow the ct-fab pattern:
    //   <ct-modal $open={isOpen} onct-modal-close={handleClose}>
    //     <content />
    //   </ct-modal>
    // With features: backdrop blur, escape key, focus trap, centered positioning, animations
    // IMPORTANT: Don't use Cell.of(null) - it creates a cell pointing to null, not primitive null.
    // Use Cell.of() without argument so .get() returns undefined (falsy) initially.
    // We store the INDEX instead of the entry to decouple modal state from array updates.
    const editingNoteIndex = Cell.of<number | undefined>();
    const editingNoteText = Cell.of<string>();

    // Expanded (maximized) module state - ephemeral, not persisted
    // Stores the charm reference of the currently expanded module
    const expandedCharm = Cell.of<unknown>();

    // Create Record pattern JSON for wiki-links in Notes
    // Using computed() defers evaluation until render time, avoiding circular dependency
    const recordPatternJson = computed(() => JSON.stringify(Record));

    // ===== Auto-initialize Notes + TypePicker =====
    // Capture return value to force lift execution (fixes wiki-link creation)
    const isInitialized = Cell.of(false);
    const _initialized = initializeRecord({
      currentCharms: subCharms,
      subCharms,
      trashedSubCharms,
      isInitialized,
      recordPatternJson,
    });

    // ===== Computed Values =====

    // Display name with fallback
    const displayName = computed(() => title?.trim() || "(Untitled Record)");

    // Entry type with pre-computed isExpanded flag
    type EntryWithExpanded = SubCharmEntry & { isExpanded: boolean };

    // Pre-compute expanded state using Cell.equals (idiomatic pattern from test-cell-equals.tsx)
    // This avoids "Cannot create cell link" errors by calling .get() on both cells
    // BEFORE mapping, so Cell.equals receives plain values, not reactive proxies.
    const entriesWithExpanded = lift(
      ({ sc, expanded }: { sc: SubCharmEntry[]; expanded: unknown }) => {
        const entries = sc || [];
        return entries.map((entry) => ({
          ...entry,
          isExpanded: expanded !== undefined &&
            Cell.equals(expanded as object, entry?.charm as object),
        }));
      },
    )({ sc: subCharms, expanded: expandedCharm });

    // Split sub-charms by pin status, including pre-computed isExpanded
    const pinnedEntries = lift(({ arr }: { arr: EntryWithExpanded[] }) =>
      (arr || []).filter((entry) => entry?.pinned)
    )({ arr: entriesWithExpanded });

    const unpinnedEntries = lift(({ arr }: { arr: EntryWithExpanded[] }) =>
      (arr || []).filter((entry) => !entry?.pinned)
    )({ arr: entriesWithExpanded });

    // All subcharms (for grid layout when no split needed)
    const allEntries = lift(({ arr }: { arr: EntryWithExpanded[] }) => arr || [])({
      arr: entriesWithExpanded,
    });

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
      const existingTypes = new Set(
        (sc || []).map((e) => e?.type).filter(Boolean),
      );
      const allTypes = getAddableTypes();

      const newTypes = allTypes.filter((def) => !existingTypes.has(def.type));
      const existingTypesDefs = allTypes.filter((def) =>
        existingTypes.has(def.type)
      );

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

    // Check for manual icon override from record-icon module
    const manualIcon = lift(({ sc }: { sc: SubCharmEntry[] }) => {
      const iconModule = (sc || []).find((e) => e?.type === "record-icon");
      if (!iconModule) return null;

      try {
        // Access the icon field from the charm pattern output
        // deno-lint-ignore no-explicit-any
        const charm = iconModule.charm as any;
        const iconValue = charm?.icon;
        // Return the icon if it's a non-empty string, otherwise null
        return typeof iconValue === "string" && iconValue.trim()
          ? iconValue.trim()
          : null;
      } catch {
        return null;
      }
    })({ sc: subCharms });

    // Extract icon: manual icon takes precedence over inferred type
    const recordIcon = lift(
      ({
        manual,
        inferred,
      }: {
        manual: string | null;
        inferred: { icon: string };
      }) => manual || inferred?.icon || "\u{1F4CB}",
    )({ manual: manualIcon, inferred: inferredType });

    // Extract nicknames from nickname modules for display in NAME
    const nicknamesList = lift(({ sc }: { sc: SubCharmEntry[] }) => {
      const nicknameModules = (sc || []).filter((e) => e?.type === "nickname");
      const nicknames: string[] = [];
      for (const mod of nicknameModules) {
        try {
          // Access the nickname field from the charm pattern output
          // deno-lint-ignore no-explicit-any
          const charm = mod.charm as any;
          const nicknameValue = charm?.nickname;
          if (typeof nicknameValue === "string" && nicknameValue.trim()) {
            nicknames.push(nicknameValue.trim());
          }
        } catch {
          // Ignore errors from charms without nickname field
        }
      }
      return nicknames;
    })({ sc: subCharms });

    // Build display name with nickname alias if present
    const displayNameWithAlias = lift(
      ({
        name,
        nicknames,
      }: {
        name: string;
        nicknames: string[];
      }) => {
        if (nicknames.length === 0) return name;
        // Show all nicknames as aliases (aka Liz, Beth, Lizzie)
        return `${name} (aka ${nicknames.join(", ")})`;
      },
    )({ name: displayName, nicknames: nicknamesList });

    // ===== Trash Section Computed Values =====

    // Compute trash count directly
    const trashCount = lift(({ t }: { t: TrashedSubCharmEntry[] }) =>
      (t || []).length
    )({ t: trashedSubCharms });

    // Check if there are any trashed items
    const hasTrash = lift(({ t }: { t: TrashedSubCharmEntry[] }) =>
      (t || []).length > 0
    )({ t: trashedSubCharms });

    // Check if any module is expanded (maximized)
    const hasExpanded = lift(({ ec }: { ec: unknown }) => ec !== undefined)({
      ec: expandedCharm,
    });

    // ===== Main UI =====
    return {
      [NAME]: str`${recordIcon} ${displayNameWithAlias}`,
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
                onct-change={addSubCharm({
                  subCharms,
                  trashedSubCharms,
                  selectedAddType,
                  recordPatternJson,
                })}
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
                <div
                  style={{
                    flex: 2,
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  {pinnedEntries.map((entry) => {
                    const displayInfo = getModuleDisplay({
                      type: entry.type,
                      charm: entry.charm,
                    });
                    return (
                      <div
                        style={computed(() => {
                          // Use pre-computed isExpanded from entriesWithExpanded (idiomatic Cell.equals)
                          if (entry.isExpanded) {
                            return {
                              position: "fixed",
                              top: "50%",
                              left: "50%",
                              transform: "translate(-50%, -50%)",
                              zIndex: "1001",
                              width: "95%",
                              maxWidth: "1200px",
                              height: "90%",
                              maxHeight: "800px",
                              background: "white",
                              borderRadius: "12px",
                              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                              overflow: "hidden",
                              display: "flex",
                              flexDirection: "column",
                            };
                          }
                          return {
                            background: "white",
                            borderRadius: "8px",
                            border: "1px solid #e5e7eb",
                            overflow: "hidden",
                          };
                        })}
                      >
                        <div
                          style={computed(() => ({
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "8px 12px",
                            borderBottom: entry.collapsed
                              ? "none"
                              : "1px solid #f3f4f6",
                            background: "#fafafa",
                          }))}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              flex: "1",
                            }}
                          >
                            <button
                              type="button"
                              onClick={toggleCollapsed({ subCharms, entry })}
                              aria-expanded={computed(() =>
                                entry.collapsed ? "false" : "true"
                              )}
                              aria-label="Toggle module"
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                padding: "4px",
                                display: "flex",
                                alignItems: "center",
                              }}
                            >
                              <span
                                style={computed(() => ({
                                  transform: entry.collapsed
                                    ? "rotate(0deg)"
                                    : "rotate(90deg)",
                                  transition: "transform 0.2s",
                                  fontSize: "10px",
                                  color: "#9ca3af",
                                }))}
                              >
                                ▶
                              </span>
                            </button>
                            <span
                              style={{
                                fontSize: "14px",
                                fontWeight: "500",
                              }}
                            >
                              {displayInfo.icon} {displayInfo.label}
                            </span>
                          </div>
                          {ifElse(
                            computed(() => !entry.collapsed),
                            <div
                              style={{
                                display: "flex",
                                gap: "8px",
                                alignItems: "center",
                                flexShrink: 0,
                              }}
                            >
                              {ifElse(
                                getDefinition(entry.type)?.allowMultiple,
                                <button
                                  type="button"
                                  onClick={createSibling({ subCharms, entry })}
                                  style={{
                                    background: "transparent",
                                    border: "1px solid #e5e7eb",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    color: "#6b7280",
                                  }}
                                  title="Add another"
                                >
                                  +
                                </button>,
                                null,
                              )}
                              <button
                                type="button"
                                onClick={openNoteEditor({
                                  subCharms,
                                  editingNoteIndex,
                                  editingNoteText,
                                  entry,
                                })}
                                style={computed(() => ({
                                  background: "transparent",
                                  border: "1px solid #e5e7eb",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  color: "#6b7280",
                                  fontWeight: entry?.note ? "700" : "400",
                                }))}
                                title={computed(() =>
                                  entry?.note || "Add note..."
                                )}
                              >
                                📝
                              </button>
                              <button
                                type="button"
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
                                type="button"
                                onClick={toggleExpanded({ expandedCharm, entry })}
                                style={computed(() => ({
                                  background: entry.isExpanded
                                    ? "#3b82f6"
                                    : "transparent",
                                  border: entry.isExpanded
                                    ? "1px solid #3b82f6"
                                    : "1px solid #e5e7eb",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  color: entry.isExpanded ? "white" : "#6b7280",
                                }))}
                                title={entry.isExpanded ? "Close" : "Maximize"}
                              >
                                {entry.isExpanded ? "✕" : "⛶"}
                              </button>
                              <button
                                type="button"
                                onClick={trashSubCharm({
                                  subCharms,
                                  trashedSubCharms,
                                  entry,
                                })}
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
                            </div>,
                            null,
                          )}
                        </div>
                        {ifElse(
                          computed(() => !entry.collapsed),
                          <div
                            style={computed(() => ({
                              padding: entry.isExpanded ? "16px" : "12px",
                              // When expanded, fill the fixed container
                              flex: entry.isExpanded ? "1" : "none",
                              overflow: entry.isExpanded ? "auto" : "hidden",
                              minHeight: entry.isExpanded ? "0" : "auto",
                            }))}
                          >
                            {entry.charm as any}
                          </div>,
                          null,
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Right: Unpinned items in rail (1/3 width) */}
                {ifElse(
                  hasUnpinned,
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      gap: "12px",
                    }}
                  >
                    {unpinnedEntries.map((entry) => {
                      const displayInfo = getModuleDisplay({
                        type: entry.type,
                        charm: entry.charm,
                      });
                      return (
                        <div
                          style={computed(() => {
                            // Use pre-computed isExpanded from entriesWithExpanded (idiomatic Cell.equals)
                            if (entry.isExpanded) {
                              return {
                                position: "fixed",
                                top: "50%",
                                left: "50%",
                                transform: "translate(-50%, -50%)",
                                zIndex: "1001",
                                width: "95%",
                                maxWidth: "1200px",
                                height: "90%",
                                maxHeight: "800px",
                                background: "white",
                                borderRadius: "12px",
                                boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                                overflow: "hidden",
                                display: "flex",
                                flexDirection: "column",
                              };
                            }
                            return {
                              background: "white",
                              borderRadius: "8px",
                              border: "1px solid #e5e7eb",
                              overflow: "hidden",
                            };
                          })}
                        >
                          <div
                            style={computed(() => ({
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "8px 12px",
                              borderBottom: entry.collapsed
                                ? "none"
                                : "1px solid #f3f4f6",
                              background: "#fafafa",
                            }))}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                flex: "1",
                              }}
                            >
                              <button
                                type="button"
                                onClick={toggleCollapsed({ subCharms, entry })}
                                aria-expanded={computed(() =>
                                  entry.collapsed ? "false" : "true"
                                )}
                                aria-label="Toggle module"
                                style={{
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  padding: "4px",
                                  display: "flex",
                                  alignItems: "center",
                                }}
                              >
                                <span
                                  style={computed(() => ({
                                    transform: entry.collapsed
                                      ? "rotate(0deg)"
                                      : "rotate(90deg)",
                                    transition: "transform 0.2s",
                                    fontSize: "10px",
                                    color: "#9ca3af",
                                  }))}
                                >
                                  ▶
                                </span>
                              </button>
                              <span
                                style={{
                                  fontSize: "14px",
                                  fontWeight: "500",
                                }}
                              >
                                {displayInfo.icon} {displayInfo.label}
                              </span>
                            </div>
                            {ifElse(
                              computed(() => !entry.collapsed),
                              <div
                                style={{
                                  display: "flex",
                                  gap: "8px",
                                  alignItems: "center",
                                  flexShrink: 0,
                                }}
                              >
                                {ifElse(
                                  getDefinition(entry.type)?.allowMultiple,
                                  <button
                                    type="button"
                                    onClick={createSibling({
                                      subCharms,
                                      entry,
                                    })}
                                    style={{
                                      background: "transparent",
                                      border: "1px solid #e5e7eb",
                                      borderRadius: "4px",
                                      cursor: "pointer",
                                      padding: "4px 8px",
                                      fontSize: "12px",
                                      color: "#6b7280",
                                    }}
                                    title="Add another"
                                  >
                                    +
                                  </button>,
                                  null,
                                )}
                                <button
                                  type="button"
                                  onClick={openNoteEditor({
                                    subCharms,
                                    editingNoteIndex,
                                    editingNoteText,
                                    entry,
                                  })}
                                  style={computed(() => ({
                                    background: "transparent",
                                    border: "1px solid #e5e7eb",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    color: "#6b7280",
                                    fontWeight: entry?.note ? "700" : "400",
                                  }))}
                                  title={computed(() =>
                                    entry?.note || "Add note..."
                                  )}
                                >
                                  📝
                                </button>
                                <button
                                  type="button"
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
                                  type="button"
                                  onClick={toggleExpanded({ expandedCharm, entry })}
                                  style={computed(() => ({
                                    background: entry.isExpanded
                                      ? "#3b82f6"
                                      : "transparent",
                                    border: entry.isExpanded
                                      ? "1px solid #3b82f6"
                                      : "1px solid #e5e7eb",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    color: entry.isExpanded ? "white" : "#6b7280",
                                  }))}
                                  title={entry.isExpanded ? "Close" : "Maximize"}
                                >
                                  {entry.isExpanded ? "✕" : "⛶"}
                                </button>
                                <button
                                  type="button"
                                  onClick={trashSubCharm({
                                    subCharms,
                                    trashedSubCharms,
                                    entry,
                                  })}
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
                              </div>,
                              null,
                            )}
                          </div>
                          {ifElse(
                            computed(() => !entry.collapsed),
                            <div
                              style={computed(() => ({
                                padding: entry.isExpanded ? "16px" : "12px",
                                // When expanded, fill the fixed container
                                flex: entry.isExpanded ? "1" : "none",
                                overflow: entry.isExpanded ? "auto" : "hidden",
                                minHeight: entry.isExpanded ? "0" : "auto",
                              }))}
                            >
                              {entry.charm as any}
                            </div>,
                            null,
                          )}
                        </div>
                      );
                    })}
                  </div>,
                  null,
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
                {allEntries.map((entry) => {
                  const displayInfo = getModuleDisplay({
                    type: entry.type,
                    charm: entry.charm,
                  });
                  return (
                    <div
                      style={computed(() => {
                        // Use pre-computed isExpanded from entriesWithExpanded (idiomatic Cell.equals)
                        if (entry.isExpanded) {
                          return {
                            position: "fixed",
                            top: "50%",
                            left: "50%",
                            transform: "translate(-50%, -50%)",
                            zIndex: "1001",
                            width: "95%",
                            maxWidth: "1200px",
                            height: "90%",
                            maxHeight: "800px",
                            background: "white",
                            borderRadius: "12px",
                            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                            overflow: "hidden",
                            display: "flex",
                            flexDirection: "column",
                          };
                        }
                        return {
                          background: "white",
                          borderRadius: "8px",
                          border: "1px solid #e5e7eb",
                          overflow: "hidden",
                        };
                      })}
                    >
                      <div
                        style={computed(() => ({
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "8px 12px",
                          borderBottom: entry.collapsed
                            ? "none"
                            : "1px solid #f3f4f6",
                          background: "#fafafa",
                        }))}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            flex: "1",
                          }}
                        >
                          <button
                            type="button"
                            onClick={toggleCollapsed({ subCharms, entry })}
                            aria-expanded={computed(() =>
                              entry.collapsed ? "false" : "true"
                            )}
                            aria-label="Toggle module"
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: "4px",
                              display: "flex",
                              alignItems: "center",
                            }}
                          >
                            <span
                              style={computed(() => ({
                                transform: entry.collapsed
                                  ? "rotate(0deg)"
                                  : "rotate(90deg)",
                                transition: "transform 0.2s",
                                fontSize: "10px",
                                color: "#9ca3af",
                              }))}
                            >
                              ▶
                            </span>
                          </button>
                          <span
                            style={{
                              fontSize: "14px",
                              fontWeight: "500",
                            }}
                          >
                            {displayInfo.icon} {displayInfo.label}
                          </span>
                        </div>
                        {ifElse(
                          computed(() => !entry.collapsed),
                          <div
                            style={{
                              display: "flex",
                              gap: "8px",
                              alignItems: "center",
                              flexShrink: 0,
                            }}
                          >
                            {ifElse(
                              getDefinition(entry.type)?.allowMultiple,
                              <button
                                type="button"
                                onClick={createSibling({ subCharms, entry })}
                                style={{
                                  background: "transparent",
                                  border: "1px solid #e5e7eb",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  color: "#6b7280",
                                }}
                                title="Add another"
                              >
                                +
                              </button>,
                              null,
                            )}
                            <button
                              type="button"
                              onClick={openNoteEditor({
                                subCharms,
                                editingNoteIndex,
                                editingNoteText,
                                entry,
                              })}
                              style={computed(() => ({
                                background: "transparent",
                                border: "1px solid #e5e7eb",
                                borderRadius: "4px",
                                cursor: "pointer",
                                padding: "4px 8px",
                                fontSize: "12px",
                                color: "#6b7280",
                                fontWeight: entry?.note ? "700" : "400",
                              }))}
                              title={computed(() =>
                                entry?.note || "Add note..."
                              )}
                            >
                              📝
                            </button>
                            <button
                              type="button"
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
                              type="button"
                              onClick={toggleExpanded({ expandedCharm, entry })}
                              style={computed(() => ({
                                background: entry.isExpanded
                                  ? "#3b82f6"
                                  : "transparent",
                                border: entry.isExpanded
                                  ? "1px solid #3b82f6"
                                  : "1px solid #e5e7eb",
                                borderRadius: "4px",
                                cursor: "pointer",
                                padding: "4px 8px",
                                fontSize: "12px",
                                color: entry.isExpanded ? "white" : "#6b7280",
                              }))}
                              title={entry.isExpanded ? "Close" : "Maximize"}
                            >
                              {entry.isExpanded ? "✕" : "⛶"}
                            </button>
                            <button
                              type="button"
                              onClick={trashSubCharm({
                                subCharms,
                                trashedSubCharms,
                                entry,
                              })}
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
                          </div>,
                          null,
                        )}
                      </div>
                      {ifElse(
                        computed(() => !entry.collapsed),
                        <div
                          style={computed(() => ({
                            padding: entry.isExpanded ? "16px" : "12px",
                            // When expanded, fill the fixed container
                            flex: entry.isExpanded ? "1" : "none",
                            overflow: entry.isExpanded ? "auto" : "hidden",
                            minHeight: entry.isExpanded ? "0" : "auto",
                          }))}
                        >
                          {entry.charm as any}
                        </div>,
                        null,
                      )}
                    </div>
                  );
                })}
              </div>,
            )}

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
                  type="button"
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
                    style={computed(() => ({
                      transform: trashExpanded.get()
                        ? "rotate(90deg)"
                        : "rotate(0deg)",
                      transition: "transform 0.2s",
                    }))}
                  >
                    ▶
                  </span>
                  🗑️ Trash ({trashCount})
                </button>

                {ifElse(
                  computed(() => trashExpanded.get()),
                  <div style={{ paddingLeft: "16px", marginTop: "8px" }}>
                    {trashedSubCharms.map(
                      (entry) => {
                        const displayInfo = getModuleDisplay({
                          type: entry.type,
                          charm: entry.charm,
                        });
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
                            <div
                              style={{
                                display: "flex",
                                gap: "8px",
                                flexShrink: 0,
                              }}
                            >
                              <button
                                type="button"
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
                                type="button"
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
                      },
                    )}

                    <button
                      type="button"
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
                  null,
                )}
              </div>,
              null,
            )}
          </div>

          {
            /*
             * Note Editor Modal
             * NOTE: Replace with <ct-modal> component when available.
             * Future ct-modal API would be:
             *   <ct-modal
             *     $open={editingNoteIndex}
             *     onct-modal-close={closeNoteEditor({...})}
             *     backdrop="blur"
             *   >
             *     <content />
             *   </ct-modal>
             *
             * Component should include:
             * - Backdrop with blur effect (backdrop-filter: blur(8px))
             * - Fixed centering with z-index 1001
             * - Escape key support (document listener)
             * - Focus trap for accessibility
             * - Smooth fade/scale animations
             * - Click-outside-to-close behavior
             */
          }
          {ifElse(
            computed(() => editingNoteIndex.get() !== undefined),
            <div>
              {/* Backdrop with blur */}
              <div
                onClick={closeNoteEditor({ editingNoteIndex, editingNoteText })}
                style={{
                  position: "fixed",
                  inset: "0",
                  backgroundColor: "rgba(0, 0, 0, 0.4)",
                  backdropFilter: "blur(8px)",
                  zIndex: "1000",
                }}
              />
              {/* Modal content */}
              <div
                style={{
                  position: "fixed",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  zIndex: "1001",
                  width: "90%",
                  maxWidth: "500px",
                  background: "white",
                  borderRadius: "12px",
                  boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                  overflow: "hidden",
                }}
              >
                {/* Header */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "16px 20px",
                    borderBottom: "1px solid #e5e7eb",
                    background: "#fafafa",
                  }}
                >
                  <span style={{ fontWeight: "600", fontSize: "16px" }}>
                    📝 Module Note
                  </span>
                  <button
                    type="button"
                    onClick={closeNoteEditor({
                      editingNoteIndex,
                      editingNoteText,
                    })}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: "4px 8px",
                      fontSize: "18px",
                      color: "#6b7280",
                    }}
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
                {/* Content */}
                <div style={{ padding: "20px" }}>
                  <ct-textarea
                    $value={editingNoteText}
                    placeholder="Add notes about this module... (visible to LLM reads)"
                    rows={6}
                    style={{ width: "100%", resize: "vertical" }}
                  />
                  {/* Keyboard shortcuts for modal */}
                  <ct-keybind
                    code="Escape"
                    ignore-editable={false}
                    onct-keybind={closeNoteEditor({
                      editingNoteIndex,
                      editingNoteText,
                    })}
                  />
                  <ct-keybind
                    code="Enter"
                    meta
                    ignore-editable={false}
                    onct-keybind={saveNote({
                      subCharms,
                      editingNoteIndex,
                      editingNoteText,
                    })}
                  />
                  <ct-keybind
                    code="Enter"
                    ctrl
                    ignore-editable={false}
                    onct-keybind={saveNote({
                      subCharms,
                      editingNoteIndex,
                      editingNoteText,
                    })}
                  />
                </div>
                {/* Footer */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "12px",
                    padding: "16px 20px",
                    borderTop: "1px solid #e5e7eb",
                    background: "#fafafa",
                  }}
                >
                  <button
                    type="button"
                    onClick={closeNoteEditor({
                      editingNoteIndex,
                      editingNoteText,
                    })}
                    style={{
                      background: "transparent",
                      border: "1px solid #e5e7eb",
                      borderRadius: "6px",
                      cursor: "pointer",
                      padding: "8px 16px",
                      fontSize: "14px",
                      color: "#6b7280",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveNote({
                      subCharms,
                      editingNoteIndex,
                      editingNoteText,
                    })}
                    style={{
                      background: "#3b82f6",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                      padding: "8px 16px",
                      fontSize: "14px",
                      color: "white",
                      fontWeight: "500",
                    }}
                  >
                    Save Note
                  </button>
                </div>
              </div>
            </div>,
            null,
          )}

          {/*
           * Expanded (Maximize) Module Overlay
           * Just provides backdrop + escape handler.
           * Module card itself becomes position:fixed when expanded.
           */}
          {ifElse(
            hasExpanded,
            <div>
              {/* Backdrop with blur - clicking closes */}
              <div
                onClick={closeExpanded({ expandedCharm })}
                style={{
                  position: "fixed",
                  inset: "0",
                  backgroundColor: "rgba(0, 0, 0, 0.4)",
                  backdropFilter: "blur(8px)",
                  zIndex: "1000",
                }}
              />
              {/* Escape key handler */}
              <ct-keybind
                code="Escape"
                ignore-editable={false}
                onct-keybind={closeExpanded({ expandedCharm })}
              />
            </div>,
            null,
          )}
        </ct-vstack>
      ),
      title,
      subCharms,
      trashedSubCharms,
      "#record": true,
    };
  },
);

export default Record;
