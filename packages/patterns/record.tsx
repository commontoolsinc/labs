/// <cts-enable />
/**
 * Record Pattern v2 - True Sub-Piece Architecture
 *
 * A data-up meta-container where each module is its own sub-piece pattern.
 * This enables:
 * - Adding new module types without code changes to Record
 * - User-defined custom modules (future)
 * - Modules that can exist independently
 * - @-reference specific modules by piece ID
 *
 * #record
 */

import {
  computed,
  type Default,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  SELF,
  str,
  toSchema,
  UI,
  Writable,
} from "commontools";
import {
  createSubPiece,
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
import type { SubPieceEntry, TrashedSubPieceEntry } from "./record/types.ts";

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
  existingPieces: readonly SubPieceEntry[],
): string | undefined {
  const standards = STANDARD_LABELS[type];
  if (!standards || standards.length === 0) return undefined;

  // Collect labels already used by modules of this type
  const usedLabels = new Set<string>();
  for (const entry of existingPieces) {
    if (entry.type === type) {
      try {
        // Access the label field from the piece pattern output
        // Property access is reactive - framework handles Cell unwrapping
        // deno-lint-ignore no-explicit-any
        const piece = entry.piece as any;
        const labelValue = piece?.label;
        if (typeof labelValue === "string" && labelValue) {
          usedLabels.add(labelValue);
        }
      } catch {
        // Ignore errors from pieces without label field
      }
    }
  }

  // Return first unused standard label (or undefined if all used)
  return standards.find((label) => !usedLabels.has(label));
}

// ===== Types =====

interface RecordInput {
  title?: Default<string, "">;
  subPieces?: Default<SubPieceEntry[], []>;
  trashedSubPieces?: Default<TrashedSubPieceEntry[], []>;
}

interface RecordOutput {
  title?: Default<string, "">;
  subPieces?: Default<SubPieceEntry[], []>;
  trashedSubPieces?: Default<TrashedSubPieceEntry[], []>;
  /** Self-reference for sub-pieces to access their parent Record */
  parentRecord?: RecordOutput | null;
}

// ===== Auto-Initialize Notes + TypePicker (Two-Lift Pattern) =====
// Based on chatbot-list-view.tsx pattern:
// - Outer lift creates the pieces and calls inner lift
// - Inner lift receives pieces as input and stores them
// This works because the inner lift provides proper cause context
//
// TypePicker is a "controller module" - it receives parent Cells as input
// so it can modify the parent's subPieces list when a template is selected.

// Inner lift: stores the initial pieces (receives pieces as input)
const storeInitialPieces = lift(
  toSchema<{
    notesPiece: unknown;
    notesSchema: unknown;
    typePickerPiece: unknown;
    typePickerSchema: unknown;
    subPieces: Writable<SubPieceEntry[]>;
    isInitialized: Writable<boolean>;
  }>(),
  undefined,
  ({
    notesPiece,
    notesSchema,
    typePickerPiece,
    typePickerSchema,
    subPieces,
    isInitialized,
  }) => {
    if (!isInitialized.get()) {
      subPieces.set([
        { type: "notes", pinned: true, piece: notesPiece, schema: notesSchema },
        {
          type: "type-picker",
          pinned: false,
          piece: typePickerPiece,
          schema: typePickerSchema,
        },
      ]);
      isInitialized.set(true);
      return notesPiece; // Return notes piece as primary reference
    }
  },
);

