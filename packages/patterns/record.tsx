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
import Note from "./notes/note.tsx";
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
      // Create Note as default module (rendered via ct-render variant="embedded")
      // Pass recordPatternJson so [[wiki-links]] create Record charms instead of Note charms
      const notesCharm = Note({ linkPattern: recordPatternJson });

      // Build ContainerCoordinationContext for TypePicker
      const context: ContainerCoordinationContext<SubCharmEntry> = {
        entries: subCharms,
        trashedEntries: trashedSubCharms as Cell<
          (SubCharmEntry & { trashedAt: string })[]
        >,
        createModule: (type: string) => {
          if (type === "notes") {
            return Note({ linkPattern: recordPatternJson });
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

// Helper to check if a module has settings UI
const moduleHasSettings = lift(
  // deno-lint-ignore no-explicit-any
  ({ charm }: { charm?: any }) => {
    // Check if the charm exports a settingsUI
    return !!charm?.settingsUI;
  },
);

// ===== Module-Scope Handlers (avoid closures, use references not indices) =====

// Toggle pin state for a sub-charm - uses entry reference, not index
const togglePin = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; index: number }
>((_event, { subCharms: sc, index }) => {
  const current = sc.get() || [];
  const entry = current[index];
  if (!entry) return;

  const updated = [...current];
  updated[index] = { ...entry, pinned: !entry.pinned };
  sc.set(updated);
});

// Toggle collapsed state for a sub-charm - uses index for reliable lookup
const toggleCollapsed = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; index: number }
>((_event, { subCharms: sc, index }) => {
  const current = sc.get() || [];
  const entry = current[index];
  if (!entry) return;

  const updated = [...current];
  updated[index] = { ...entry, collapsed: !entry.collapsed };
  sc.set(updated);
});

// Toggle expanded (maximize) state for a module - shows it in full-screen overlay
// Simple index-based approach: tracks which index is expanded (ephemeral UI state)
const toggleExpanded = handler<
  unknown,
  { expandedIndex: Cell<number | undefined>; index: number }
>((_event, { expandedIndex, index }) => {
  const current = expandedIndex.get();
  if (current === index) {
    // Already expanded, close it
    expandedIndex.set(undefined);
  } else {
    // Expand this module
    expandedIndex.set(index);
  }
});

// Close expanded module (used by Escape key and backdrop click)
const closeExpanded = handler<
  unknown,
  { expandedIndex: Cell<number | undefined> }
>((_event, { expandedIndex }) => {
  expandedIndex.set(undefined);
});

// Add a new sub-charm
// Note: Receives recordPatternJson to create Notes with correct wiki-link target
// Note: Controller modules (extractor) also receive parent Cells and title
const addSubCharm = handler<
  { detail: { value: string } },
  {
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    title: Cell<string>;
    selectedAddType: Cell<string>;
    recordPatternJson: string;
  }
>((
  { detail },
  {
    subCharms: sc,
    trashedSubCharms: trash,
    title,
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

  // Special case: create Note (rendered via ct-render variant="embedded")
  // Pass recordPatternJson so [[wiki-links]] create Record charms instead of Note charms
  // Special case: create ExtractorModule as controller with parent Cells and title
  const charm = type === "notes"
    ? Note({ linkPattern: recordPatternJson })
    : type === "extractor"
    ? ExtractorModule({
      parentSubCharms: sc,
      parentTrashedSubCharms: trash,
      parentTitle: title,
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
// Also adjusts expandedIndex to prevent stale index pointing to wrong module
const trashSubCharm = handler<
  unknown,
  {
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    expandedIndex: Cell<number | undefined>;
    settingsModuleIndex: Cell<number | undefined>;
    index: number;
  }
>((
  _event,
  {
    subCharms: sc,
    trashedSubCharms: trash,
    expandedIndex,
    settingsModuleIndex,
    index,
  },
) => {
  const current = sc.get() || [];
  const entry = current[index];
  if (!entry) return;

  // Move to trash with timestamp
  trash.push({ ...entry, trashedAt: new Date().toISOString() });

  // Remove from active using splice
  const updated = [...current];
  updated.splice(index, 1);
  sc.set(updated);

  // Adjust expandedIndex to prevent stale reference
  const currentExpanded = expandedIndex.get();
  if (currentExpanded !== undefined) {
    if (currentExpanded === index) {
      // Deleted the expanded item - close the modal
      expandedIndex.set(undefined);
    } else if (currentExpanded > index) {
      // Item before expanded item was deleted - shift index down
      expandedIndex.set(currentExpanded - 1);
    }
  }

  // Adjust settingsModuleIndex to prevent stale reference
  const currentSettings = settingsModuleIndex.get();
  if (currentSettings !== undefined) {
    if (currentSettings === index) {
      // Deleted the item with settings open - close the modal
      settingsModuleIndex.set(undefined);
    } else if (currentSettings > index) {
      // Item before settings item was deleted - shift index down
      settingsModuleIndex.set(currentSettings - 1);
    }
  }
});

// Restore sub-charm from trash - uses index for reliable lookup
const restoreSubCharm = handler<
  unknown,
  {
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    trashIndex: number;
  }
>((_event, { subCharms: sc, trashedSubCharms: trash, trashIndex }) => {
  const current = trash.get() || [];
  const entry = current[trashIndex];
  if (!entry) return;

  // Restore to active (without trashedAt, reset collapsed state)
  const { trashedAt: _trashedAt, ...restored } = entry;
  sc.push({ ...restored, collapsed: false });

  // Remove from trash using splice
  const updated = [...current];
  updated.splice(trashIndex, 1);
  trash.set(updated);
});

// Permanently delete from trash - uses index for reliable lookup
const permanentlyDelete = handler<
  unknown,
  {
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    trashIndex: number;
  }
>((_event, { trashedSubCharms: trash, trashIndex }) => {
  const current = trash.get() || [];
  if (trashIndex < 0 || trashIndex >= current.length) return;

  const updated = [...current];
  updated.splice(trashIndex, 1);
  trash.set(updated);
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
    index: number;
  }
>((_event, { subCharms, editingNoteIndex, editingNoteText, index }) => {
  const current = subCharms.get() || [];
  const entry = current[index];
  if (!entry) return;
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

// Open the settings modal for a module
const openSettings = handler<
  unknown,
  {
    settingsModuleIndex: Cell<number | undefined>;
    index: number;
  }
>((_event, { settingsModuleIndex, index }) => {
  settingsModuleIndex.set(index);
});

// Close the settings modal
const closeSettings = handler<
  unknown,
  { settingsModuleIndex: Cell<number | undefined> }
>((_event, { settingsModuleIndex }) => {
  settingsModuleIndex.set(undefined);
});

// Toggle trash section expanded/collapsed
const toggleTrashExpanded = handler<unknown, { expanded: Cell<boolean> }>(
  (_event, { expanded }) => expanded.set(!expanded.get()),
);

// ===== LLM-Callable Handlers for Omnibot Integration =====
// These handlers are exposed in the pattern output for Omnibot's invoke() tool
// IMPORTANT: Handlers must use result.set() to return data to the LLM.
// The 'result' Cell is injected by llm-dialog.ts invoke() - return statements are ignored!

// Get a structured summary of all modules in this record
// Returns module types, their data, and schemas for LLM context
const handleGetSummary = handler<
  { result?: Cell<unknown> },
  {
    title: Cell<string>;
    subCharms: Cell<SubCharmEntry[]>;
  }
>(({ result }, { title, subCharms }) => {
  const modules = subCharms.get() || [];
  const summary = {
    title: title.get() || "(Untitled Record)",
    moduleCount: modules.length,
    modules: modules.map((entry, index) => {
      const def = getDefinition(entry.type);
      // Extract data from charm - access common fields reactively
      // deno-lint-ignore no-explicit-any
      const charm = entry.charm as any;
      const moduleData: Record<string, unknown> = {};

      // Try to extract common fields based on module type
      try {
        // Most modules have a primary value field
        if (charm?.label !== undefined) moduleData.label = charm.label;
        if (charm?.value !== undefined) moduleData.value = charm.value;
        if (charm?.content !== undefined) moduleData.content = charm.content;
        if (charm?.address !== undefined) moduleData.address = charm.address;
        if (charm?.email !== undefined) moduleData.email = charm.email;
        if (charm?.phone !== undefined) moduleData.phone = charm.phone;
        if (charm?.rating !== undefined) moduleData.rating = charm.rating;
        if (charm?.tags !== undefined) moduleData.tags = charm.tags;
        if (charm?.status !== undefined) moduleData.status = charm.status;
        if (charm?.nickname !== undefined) moduleData.nickname = charm.nickname;
        if (charm?.icon !== undefined) moduleData.icon = charm.icon;
        if (charm?.birthDate !== undefined) {
          moduleData.birthDate = charm.birthDate;
        }
        if (charm?.birthYear !== undefined) {
          moduleData.birthYear = charm.birthYear;
        }
        if (charm?.url !== undefined) moduleData.url = charm.url;
        if (charm?.notes !== undefined) moduleData.notes = charm.notes;
        if (charm?.occurrences !== undefined) {
          moduleData.occurrences = charm.occurrences;
        }
      } catch {
        // Ignore errors from charms without expected fields
      }

      return {
        index,
        type: entry.type,
        icon: def?.icon || "📋",
        label: def?.label || entry.type,
        pinned: entry.pinned || false,
        collapsed: entry.collapsed || false,
        note: entry.note,
        data: moduleData,
        schema: entry.schema,
      };
    }),
  };
  // Must use result.set() to return data to LLM - return statements are ignored!
  if (result) result.set(summary);
});

// Add a new module to this record
// type: module type from registry (email, phone, birthday, etc.)
// initialData: optional initial values for the module
const handleAddModule = handler<
  {
    type: string;
    initialData?: Record<string, unknown>;
    result?: Cell<unknown>;
  },
  {
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    title: Cell<string>;
  }
>((
  { type, initialData, result },
  { subCharms: sc, trashedSubCharms: trash, title },
) => {
  if (!type) {
    if (result) {
      result.set({ success: false, error: "Module type is required" });
    }
    return;
  }

  const def = getDefinition(type);
  if (!def) {
    if (result) {
      result.set({
        success: false,
        error: `Unknown module type: ${type}. Available types: ${
          getAddableTypes().map((d) => d.type).join(", ")
        }`,
      });
    }
    return;
  }

  const current = sc.get() || [];

  // Get smart default label for modules that support it
  const nextLabel = getNextUnusedLabel(type, current);
  const initialValues = {
    ...(nextLabel ? { label: nextLabel } : {}),
    ...initialData,
  };

  // Create the module - special cases handled
  let charm: unknown;
  if (type === "notes") {
    if (result) {
      result.set({
        success: false,
        error: "Notes modules must be added via UI (requires linkPattern)",
      });
    }
    return;
  } else if (type === "extractor") {
    // ExtractorModule needs parent Cells and title
    charm = ExtractorModule({
      parentSubCharms: sc,
      parentTrashedSubCharms: trash,
      parentTitle: title,
      // deno-lint-ignore no-explicit-any
    } as any);
  } else {
    charm = createSubCharm(type, initialValues);
  }

  // Capture schema at creation time
  const schema = getResultSchema(charm);

  sc.push({
    type,
    pinned: false,
    collapsed: false,
    charm,
    schema,
  });

  if (result) {
    result.set({
      success: true,
      moduleIndex: current.length,
      type,
      message: `Added ${def.icon} ${def.label} module`,
    });
  }
});

// Update a field in a specific module
// index: module index in subCharms array
// field: field name to update
// value: new value
const handleUpdateModule = handler<
  { index: number; field: string; value: unknown; result?: Cell<unknown> },
  { subCharms: Cell<SubCharmEntry[]> }
>(({ index, field, value, result }, { subCharms: sc }) => {
  const current = sc.get() || [];

  if (index < 0 || index >= current.length) {
    if (result) {
      result.set({
        success: false,
        error: `Invalid module index: ${index}. Valid range: 0-${
          current.length - 1
        }`,
      });
    }
    return;
  }

  const entry = current[index];
  // deno-lint-ignore no-explicit-any
  const charm = entry.charm as any;

  if (!charm) {
    if (result) result.set({ success: false, error: "Module charm not found" });
    return;
  }

  try {
    // Try to access the field as a Cell and set it
    const fieldCell = charm[field];
    if (fieldCell && typeof fieldCell.set === "function") {
      fieldCell.set(value);
      if (result) {
        result.set({
          success: true,
          message: `Updated ${field} to ${JSON.stringify(value)}`,
        });
      }
    } else if (fieldCell && typeof fieldCell.key === "function") {
      // It might be a nested cell - try setting via parent
      if (result) {
        result.set({
          success: false,
          error:
            `Field ${field} exists but is not directly settable. Try a more specific path.`,
        });
      }
    } else {
      if (result) {
        result.set({
          success: false,
          error:
            `Field ${field} not found or not a Cell on module type ${entry.type}`,
        });
      }
    }
  } catch (err) {
    if (result) {
      result.set({ success: false, error: `Failed to update field: ${err}` });
    }
  }
});

// Remove a module (move to trash)
const handleRemoveModule = handler<
  { index: number; result?: Cell<unknown> },
  {
    subCharms: Cell<SubCharmEntry[]>;
    trashedSubCharms: Cell<TrashedSubCharmEntry[]>;
  }
>(({ index, result }, { subCharms: sc, trashedSubCharms: trash }) => {
  const current = sc.get() || [];

  if (index < 0 || index >= current.length) {
    if (result) {
      result.set({
        success: false,
        error: `Invalid module index: ${index}. Valid range: 0-${
          current.length - 1
        }`,
      });
    }
    return;
  }

  const entry = current[index];
  const def = getDefinition(entry.type);

  // Move to trash with timestamp
  trash.push({ ...entry, trashedAt: new Date().toISOString() });

  // Remove from active
  const updated = [...current];
  updated.splice(index, 1);
  sc.set(updated);

  if (result) {
    result.set({
      success: true,
      message: `Moved ${def?.icon || "📋"} ${
        def?.label || entry.type
      } to trash`,
    });
  }
});

// Set the record title
const handleSetTitle = handler<
  { newTitle: string; result?: Cell<unknown> },
  { title: Cell<string> }
>(({ newTitle, result }, { title }) => {
  if (newTitle === undefined || newTitle === null) {
    if (result) {
      result.set({ success: false, error: "newTitle parameter is required" });
    }
    return;
  }
  title.set(newTitle);
  if (result) result.set({ success: true, title: newTitle });
});

// List available module types that can be added
const handleListModuleTypes = handler<
  { result?: Cell<unknown> },
  Record<string, never>
>(({ result }) => {
  const types = getAddableTypes().map((def) => ({
    type: def.type,
    label: def.label,
    icon: def.icon,
    allowMultiple: def.allowMultiple || false,
  }));
  if (result) result.set({ types });
});

// Create sibling module (same type, inserted after current)
// Used by '+' button in module headers for email/phone/address
const createSibling = handler<
  unknown,
  { subCharms: Cell<SubCharmEntry[]>; index: number }
>((_event, { subCharms: sc, index }) => {
  const current = sc.get() || [];
  const entry = current[index];
  if (!entry) return;

  // Get smart default label
  const nextLabel = getNextUnusedLabel(entry.type, current);
  const initialValues = nextLabel ? { label: nextLabel } : undefined;

  // Create new module of same type
  const charm = createSubCharm(entry.type, initialValues);

  // Insert after current position
  const updated = [...current];
  updated.splice(index + 1, 0, {
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
    // Simple index-based tracking - just stores which index is expanded
    const expandedIndex = Cell.of<number | undefined>();

    // Settings modal state - tracks which module's settings are being edited
    const settingsModuleIndex = Cell.of<number | undefined>();

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

    // Entry with index for rendering - preserves charm references (no spreading!)
    // isExpanded is pre-computed to avoid closure issues inside .map() callbacks
    // displayInfo is pre-computed to avoid calling getModuleDisplay inside .map() JSX
    type EntryWithIndex = {
      entry: SubCharmEntry;
      index: number;
      isExpanded: boolean;
      displayInfo: { icon: string; label: string };
      isPinned: boolean;
    };

    // Pre-compute entries with their indices AND expanded state for stable reference during render
    // IMPORTANT: We do NOT spread entry properties - that breaks charm rendering
    // IMPORTANT: isExpanded must be computed here, not inside .map() - closures over cells in .map() don't work correctly
    // IMPORTANT: displayInfo must be computed here to avoid calling lift inside .map() JSX
    const {
      pinnedEntries,
      unpinnedEntries,
      allEntries,
      pinnedCount,
      hasUnpinned,
      hasExpandedModule,
    } = lift(
      (
        { sc, expandedIdx }: {
          sc: SubCharmEntry[];
          expandedIdx: number | undefined;
        },
      ) => {
        const entries = (sc || []).map((entry, index) => {
          // Compute displayInfo inline (same logic as getModuleDisplay)
          const def = getDefinition(entry.type);
          // deno-lint-ignore no-explicit-any
          const charmLabel = (entry.charm as any)?.label;
          const displayInfo = {
            icon: def?.icon || "📋",
            label: charmLabel || def?.label || entry.type,
          };
          return {
            entry,
            index,
            isExpanded: expandedIdx === index,
            displayInfo,
            isPinned: entry.pinned || false,
          };
        });
        const pinned = entries.filter((item) => item.entry?.pinned);
        const unpinned = entries.filter((item) => !item.entry?.pinned);
        return {
          pinnedEntries: pinned,
          unpinnedEntries: unpinned,
          allEntries: entries,
          pinnedCount: pinned.length,
          hasUnpinned: unpinned.length > 0,
          hasExpandedModule: expandedIdx !== undefined,
        };
      },
    )({ sc: subCharms, expandedIdx: expandedIndex });

    // Check if there are any module types available to add
    // (always true unless registry is empty - multiple of same type allowed)
    const hasTypesToAdd = getAddableTypes().length > 0;

    // Extract just the module types - only recomputes when types change
    const moduleTypes = lift((
      { sc }: { sc: SubCharmEntry[] },
    ) => [...new Set((sc || []).map((e) => e?.type).filter(Boolean))])({
      sc: subCharms,
    });

    // Build dropdown items from registry, separating new types from existing ones
    // Now only recomputes when moduleTypes changes (not every subCharms change)
    const addSelectItems = lift(({ types }: { types: string[] }) => {
      const existingTypes = new Set(types);
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
    })({ types: moduleTypes });

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

    // Pre-compute trashed entries with displayInfo to avoid calling getModuleDisplay in .map() JSX
    type TrashedEntryWithDisplay = {
      entry: TrashedSubCharmEntry;
      trashIndex: number;
      displayInfo: { icon: string; label: string };
    };
    const trashedEntriesWithDisplay = lift(
      ({ t }: { t: TrashedSubCharmEntry[] }) => {
        return (t || []).map((entry, trashIndex) => {
          // Compute displayInfo inline (same logic as getModuleDisplay)
          const def = getDefinition(entry.type);
          // deno-lint-ignore no-explicit-any
          const charmLabel = (entry.charm as any)?.label;
          const displayInfo = {
            icon: def?.icon || "📋",
            label: charmLabel || def?.label || entry.type,
          };
          return { entry, trashIndex, displayInfo };
        });
      },
    )({ t: trashedSubCharms });

    // Compute trash count directly
    const trashCount = lift(({ t }: { t: TrashedSubCharmEntry[] }) =>
      (t || []).length
    )({ t: trashedSubCharms });

    // Check if there are any trashed items
    const hasTrash = lift(({ t }: { t: TrashedSubCharmEntry[] }) =>
      (t || []).length > 0
    )({ t: trashedSubCharms });

    // ===== Settings Modal Computed Values =====

    // Get the settings UI for the currently selected module (if any)
    const currentSettingsUI = lift(
      ({
        idx,
        sc,
      }: {
        idx: number | undefined;
        sc: SubCharmEntry[];
      }) => {
        if (idx === undefined) return null;
        const entry = sc?.[idx];
        if (!entry) return null;
        // Access settingsUI from the charm output
        // deno-lint-ignore no-explicit-any
        return (entry.charm as any)?.settingsUI || null;
      },
    )({ idx: settingsModuleIndex, sc: subCharms });

    // Get display info for the module whose settings are open
    const settingsModuleDisplay = lift(
      ({
        idx,
        sc,
      }: {
        idx: number | undefined;
        sc: SubCharmEntry[];
      }) => {
        if (idx === undefined) return { icon: "", label: "Settings" };
        const entry = sc?.[idx];
        if (!entry) return { icon: "", label: "Settings" };
        const def = getDefinition(entry.type);
        // deno-lint-ignore no-explicit-any
        const charmLabel = (entry.charm as any)?.label;
        return {
          icon: def?.icon || "📋",
          label: charmLabel || def?.label || entry.type,
        };
      },
    )({ idx: settingsModuleIndex, sc: subCharms });

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
                  title,
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
                  {pinnedEntries.map(
                    ({ entry, index, isExpanded, displayInfo, isPinned }) => {
                      return (
                        <div
                          style={isExpanded
                            ? {
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
                              boxShadow:
                                "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                              overflow: "hidden",
                              display: "flex",
                              flexDirection: "column",
                            }
                            : {
                              background: "white",
                              borderRadius: "8px",
                              border: "1px solid #e5e7eb",
                              overflow: "hidden",
                            }}
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
                                onClick={toggleCollapsed({ subCharms, index })}
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
                                      index,
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
                                {/* Hide note/settings/pin/remove buttons when maximized - only show close button */}
                                {!isExpanded && (
                                  <button
                                    type="button"
                                    onClick={openNoteEditor({
                                      subCharms,
                                      editingNoteIndex,
                                      editingNoteText,
                                      index,
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
                                )}
                                {/* Settings gear - only show if module has settingsUI */}
                                {!isExpanded &&
                                  ifElse(
                                    moduleHasSettings({ charm: entry.charm }),
                                    <button
                                      type="button"
                                      onClick={openSettings({
                                        settingsModuleIndex,
                                        index,
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
                                      title="Settings"
                                    >
                                      ⚙️
                                    </button>,
                                    null,
                                  )}
                                {!isExpanded && (
                                  <button
                                    type="button"
                                    onClick={togglePin({ subCharms, index })}
                                    style={{
                                      background: isPinned
                                        ? "#e0f2fe"
                                        : "transparent",
                                      border: isPinned
                                        ? "1px solid #7dd3fc"
                                        : "1px solid #e5e7eb",
                                      borderRadius: "4px",
                                      cursor: "pointer",
                                      padding: "4px 8px",
                                      fontSize: "12px",
                                      color: isPinned ? "#0369a1" : "#6b7280",
                                    }}
                                    title={isPinned ? "Unpin" : "Pin"}
                                  >
                                    📌
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={toggleExpanded({
                                    expandedIndex,
                                    index,
                                  })}
                                  style={{
                                    background: isExpanded
                                      ? "#3b82f6"
                                      : "transparent",
                                    border: isExpanded
                                      ? "1px solid #3b82f6"
                                      : "1px solid #e5e7eb",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    color: isExpanded ? "white" : "#6b7280",
                                  }}
                                  title={isExpanded ? "Close" : "Maximize"}
                                >
                                  {isExpanded ? "✕" : "⛶"}
                                </button>
                                {!isExpanded && (
                                  <button
                                    type="button"
                                    onClick={trashSubCharm({
                                      subCharms,
                                      trashedSubCharms,
                                      expandedIndex,
                                      settingsModuleIndex,
                                      index,
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
                                )}
                              </div>,
                              null,
                            )}
                          </div>
                          {ifElse(
                            computed(() => !entry.collapsed),
                            <div
                              style={{
                                padding: isExpanded ? "16px" : "12px",
                                // When expanded, fill the fixed container
                                flex: isExpanded ? "1" : "none",
                                overflow: isExpanded ? "auto" : "hidden",
                                minHeight: isExpanded ? "0" : "auto",
                              }}
                            >
                              <ct-render
                                $cell={entry.charm}
                                variant={getDefinition(entry.type)
                                    ?.hasEmbeddedUI
                                  ? "embedded"
                                  : undefined}
                              />
                            </div>,
                            null,
                          )}
                        </div>
                      );
                    },
                  )}
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
                    {unpinnedEntries.map(
                      ({ entry, index, isExpanded, displayInfo, isPinned }) => {
                        return (
                          <div
                            style={isExpanded
                              ? {
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
                                boxShadow:
                                  "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                                overflow: "hidden",
                                display: "flex",
                                flexDirection: "column",
                              }
                              : {
                                background: "white",
                                borderRadius: "8px",
                                border: "1px solid #e5e7eb",
                                overflow: "hidden",
                              }}
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
                                  onClick={toggleCollapsed({
                                    subCharms,
                                    index,
                                  })}
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
                                        index,
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
                                  {/* Hide note/settings/pin/remove buttons when maximized - only show close button */}
                                  {!isExpanded && (
                                    <button
                                      type="button"
                                      onClick={openNoteEditor({
                                        subCharms,
                                        editingNoteIndex,
                                        editingNoteText,
                                        index,
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
                                  )}
                                  {/* Settings gear - only show if module has settingsUI */}
                                  {!isExpanded &&
                                    ifElse(
                                      moduleHasSettings({ charm: entry.charm }),
                                      <button
                                        type="button"
                                        onClick={openSettings({
                                          settingsModuleIndex,
                                          index,
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
                                        title="Settings"
                                      >
                                        ⚙️
                                      </button>,
                                      null,
                                    )}
                                  {!isExpanded && (
                                    <button
                                      type="button"
                                      onClick={togglePin({ subCharms, index })}
                                      style={{
                                        background: isPinned
                                          ? "#e0f2fe"
                                          : "transparent",
                                        border: isPinned
                                          ? "1px solid #7dd3fc"
                                          : "1px solid #e5e7eb",
                                        borderRadius: "4px",
                                        cursor: "pointer",
                                        padding: "4px 8px",
                                        fontSize: "12px",
                                        color: isPinned ? "#0369a1" : "#6b7280",
                                      }}
                                      title={isPinned ? "Unpin" : "Pin"}
                                    >
                                      📌
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={toggleExpanded({
                                      expandedIndex,
                                      index,
                                    })}
                                    style={{
                                      background: isExpanded
                                        ? "#3b82f6"
                                        : "transparent",
                                      border: isExpanded
                                        ? "1px solid #3b82f6"
                                        : "1px solid #e5e7eb",
                                      borderRadius: "4px",
                                      cursor: "pointer",
                                      padding: "4px 8px",
                                      fontSize: "12px",
                                      color: isExpanded ? "white" : "#6b7280",
                                    }}
                                    title={isExpanded ? "Close" : "Maximize"}
                                  >
                                    {isExpanded ? "✕" : "⛶"}
                                  </button>
                                  {!isExpanded && (
                                    <button
                                      type="button"
                                      onClick={trashSubCharm({
                                        subCharms,
                                        trashedSubCharms,
                                        expandedIndex,
                                        settingsModuleIndex,
                                        index,
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
                                  )}
                                </div>,
                                null,
                              )}
                            </div>
                            {ifElse(
                              computed(() => !entry.collapsed),
                              <div
                                style={{
                                  padding: isExpanded ? "16px" : "12px",
                                  // When expanded, fill the fixed container
                                  flex: isExpanded ? "1" : "none",
                                  overflow: isExpanded ? "auto" : "hidden",
                                  minHeight: isExpanded ? "0" : "auto",
                                }}
                              >
                                <ct-render
                                  $cell={entry.charm}
                                  variant={getDefinition(entry.type)
                                      ?.hasEmbeddedUI
                                    ? "embedded"
                                    : undefined}
                                />
                              </div>,
                              null,
                            )}
                          </div>
                        );
                      },
                    )}
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
                {allEntries.map(
                  ({ entry, index, isExpanded, displayInfo, isPinned }) => {
                    return (
                      <div
                        style={isExpanded
                          ? {
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
                          }
                          : {
                            background: "white",
                            borderRadius: "8px",
                            border: "1px solid #e5e7eb",
                            overflow: "hidden",
                          }}
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
                              onClick={toggleCollapsed({ subCharms, index })}
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
                                  onClick={createSibling({ subCharms, index })}
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
                              {/* Hide note/settings/pin/remove buttons when maximized - only show close button */}
                              {!isExpanded && (
                                <button
                                  type="button"
                                  onClick={openNoteEditor({
                                    subCharms,
                                    editingNoteIndex,
                                    editingNoteText,
                                    index,
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
                              )}
                              {/* Settings gear - only show if module has settingsUI */}
                              {!isExpanded &&
                                ifElse(
                                  moduleHasSettings({ charm: entry.charm }),
                                  <button
                                    type="button"
                                    onClick={openSettings({
                                      settingsModuleIndex,
                                      index,
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
                                    title="Settings"
                                  >
                                    ⚙️
                                  </button>,
                                  null,
                                )}
                              {!isExpanded && (
                                <button
                                  type="button"
                                  onClick={togglePin({ subCharms, index })}
                                  style={{
                                    background: isPinned
                                      ? "#e0f2fe"
                                      : "transparent",
                                    border: isPinned
                                      ? "1px solid #7dd3fc"
                                      : "1px solid #e5e7eb",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    color: isPinned ? "#0369a1" : "#6b7280",
                                  }}
                                  title={isPinned ? "Unpin" : "Pin"}
                                >
                                  📌
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={toggleExpanded({
                                  expandedIndex,
                                  index,
                                })}
                                style={{
                                  background: isExpanded
                                    ? "#3b82f6"
                                    : "transparent",
                                  border: isExpanded
                                    ? "1px solid #3b82f6"
                                    : "1px solid #e5e7eb",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                  padding: "4px 8px",
                                  fontSize: "12px",
                                  color: isExpanded ? "white" : "#6b7280",
                                }}
                                title={isExpanded ? "Close" : "Maximize"}
                              >
                                {isExpanded ? "✕" : "⛶"}
                              </button>
                              {!isExpanded && (
                                <button
                                  type="button"
                                  onClick={trashSubCharm({
                                    subCharms,
                                    trashedSubCharms,
                                    expandedIndex,
                                    settingsModuleIndex,
                                    index,
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
                              )}
                            </div>,
                            null,
                          )}
                        </div>
                        {ifElse(
                          computed(() => !entry.collapsed),
                          <div
                            style={{
                              padding: isExpanded ? "16px" : "12px",
                              // When expanded, fill the fixed container
                              flex: isExpanded ? "1" : "none",
                              overflow: isExpanded ? "auto" : "hidden",
                              minHeight: isExpanded ? "0" : "auto",
                            }}
                          >
                            <ct-render
                              $cell={entry.charm}
                              variant={getDefinition(entry.type)?.hasEmbeddedUI
                                ? "embedded"
                                : undefined}
                            />
                          </div>,
                          null,
                        )}
                      </div>
                    );
                  },
                )}
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
                    {trashedEntriesWithDisplay.map(
                      ({ trashIndex, displayInfo }) => {
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
                                  trashIndex,
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
                                  trashIndex,
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

          {/* Note Editor Modal */}
          <ct-modal
            $open={computed(() => editingNoteIndex.get() !== undefined)}
            dismissable
            size="md"
            onct-modal-close={closeNoteEditor({
              editingNoteIndex,
              editingNoteText,
            })}
          >
            <span slot="header">Module Note</span>
            <ct-textarea
              $value={editingNoteText}
              placeholder="Add notes about this module... (visible to LLM reads)"
              rows={6}
              style={{ width: "100%", resize: "vertical" }}
            />
            {/* Keyboard shortcut for save (Cmd/Ctrl+Enter) */}
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
            <ct-hstack
              slot="footer"
              gap="3"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={closeNoteEditor({
                  editingNoteIndex,
                  editingNoteText,
                })}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="primary"
                onClick={saveNote({
                  subCharms,
                  editingNoteIndex,
                  editingNoteText,
                })}
              >
                Save Note
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* Settings Modal */}
          <ct-modal
            $open={computed(() => settingsModuleIndex.get() !== undefined)}
            dismissable
            size="md"
            onct-modal-close={closeSettings({ settingsModuleIndex })}
          >
            <span slot="header">
              {settingsModuleDisplay.icon} {settingsModuleDisplay.label}{" "}
              Settings
            </span>
            {currentSettingsUI}
            <ct-hstack
              slot="footer"
              gap="3"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="primary"
                onClick={closeSettings({ settingsModuleIndex })}
              >
                Done
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* Expanded (Maximize) Module Overlay - backdrop + escape handler */}
          {ifElse(
            hasExpandedModule,
            <div>
              {/* Backdrop with blur - clicking closes */}
              <div
                onClick={closeExpanded({ expandedIndex })}
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
                onct-keybind={closeExpanded({ expandedIndex })}
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
      // LLM-callable streams for Omnibot integration
      // Omnibot can invoke these via: invoke({ "@link": "/of:record-id/getSummary" }, {})
      getSummary: handleGetSummary({ title, subCharms }),
      addModule: handleAddModule({ subCharms, trashedSubCharms, title }),
      updateModule: handleUpdateModule({ subCharms }),
      removeModule: handleRemoveModule({ subCharms, trashedSubCharms }),
      setTitle: handleSetTitle({ title }),
      listModuleTypes: handleListModuleTypes({}),
    };
  },
);

export default Record;