// Outer lift: checks if empty, creates pieces, calls inner lift
// TypePicker uses ContainerCoordinationContext protocol for parent access
// Note: We receive recordPatternJson as input to avoid capturing Record before it's defined
const initializeRecord = lift(
  toSchema<{
    currentPieces: SubPieceEntry[]; // Unwrapped value, not Cell
    subPieces: Writable<SubPieceEntry[]>;
    trashedSubPieces: Writable<TrashedSubPieceEntry[]>;
    isInitialized: Writable<boolean>;
    recordPatternJson: string; // Computed that returns Record JSON string
  }>(),
  undefined,
  (
    {
      currentPieces,
      subPieces,
      trashedSubPieces,
      isInitialized,
      recordPatternJson,
    },
  ) => {
    if ((currentPieces || []).length === 0) {
      // Create Note as default module (rendered via ct-render variant="embedded")
      // Pass recordPatternJson so [[wiki-links]] create Record pieces instead of Note pieces
      const notesPiece = Note({ linkPattern: recordPatternJson });

      // Capture schema for dynamic discovery
      const notesSchema = getResultSchema(notesPiece);

      // TypePicker receives Cells as top-level props (CTS handles serialization correctly)
      // NOTE: Cells must be top-level, not nested in a context object!
      // deno-lint-ignore no-explicit-any
      const typePickerPiece = TypePickerModule({
        entries: subPieces,
        trashedEntries: trashedSubPieces,
        linkPatternJson: recordPatternJson,
      } as any);

      // Capture schema for dynamic discovery
      const typePickerSchema = getResultSchema(typePickerPiece);

      return storeInitialPieces({
        notesPiece,
        notesSchema,
        typePickerPiece,
        typePickerSchema,
        subPieces,
        isInitialized,
      });
    }
  },
);

// Helper to check if a module has settings UI
const moduleHasSettings = lift(
  // deno-lint-ignore no-explicit-any
  ({ piece }: { piece?: any }) => {
    // Check if the piece exports a settingsUI
    return !!piece?.settingsUI;
  },
);

// ===== Module-Scope Handlers (avoid closures, use references not indices) =====

// Toggle pin state for a sub-piece - uses entry reference, not index
const togglePin = handler<
  unknown,
  { subPieces: Writable<SubPieceEntry[]>; index: number }
>((_event, { subPieces: sc, index }) => {
  const current = sc.get() || [];
  const entry = current[index];
  if (!entry) return;

  const updated = [...current];
  updated[index] = { ...entry, pinned: !entry.pinned };
  sc.set(updated);
});

// Toggle collapsed state for a sub-piece - uses index for reliable lookup
const toggleCollapsed = handler<
  unknown,
  { subPieces: Writable<SubPieceEntry[]>; index: number }
>((_event, { subPieces: sc, index }) => {
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
  { expandedIndex: Writable<number | undefined>; index: number }
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
  { expandedIndex: Writable<number | undefined> }
>((_event, { expandedIndex }) => {
  expandedIndex.set(undefined);
});

// Add a new sub-piece
// Note: Receives recordPatternJson to create Notes with correct wiki-link target
// Note: Controller modules (extractor) also receive parent Cells and title
const addSubPiece = handler<
  { detail: { value: string } },
  {
    subPieces: Writable<SubPieceEntry[]>;
    trashedSubPieces: Writable<TrashedSubPieceEntry[]>;
    title: Writable<string>;
    selectedAddType: Writable<string>;
    recordPatternJson: string;
  }
>((
  { detail },
  {
    subPieces: sc,
    trashedSubPieces: trash,
    title,
    selectedAddType: sat,
    recordPatternJson,
  },
) => {
  const type = detail?.value;
  if (!type) return;

  // Create the sub-piece and add it (multiple modules of same type allowed)
  const current = sc.get() || [];

  // Get smart default label for modules that support it
  const nextLabel = getNextUnusedLabel(type, current);
  const initialValues = nextLabel ? { label: nextLabel } : undefined;

  // Special case: create Note (rendered via ct-render variant="embedded")
  // Pass recordPatternJson so [[wiki-links]] create Record pieces instead of Note pieces
  // Special case: create ExtractorModule as controller with parent Cells and title
  const piece = type === "notes"
    ? Note({ linkPattern: recordPatternJson })
    : type === "extractor"
    ? ExtractorModule({
      parentSubPieces: sc,
      parentTrashedSubPieces: trash,
      parentTitle: title,
    } as any)
    : createSubPiece(type, initialValues);

  // Capture schema at creation time for dynamic discovery
  const schema = getResultSchema(piece);
  sc.set([...current, {
    type,
    pinned: false,
    collapsed: false,
    piece,
    schema,
  }]);
  sat.set("");
});

// Move sub-piece to trash (soft delete) - uses Cell.push() and Cell.remove()
// Also adjusts expandedIndex to prevent stale index pointing to wrong module
const trashSubPiece = handler<
  unknown,
  {
    subPieces: Writable<SubPieceEntry[]>;
    trashedSubPieces: Writable<TrashedSubPieceEntry[]>;
    expandedIndex: Writable<number | undefined>;
    settingsModuleIndex: Writable<number | undefined>;
    index: number;
  }
>((
  _event,
  {
    subPieces: sc,
    trashedSubPieces: trash,
    expandedIndex,
    settingsModuleIndex,
    index,
  },
) => {
  const current = sc.get() || [];
  const entry = current[index];
  if (!entry) return;

  // Move to trash with timestamp
  trash.push({ ...entry, trashedAt: Temporal.Now.instant().toString() });

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

// Restore sub-piece from trash - uses index for reliable lookup
const restoreSubPiece = handler<
  unknown,
  {
    subPieces: Writable<SubPieceEntry[]>;
    trashedSubPieces: Writable<TrashedSubPieceEntry[]>;
    trashIndex: number;
  }
>((_event, { subPieces: sc, trashedSubPieces: trash, trashIndex }) => {
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
    trashedSubPieces: Writable<TrashedSubPieceEntry[]>;
    trashIndex: number;
  }
>((_event, { trashedSubPieces: trash, trashIndex }) => {
  const current = trash.get() || [];
  if (trashIndex < 0 || trashIndex >= current.length) return;

  const updated = [...current];
  updated.splice(trashIndex, 1);
  trash.set(updated);
});

// Empty all trash
const emptyTrash = handler<
  unknown,
  { trashedSubPieces: Writable<TrashedSubPieceEntry[]> }
>((_event, { trashedSubPieces: trash }) => {
  trash.set([]);
});

// Open the note editor modal for a module
const openNoteEditor = handler<
  unknown,
  {
    subPieces: Writable<SubPieceEntry[]>;
    editingNoteIndex: Writable<number | undefined>;
    editingNoteText: Writable<string | undefined>;
    index: number;
  }
>((_event, { subPieces, editingNoteIndex, editingNoteText, index }) => {
  const current = subPieces.get() || [];
  const entry = current[index];
  if (!entry) return;
  editingNoteIndex.set(index);
  editingNoteText.set(entry.note || "");
});

// Save the note and close the modal
const saveNote = handler<
  unknown,
  {
    subPieces: Writable<SubPieceEntry[]>;
    editingNoteIndex: Writable<number | undefined>;
    editingNoteText: Writable<string | undefined>;
  }
>((_event, { subPieces: sc, editingNoteIndex, editingNoteText }) => {
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
  { reason: string },
  {
    editingNoteIndex: Writable<number | undefined>;
    editingNoteText: Writable<string | undefined>;
  }
>((_event, { editingNoteIndex, editingNoteText }) => {
  editingNoteIndex.set(undefined);
  editingNoteText.set(undefined);
});

// Open the settings modal for a module
const openSettings = handler<
  unknown,
  {
    settingsModuleIndex: Writable<number | undefined>;
    index: number;
  }
>((_event, { settingsModuleIndex, index }) => {
  settingsModuleIndex.set(index);
});

// Close the settings modal
const closeSettings = handler<
  { reason: string },
  { settingsModuleIndex: Writable<number | undefined> }
>((_event, { settingsModuleIndex }) => {
  settingsModuleIndex.set(undefined);
});

// Toggle trash section expanded/collapsed
const toggleTrashExpanded = handler<unknown, { expanded: Writable<boolean> }>(
  (_event, { expanded }) => expanded.set(!expanded.get()),
);

// ===== LLM-Callable Handlers for Omnibot Integration =====
// These handlers are exposed in the pattern output for Omnibot's invoke() tool
// IMPORTANT: Handlers must use result.set() to return data to the LLM.
// The 'result' Cell is injected by llm-dialog.ts invoke() - return statements are ignored!

// Get a structured summary of all modules in this record
// Returns module types, their data, and schemas for LLM context
const handleGetSummary = handler<
  { result?: Writable<unknown> },
  {
    title: Writable<string>;
    subPieces: Writable<SubPieceEntry[]>;
  }
>(({ result }, { title, subPieces }) => {
  const modules = subPieces.get() || [];
  const summary = {
    title: title.get() || "(Untitled Record)",
    moduleCount: modules.length,
    modules: modules.map((entry, index) => {
      const def = getDefinition(entry.type);
      // Extract data from piece - access common fields reactively
      // deno-lint-ignore no-explicit-any
      const piece = entry.piece as any;
      const moduleData: Record<string, unknown> = {};

      // Try to extract common fields based on module type
      try {
        // Most modules have a primary value field
        if (piece?.label !== undefined) moduleData.label = piece.label;
        if (piece?.value !== undefined) moduleData.value = piece.value;
        if (piece?.content !== undefined) moduleData.content = piece.content;
        if (piece?.address !== undefined) moduleData.address = piece.address;
        if (piece?.email !== undefined) moduleData.email = piece.email;
        if (piece?.phone !== undefined) moduleData.phone = piece.phone;
        if (piece?.rating !== undefined) moduleData.rating = piece.rating;
        if (piece?.tags !== undefined) moduleData.tags = piece.tags;
        if (piece?.status !== undefined) moduleData.status = piece.status;
        if (piece?.nickname !== undefined) moduleData.nickname = piece.nickname;
        if (piece?.icon !== undefined) moduleData.icon = piece.icon;
        if (piece?.birthDate !== undefined) {
          moduleData.birthDate = piece.birthDate;
        }
        if (piece?.birthYear !== undefined) {
          moduleData.birthYear = piece.birthYear;
        }
        if (piece?.url !== undefined) moduleData.url = piece.url;
        if (piece?.notes !== undefined) moduleData.notes = piece.notes;
        if (piece?.occurrences !== undefined) {
          moduleData.occurrences = piece.occurrences;
        }
      } catch {
        // Ignore errors from pieces without expected fields
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
    result?: Writable<unknown>;
  },
  {
    subPieces: Writable<SubPieceEntry[]>;
    trashedSubPieces: Writable<TrashedSubPieceEntry[]>;
    title: Writable<string>;
  }
>((
  { type, initialData, result },
  { subPieces: sc, trashedSubPieces: trash, title },
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
  let piece: unknown;
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
    piece = ExtractorModule({
      parentSubPieces: sc,
      parentTrashedSubPieces: trash,
      parentTitle: title,
      // deno-lint-ignore no-explicit-any
    } as any);
  } else {
    piece = createSubPiece(type, initialValues);
  }

  // Capture schema at creation time
  const schema = getResultSchema(piece);

  sc.push({
    type,
    pinned: false,
    collapsed: false,
    piece,
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
// index: module index in subPieces array
// field: field name to update
// value: new value
const handleUpdateModule = handler<
  { index: number; field: string; value: unknown; result?: Writable<unknown> },
  { subPieces: Writable<SubPieceEntry[]> }
>(({ index, field, value, result }, { subPieces: sc }) => {
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
  const piece = entry.piece as any;

  if (!piece) {
    if (result) result.set({ success: false, error: "Module piece not found" });
    return;
  }

  try {
    // Try to access the field as a Cell and set it
    const fieldCell = piece[field];
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
  { index: number; result?: Writable<unknown> },
  {
    subPieces: Writable<SubPieceEntry[]>;
    trashedSubPieces: Writable<TrashedSubPieceEntry[]>;
  }
>(({ index, result }, { subPieces: sc, trashedSubPieces: trash }) => {
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
  trash.push({ ...entry, trashedAt: Temporal.Now.instant().toString() });

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
  { newTitle: string; result?: Writable<unknown> },
  { title: Writable<string> }
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
  { result?: Writable<unknown> },
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
  { subPieces: Writable<SubPieceEntry[]>; index: number }
>((_event, { subPieces: sc, index }) => {
  const current = sc.get() || [];
  const entry = current[index];
  if (!entry) return;

  // Get smart default label
  const nextLabel = getNextUnusedLabel(entry.type, current);
  const initialValues = nextLabel ? { label: nextLabel } : undefined;

  // Create new module of same type
  const piece = createSubPiece(entry.type, initialValues);

  // Insert after current position
  const updated = [...current];
  updated.splice(index + 1, 0, {
    type: entry.type,
    pinned: false,
    collapsed: false,
    piece,
  });
  sc.set(updated);
});

// ===== Module-scope helper function =====
// Plain helper to get display info - NOT a lift function
// This is called inside computed() blocks after values are accessed
function getDisplayInfo(
  type: string,
  pieceLabel?: string,
): { icon: string; label: string; allowMultiple: boolean } {
  const def = getDefinition(type);
  return {
    icon: def?.icon || "📋",
    label: pieceLabel || def?.label || type,
    allowMultiple: def?.allowMultiple || false,
  };
}

// ===== The Record Pattern =====
const Record = pattern<RecordInput, RecordOutput>(
  ({ title, subPieces, trashedSubPieces, [SELF]: self }) => {
    // Local state
    const selectedAddType = Writable.of<string>("");
    const trashExpanded = Writable.of(false);

    // Note editor modal state
    // NOTE: In the future, this should use a <ct-modal> component instead of inline implementation.
    // A ct-modal component would follow the ct-fab pattern:
    //   <ct-modal $open={isOpen} onct-modal-close={handleClose}>
    //     <content />
    //   </ct-modal>
    // With features: backdrop blur, escape key, focus trap, centered positioning, animations
    // IMPORTANT: Don't use Writable.of(null) - it creates a cell pointing to null, not primitive null.
    // Use Writable.of() without argument so .get() returns undefined (falsy) initially.
    // We store the INDEX instead of the entry to decouple modal state from array updates.
    const editingNoteIndex = Writable.of<number | undefined>();
    const editingNoteText = Writable.of<string>();

    // Expanded (maximized) module state - ephemeral, not persisted
    // Simple index-based tracking - just stores which index is expanded
    const expandedIndex = Writable.of<number | undefined>();

    // Settings modal state - tracks which module's settings are being edited
    const settingsModuleIndex = Writable.of<number | undefined>();

    // Create Record pattern JSON for wiki-links in Notes
    // Using computed() defers evaluation until render time, avoiding circular dependency
    const recordPatternJson = computed(() => JSON.stringify(Record));

    // ===== Auto-initialize Notes + TypePicker =====
    // Capture return value to force lift execution (fixes wiki-link creation)
    const isInitialized = Writable.of(false);
    const _initialized = initializeRecord({
      currentPieces: subPieces,
      subPieces,
      trashedSubPieces,
      isInitialized,
      recordPatternJson,
    });

    // ===== Computed Values =====

    // Display name with fallback
    const displayName = computed(() => title?.trim() || "(Untitled Record)");

    // Entry with index for rendering - preserves piece references (no spreading!)
    // isExpanded is pre-computed to avoid closure issues inside .map() callbacks
    // displayInfo is computed using module-scope lift() that properly unwraps Cell values
    type EntryWithIndex = {
      entry: SubPieceEntry;
      index: number;
      isExpanded: boolean;
      displayInfo: { icon: string; label: string; allowMultiple: boolean };
      isPinned: boolean;
      allowMultiple: boolean;
    };

    // Pre-compute entries with their indices AND expanded state for stable reference during render
    // IMPORTANT: We do NOT spread entry properties - that breaks piece rendering
    // IMPORTANT: isExpanded must be computed here, not inside .map() - closures over cells in .map() don't work correctly
    // IMPORTANT: displayInfo uses getDisplayInfo (plain helper) - this works because
    //   computed() transforms .map() callbacks to properly unwrap reactive values
    const allEntriesWithIndex = computed(() => {
      const expandedIdx = expandedIndex.get();
      // Note: Don't use fallback (|| []) as it breaks CTS transformer's mapWithPattern
      // subPieces is guaranteed to be an array by the Default type
      return subPieces.map((entry, index) => {
        // Get display info using plain helper function
        // This works because CTS transforms .map() to properly unwrap reactive values
        const displayInfo = getDisplayInfo(
          entry.type,
          // deno-lint-ignore no-explicit-any
          (entry.piece as any)?.label,
        );
        return {
          entry,
          index,
          isExpanded: expandedIdx === index,
          displayInfo,
          isPinned: entry.pinned || false,
          allowMultiple: displayInfo.allowMultiple,
        };
      });
    });

    // Separate pinned from unpinned entries
    const pinnedEntries = computed(() =>
      allEntriesWithIndex.filter((item) => item.entry?.pinned)
    );
    const unpinnedEntries = computed(() =>
      allEntriesWithIndex.filter((item) => !item.entry?.pinned)
    );
    const pinnedCount = computed(() => pinnedEntries.length);
    const hasUnpinned = computed(() => unpinnedEntries.length > 0);
    const hasExpandedModule = computed(() => expandedIndex.get() !== undefined);
    const allEntries = allEntriesWithIndex;

    // Check if there are any module types available to add
    // (always true unless registry is empty - multiple of same type allowed)
    const hasTypesToAdd = getAddableTypes().length > 0;

    // Build dropdown items from registry, separating new types from existing ones
    // Note: Don't use fallback (|| []) as it breaks CTS transformer's mapWithPattern
    const addSelectItems = computed(() => {
      const types = [...new Set(subPieces.map((e) => e?.type).filter(Boolean))];
      const existingTypes = new Set<string>(types);
      const allTypes = getAddableTypes();

      const newTypes = allTypes.filter((def) =>
        !existingTypes.has(String(def.type))
      );
      const existingTypesDefs = allTypes.filter((def) =>
        existingTypes.has(String(def.type))
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
    });

    // Infer record type from modules (data-up philosophy)
    const inferredType = computed(() => {
      const types = subPieces.map((e) => e?.type).filter(Boolean) as string[];
      return inferTypeFromModules(types);
    });

    // Check for manual icon override from record-icon module
    // Note: Don't use fallback (|| []) as it breaks CTS transformer's method replacement
    const manualIcon = computed(() => {
      const iconModule = subPieces.find((e) => e?.type === "record-icon");
      if (!iconModule) return null;
      // deno-lint-ignore no-explicit-any
      const iconValue = (iconModule.piece as any)?.icon;
      if (!iconValue) return null;
      return typeof iconValue === "string" && iconValue.trim()
        ? iconValue.trim()
        : null;
    });

    // Extract icon: manual icon takes precedence over inferred type
    const recordIcon = computed(() => {
      const manual = manualIcon;
      const inferred = inferredType;
      return manual || inferred?.icon || "\u{1F4CB}";
    });

    // Extract nicknames from nickname modules for display in NAME
    // Note: Don't use fallback (|| []) as it breaks CTS transformer's method replacement
    const nicknamesList = computed(() => {
      const nicknameModules = subPieces.filter((e) => e?.type === "nickname");
      const nicknames: string[] = [];
      for (const mod of nicknameModules) {
        try {
          // deno-lint-ignore no-explicit-any
          const nicknameValue = (mod.piece as any)?.nickname;
          if (typeof nicknameValue === "string" && nicknameValue.trim()) {
            nicknames.push(nicknameValue.trim());
          }
        } catch {
          // Ignore errors
        }
      }
      return nicknames;
    });

    // Build display name with nickname alias if present
    const displayNameWithAlias = computed(() => {
      const name = displayName;
      const nicknames = nicknamesList;
      if (nicknames.length === 0) return name;
      // Show all nicknames as aliases (aka Liz, Beth, Lizzie)
      return `${name} (aka ${nicknames.join(", ")})`;
    });

    // ===== Trash Section Computed Values =====

    // Pre-compute trashed entries with displayInfo using getDisplayInfo helper
    // Note: Don't use fallback (|| []) as it breaks CTS transformer's mapWithPattern
    const trashedEntriesWithDisplay = computed(() => {
      return trashedSubPieces.map((entry, trashIndex) => {
        // Get display info using plain helper function
        const displayInfo = getDisplayInfo(
          entry.type,
          // deno-lint-ignore no-explicit-any
          (entry.piece as any)?.label,
        );
        return { entry, trashIndex, displayInfo };
      });
    });

    // Compute trash count directly
    const trashCount = computed(() => (trashedSubPieces || []).length);

    // Check if there are any trashed items
    const hasTrash = computed(() => (trashedSubPieces || []).length > 0);

    // ===== Settings Modal Computed Values =====

    // Get the settings UI for the currently selected module (if any)
    const currentSettingsUI = computed(() => {
      const idx = settingsModuleIndex.get();
      if (idx === undefined) return null;
      const entry = subPieces[idx];
      if (!entry) return null;
      // deno-lint-ignore no-explicit-any
      return (entry.piece as any)?.settingsUI || null;
    });

    // Get display info for the module whose settings are open
    const settingsModuleDisplay = computed(() => {
      const idx = settingsModuleIndex.get();
      if (idx === undefined) return { icon: "", label: "Settings" };
      const entry = subPieces[idx];
      if (!entry) return { icon: "", label: "Settings" };
      // Use plain helper function to get display info
      return getDisplayInfo(
        entry.type,
        // deno-lint-ignore no-explicit-any
        (entry.piece as any)?.label,
      );
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
                onct-change={addSubPiece({
                  subPieces,
                  trashedSubPieces,
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
                    (
                      {
                        entry,
                        index,
                        isExpanded,
                        displayInfo,
                        isPinned,
                        allowMultiple,
                      },
                    ) => {
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
                                onClick={toggleCollapsed({ subPieces, index })}
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
                                  allowMultiple,
                                  <button
                                    type="button"
                                    onClick={createSibling({
                                      subPieces,
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
                                      subPieces,
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
                                    moduleHasSettings({ piece: entry.piece }),
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
                                    onClick={togglePin({ subPieces, index })}
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
                                    onClick={trashSubPiece({
                                      subPieces,
                                      trashedSubPieces,
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
                              {computed(() => {
                                const piece = entry.piece as any;
                                // Use embeddedUI if available, otherwise fall back to ct-render for default [UI]
                                return piece?.embeddedUI ??
                                  <ct-render $cell={entry.piece} />;
                              })}
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
                      (
                        {
                          entry,
                          index,
                          isExpanded,
                          displayInfo,
                          isPinned,
                          allowMultiple,
                        },
                      ) => {
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
                                    subPieces,
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
                                    allowMultiple,
                                    <button
                                      type="button"
                                      onClick={createSibling({
                                        subPieces,
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
                                        subPieces,
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
                                      moduleHasSettings({ piece: entry.piece }),
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
                                      onClick={togglePin({ subPieces, index })}
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
                                      onClick={trashSubPiece({
                                        subPieces,
                                        trashedSubPieces,
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
                                {computed(() => {
                                  const piece = entry.piece as any;
                                  // Use embeddedUI if available, otherwise fall back to ct-render for default [UI]
                                  return piece?.embeddedUI ??
                                    <ct-render $cell={entry.piece} />;
                                })}
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
                  (
                    {
                      entry,
                      index,
                      isExpanded,
                      displayInfo,
                      isPinned,
                      allowMultiple,
                    },
                  ) => {
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
                              onClick={toggleCollapsed({ subPieces, index })}
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
                                allowMultiple,
                                <button
                                  type="button"
                                  onClick={createSibling({ subPieces, index })}
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
                                    subPieces,
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
                                  moduleHasSettings({ piece: entry.piece }),
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
                                  onClick={togglePin({ subPieces, index })}
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
                                  onClick={trashSubPiece({
                                    subPieces,
                                    trashedSubPieces,
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
                            {computed(() => {
                              const piece = entry.piece as any;
                              // Use embeddedUI if available, otherwise fall back to ct-render for default [UI]
                              return piece?.embeddedUI ??
                                <ct-render $cell={entry.piece} />;
                            })}
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
                                onClick={restoreSubPiece({
                                  subPieces,
                                  trashedSubPieces,
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
                                  trashedSubPieces,
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
                      onClick={emptyTrash({ trashedSubPieces })}
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
                subPieces,
                editingNoteIndex,
                editingNoteText,
              })}
            />
            <ct-keybind
              code="Enter"
              ctrl
              ignore-editable={false}
              onct-keybind={saveNote({
                subPieces,
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
                  subPieces,
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
      subPieces,
      trashedSubPieces,
      // Self-reference for sub-pieces to access their parent Record
      // Enables cleaner parent-child relationships than ContainerCoordinationContext
      parentRecord: self,
      "#record": true,
      // LLM-callable streams for Omnibot integration
      // Omnibot can invoke these via: invoke({ "@link": "/of:record-id/getSummary" }, {})
      getSummary: handleGetSummary({ title, subPieces }),
      addModule: handleAddModule({ subPieces, trashedSubPieces, title }),
      updateModule: handleUpdateModule({ subPieces }),
      removeModule: handleRemoveModule({ subPieces, trashedSubPieces }),
      setTitle: handleSetTitle({ title }),
      listModuleTypes: handleListModuleTypes({}),
    };
  },
);

export default Record;
