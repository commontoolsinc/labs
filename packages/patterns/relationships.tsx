/// <cts-enable />
/**
 * Relationships Module - Pattern for typed relationships between charms
 *
 * A composable pattern for Record that stores typed relationships to other charms
 * (people, organizations, families, etc.). Supports asymmetric relationships like
 * "member-of" / "has-member" with automatic inverse link creation.
 *
 * Example: Adding Person A as "member-of" Family B automatically creates
 * "has-member" A on Family B's relationships.
 */
import {
  Cell,
  computed,
  type Default,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  recipe,
  UI,
  wish,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";
import { type MentionableCharm } from "./system/backlinks-index.tsx";
// Import from pure utility to avoid circular dependency
import { inferTypeFromModules } from "./record/type-inference.ts";

// ===== Relationship Type Registry =====
// Maps relationship types to their inverses. Symmetric relationships map to themselves.

export const RELATIONSHIP_TYPES: Record<
  string,
  { inverse: string; symmetric: boolean; category: string }
> = {
  // Family relationships
  "parent-of": { inverse: "child-of", symmetric: false, category: "family" },
  "child-of": { inverse: "parent-of", symmetric: false, category: "family" },
  "sibling-of": { inverse: "sibling-of", symmetric: true, category: "family" },
  "spouse-of": { inverse: "spouse-of", symmetric: true, category: "family" },

  // Organizational relationships
  "member-of": { inverse: "has-member", symmetric: false, category: "organizational" },
  "has-member": { inverse: "member-of", symmetric: false, category: "organizational" },
  "employee-of": { inverse: "employs", symmetric: false, category: "organizational" },
  "employs": { inverse: "employee-of", symmetric: false, category: "organizational" },

  // Social relationships
  "friend-of": { inverse: "friend-of", symmetric: true, category: "social" },
  "knows": { inverse: "knows", symmetric: true, category: "social" },
  "colleague-of": { inverse: "colleague-of", symmetric: true, category: "social" },
  "mentor-of": { inverse: "mentee-of", symmetric: false, category: "social" },
  "mentee-of": { inverse: "mentor-of", symmetric: false, category: "social" },

  // Location relationships
  "lives-at": { inverse: "residence-of", symmetric: false, category: "place" },
  "residence-of": { inverse: "lives-at", symmetric: false, category: "place" },
  "located-in": { inverse: "contains", symmetric: false, category: "place" },
  "contains": { inverse: "located-in", symmetric: false, category: "place" },
};

/** Get the inverse relationship type */
export function getInverseType(type: string): string {
  return RELATIONSHIP_TYPES[type]?.inverse ?? type;
}

/** Check if a relationship type is symmetric */
export function isSymmetricType(type: string): boolean {
  return RELATIONSHIP_TYPES[type]?.symmetric ?? true; // Default to symmetric if unknown
}

/** Build options for relationship type dropdown */
const RELATIONSHIP_TYPE_OPTIONS = [
  { value: "", label: "Auto" },
  ...Object.keys(RELATIONSHIP_TYPES).map((type) => ({
    value: type,
    label: type.replace(/-/g, " "),
  })),
];

/** Get default relationship type based on target's module types */
function getDefaultRelationshipType(targetModules: string[]): string {
  const targetInferred = inferTypeFromModules(targetModules);
  // If target is a family or organization, default to "member-of"
  if (targetInferred.type === "family" || targetInferred.type === "organization") {
    return "member-of";
  }
  // If target is a person, default to "knows"
  if (targetInferred.type === "person") {
    return "knows";
  }
  // Default fallback
  return "knows";
}

// ===== Types =====

/** A relationship entry stores a typed reference to another charm */
export interface RelationshipEntry {
  /** Reference to the target charm */
  target: unknown;
  /** Relationship type (e.g., "member-of", "parent-of", "knows") */
  type: string;
  /** True if both sides are linked (for record-to-record) */
  bidirectional?: boolean;
}

/**
 * Input properties for the RelationshipsModule pattern.
 *
 * Can be used standalone (will use wish("#mentionable") to find charms) or
 * embedded in Record (receives pre-filtered mentionable list and parentRecord).
 *
 * NOTE: Creating new records from Relationships is not yet supported (CT-1130).
 * Functions cannot survive the pattern input serialization boundary.
 */
export interface RelationshipsModuleInput {
  /** Array of relationship entries with charm references and types */
  relationships: Default<RelationshipEntry[], []>;
  /**
   * Pre-filtered list of mentionable charms. If provided, used directly.
   * If not provided, falls back to wish("#mentionable").
   * When passed from Record, this list already excludes self.
   */
  mentionable?: MentionableCharm[];
  /**
   * Parent record reference for bidirectional linking.
   * When a relationship is added with bidirectional=true, the inverse relationship
   * gets added to the target's relationships.
   */
  parentRecord?: MentionableCharm | null;
}

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "relationships",
  label: "Relationships",
  icon: "\u{1F517}", // link emoji 🔗
  schema: {
    // Relationships are charm references, not extractable from text
    // AI extraction would need special handling to match names to records
  },
  fieldMapping: [],
};

// ===== Filter Options =====
type FilterMode =
  | "all-records"
  | "people"
  | "families"
  | "places"
  | "everything";

const FILTER_OPTIONS = [
  { value: "all-records", label: "All Records" },
  { value: "people", label: "People" },
  { value: "families", label: "Families" },
  { value: "places", label: "Places" },
  { value: "everything", label: "Everything" },
];

// ===== Helper Functions =====

/** Check if a charm is a Record - uses subCharms as marker since #record isn't stored */
function isRecord(charm: unknown): boolean {
  // Can't use #record because it's not in RecordOutput interface and isn't persisted
  // Instead, check for subCharms property which IS a stored Record property
  // NOTE: Array.isArray() doesn't work on reactive proxies - it returns false even for arrays
  // So we check for property existence and length instead
  // deno-lint-ignore no-explicit-any -- charm is unknown, can't import RecordOutput (circular dep)
  const subCharms = (charm as any)?.subCharms;
  return subCharms !== undefined && subCharms !== null && typeof subCharms.length === "number";
}

/** Get module types from a record's subCharms */
function getModuleTypes(charm: unknown): string[] {
  // deno-lint-ignore no-explicit-any -- charm is unknown, can't import RecordOutput (circular dep)
  const subCharms = (charm as any)?.subCharms;
  // Use length check instead of Array.isArray() - reactive proxies don't pass Array.isArray
  if (subCharms == null || typeof subCharms.length !== "number") return [];
  // Convert to array if it's array-like (reactive proxy), then map
  const arr = Array.from(subCharms as ArrayLike<unknown>);
  // deno-lint-ignore no-explicit-any -- subCharm entries are untyped here (circular dep)
  return arr.map((e: any) => e?.type).filter(Boolean);
}

/** Get display name from a charm */
function getCharmName(charm: unknown): string {
  // deno-lint-ignore no-explicit-any -- NAME symbol access requires any cast
  return (charm as any)?.[NAME] || "Unknown";
}

// ===== Handlers =====

/** Navigate to a target charm when clicked */
const navigateToTarget = handler<
  Event,
  { target: unknown }
>((_event, { target }) => {
  return navigateTo(target as Cell<unknown>);
});

/** Remove a relationship by target reference with reverse link cleanup */
const removeRelationship = handler<
  Event,
  {
    relationships: Cell<RelationshipEntry[]>;
    target: unknown;
    parentRecord: unknown;
    mentionable: Cell<MentionableCharm[]>;
    errorMessage: Cell<string>;
  }
>((event, { relationships, target, parentRecord, mentionable, errorMessage }) => {
  event.stopPropagation?.();
  errorMessage.set("");

  try {
    // === PHASE 1: Read current state and prepare updates ===

    const current = relationships.get() || [];
    // Find the entry by target reference using Cell.equals for robust identity comparison
    const index = current.findIndex((r: RelationshipEntry) =>
      Cell.equals(r?.target as Cell<unknown>, target as Cell<unknown>)
    );

    if (index < 0) return; // Entry not found

    const entry = current[index];

    // Prepare local update
    const newLocalRelationshipsList = current.toSpliced(index, 1);

    // Prepare reverse link removal (if bidirectional)
    let targetRelationshipsCell: Cell<RelationshipEntry[]> | null = null;
    let newTargetRelationshipsList: RelationshipEntry[] | null = null;

    if (entry.bidirectional && isRecord(entry.target) && parentRecord) {
      try {
        // Find the target charm in mentionable to get a writable Cell reference
        const mentionableValue = mentionable.get() || [];
        let targetCharmIndex = -1;
        for (let i = 0; i < mentionableValue.length; i++) {
          if (Cell.equals(mentionableValue[i] as object, entry.target as object)) {
            targetCharmIndex = i;
            break;
          }
        }

        if (targetCharmIndex >= 0) {
          // Navigate to the target charm's subCharms using Cell.key() for writable references
          const targetCharmCell = mentionable.key(targetCharmIndex);
          const targetSubCharms = targetCharmCell.key("subCharms").get() || [];

          // Find the relationships module entry
          // deno-lint-ignore no-explicit-any -- subCharm entries untyped (circular dep with Record)
          const relationshipsEntryIndex = targetSubCharms.findIndex(
            (e: any) => e?.type === "relationships",
          );

          if (relationshipsEntryIndex >= 0) {
            // Navigate to the relationships Cell using .key() chain for a writable Cell reference
            targetRelationshipsCell = targetCharmCell
              .key("subCharms")
              .key(relationshipsEntryIndex)
              .key("charm")
              .key("relationships") as Cell<RelationshipEntry[]>;

            const targetRelationshipsList = targetRelationshipsCell.get?.() || [];

            // Find reverse link (this record in target's relationships)
            const reverseIdx = targetRelationshipsList.findIndex((r: RelationshipEntry) =>
              Cell.equals(
                r?.target as Cell<unknown>,
                parentRecord as Cell<unknown>,
              )
            );

            if (reverseIdx >= 0) {
              newTargetRelationshipsList = targetRelationshipsList.toSpliced(reverseIdx, 1);
            }
          }
        }
      } catch (e) {
        console.warn("Could not prepare reverse link removal:", e);
        // Continue anyway - we'll remove local even if reverse fails
      }
    }

    // === PHASE 2: Commit both updates atomically ===

    // Write local relationships
    relationships.set(newLocalRelationshipsList);

    // Write reverse link removal (if prepared)
    if (targetRelationshipsCell && newTargetRelationshipsList) {
      targetRelationshipsCell.set(newTargetRelationshipsList);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errorMessage.set(`Failed to remove relationship: ${msg}`);
  }
});

/** Start editing a type (click handler that stops propagation) */
const startEditType = handler<
  Event,
  {
    editingIndex: Cell<number>;
    typeInputValue: Cell<string>;
    index: number;
    currentType: string;
  }
>((event, { editingIndex, typeInputValue, index, currentType }) => {
  event.stopPropagation?.();
  typeInputValue.set(currentType);
  editingIndex.set(index);
});

/** Stop event propagation for type input clicks */
const stopPropagationOnly = handler<Event, Record<string, never>>((event) => {
  event.stopPropagation?.();
});

/** Confirm type edit - saves the type and closes edit mode */
const confirmTypeEdit = handler<
  Event,
  {
    relationships: Cell<RelationshipEntry[]>;
    index: number;
    typeInputValue: Cell<string>;
    editingIndex: Cell<number>;
  }
>((event, { relationships, index, typeInputValue, editingIndex }) => {
  event.stopPropagation?.();
  const newType = typeInputValue.get();
  const current = relationships.get() || [];
  // Use the index directly instead of Cell.equals lookup (avoids reactive subscriptions)
  if (index >= 0 && index < current.length) {
    const updated = [...current];
    updated[index] = { ...updated[index], type: newType || "knows" };
    relationships.set(updated);
  }
  editingIndex.set(-1);
});

/** Cancel type edit - just closes edit mode */
const cancelTypeEdit = handler<
  Event,
  { editingIndex: Cell<number> }
>((event, { editingIndex }) => {
  event.stopPropagation?.();
  editingIndex.set(-1);
});

/** Add a relationship from autocomplete selection */
const addRelationship = handler<
  CustomEvent<
    { value: string; label?: string; isCustom?: boolean; data?: unknown }
  >,
  {
    relationships: Cell<RelationshipEntry[]>;
    parentRecord: unknown;
    errorMessage: Cell<string>;
    mentionable: Cell<MentionableCharm[]>;
    selectedType: Cell<string>;
    // deno-lint-ignore no-explicit-any
    createRecord: any; // Function that creates a new Record with given title
  }
>((event, { relationships, parentRecord, errorMessage, mentionable, selectedType, createRecord }) => {
  const { value, isCustom, data } = event.detail || {};

  // Clear previous errors
  errorMessage.set("");

  // Get the selected relationship type (or empty for auto)
  const userSelectedType = selectedType.get();

  if (isCustom) {
    // User typed a custom name - create a new Record if callback is available
    // createRecord may be a Cell wrapper around the function - unwrap it
    // deno-lint-ignore no-explicit-any
    const createRecordFn = typeof (createRecord as any)?.get === "function"
      // deno-lint-ignore no-explicit-any
      ? (createRecord as any).get()
      : createRecord;

    if (!createRecordFn || typeof createRecordFn !== "function") {
      // No createRecord callback - show error (fallback for standalone use)
      errorMessage.set(
        "Creating new records is not yet supported. Please create the record first, then add it here.",
      );
      return;
    }

    // Create new Record with the typed name
    const newTitle = value?.trim();
    if (!newTitle) {
      errorMessage.set("Please enter a name for the new record.");
      return;
    }

    try {
      const newRecord = createRecordFn(newTitle);
      if (!newRecord) {
        errorMessage.set("Failed to create new record.");
        return;
      }

      // Add the new record as a relationship (not bidirectional since it's new)
      const currentRelationships = relationships.get() || [];
      const relationshipType = userSelectedType || "knows";
      const newEntry: RelationshipEntry = {
        target: newRecord,
        type: relationshipType,
        bidirectional: false, // New record has no relationships module yet
      };
      relationships.set([...currentRelationships, newEntry]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errorMessage.set(`Failed to create record: ${msg}`);
    }
    return;
  }

  // Extract charm index from data
  // Reactive proxies become undefined during event sanitization, so we pass
  // an index into mentionable instead of the charm reference directly.
  const { charmIndex, isRecord: targetIsRecord, defaultType } =
    (data as {
      charmIndex: number;
      isRecord: boolean;
      defaultType: string;
    }) || {};

  if (charmIndex === undefined || charmIndex < 0) {
    console.warn("No charm index in selection event");
    return;
  }

  // Sample the current value at index to capture the specific charm at selection time.
  // Using .get()[index] (not .key(index)) avoids forward-tracking - .key(index) would
  // reference whatever is at that position going forward, not the selected charm.
  const targetCharm = mentionable.get()[charmIndex];

  // Also get a Cell reference for navigating to the target's subCharms.
  // We need .key() navigation to get writable Cell references for bidirectional linking.
  const charmCell = mentionable.key(charmIndex);

  if (!targetCharm) {
    console.warn("Charm not found at index", charmIndex);
    return;
  }

  // === PHASE 1: Read current state and prepare updates ===

  // Determine the relationship type to use
  const relationshipType = userSelectedType || defaultType || "knows";
  const inverseType = getInverseType(relationshipType);

  // Read local relationships
  const currentRelationships = relationships.get() || [];

  // Atomic duplicate check - if found, show feedback and bail
  // Cell.equals() resolves all links on both sides to compare actual data
  const isDuplicate = currentRelationships.some((r) =>
    Cell.equals(r.target as object, targetCharm as unknown as object)
  );
  if (isDuplicate) {
    errorMessage.set("This relationship already exists.");
    return;
  }

  // Determine if bidirectional (both are records with Relationships modules)
  // targetIsRecord comes from the data (computed in lift context)
  // sourceIsRecord uses isRecord() which works on parentRecord from wish()
  const sourceIsRecord = parentRecord ? isRecord(parentRecord) : false;
  let bidirectional = targetIsRecord && sourceIsRecord;

  // Prepare reverse link update (if bidirectional)
  let targetRelationshipsCell: Cell<RelationshipEntry[]> | null = null;
  let newTargetRelationshipsList: RelationshipEntry[] | null = null;

  if (bidirectional && parentRecord) {
    try {
      // Navigate to the target charm's subCharms using Cell.key() for writable references.
      // Property access on .get() values returns plain values, not Cells.
      // We need actual Cell references to write the reverse link.
      const targetSubCharms = charmCell.key("subCharms").get() || [];

      // Find the relationships module entry
      // deno-lint-ignore no-explicit-any -- subCharm entries untyped (circular dep with Record)
      const relationshipsEntryIndex = targetSubCharms.findIndex(
        (e: any) => e?.type === "relationships",
      );

      if (relationshipsEntryIndex >= 0) {
        // Navigate to the relationships Cell using .key() chain for a writable Cell reference.
        // This is the correct pattern - property access gives values, .key() gives Cells.
        targetRelationshipsCell = charmCell
          .key("subCharms")
          .key(relationshipsEntryIndex)
          .key("charm")
          .key("relationships") as Cell<RelationshipEntry[]>;

        const targetRelationshipsList = targetRelationshipsCell.get() || [];

        // Check if reverse link already exists
        const existingEntryIndex = targetRelationshipsList.findIndex(
          (r: RelationshipEntry) =>
            Cell.equals(parentRecord as object, r?.target as object),
        );

        if (existingEntryIndex === -1) {
          // No existing entry - add new one with the INVERSE type and bidirectional: true
          newTargetRelationshipsList = [
            ...targetRelationshipsList,
            { target: parentRecord, type: inverseType, bidirectional: true },
          ];
        } else {
          // Entry exists - update it to be bidirectional
          const existingEntry = targetRelationshipsList[existingEntryIndex];
          if (!existingEntry.bidirectional) {
            // Only update if not already bidirectional
            newTargetRelationshipsList = [
              ...targetRelationshipsList.slice(0, existingEntryIndex),
              { ...existingEntry, bidirectional: true },
              ...targetRelationshipsList.slice(existingEntryIndex + 1),
            ];
          }
          // else: already bidirectional, nothing to do (newTargetRelationshipsList stays null)
        }
      } else {
        // Target has no Relationships module - can't be bidirectional
        bidirectional = false;
      }
    } catch (e) {
      // Target doesn't support relationships - mark as non-bidirectional
      bidirectional = false;
      console.warn("Target doesn't support bidirectional linking:", e);
    }
  }

  // Prepare local update
  const newEntry: RelationshipEntry = {
    target: targetCharm,
    type: relationshipType,
    bidirectional,
  };
  const newLocalRelationshipsList = [...currentRelationships, newEntry];

  // === PHASE 2: Commit both updates atomically ===
  // Both writes happen in the same transaction context.
  // If either fails, the transaction will roll back both.

  try {
    // Write local relationships
    relationships.set(newLocalRelationshipsList);

    // Write reverse link (if prepared)
    if (targetRelationshipsCell && newTargetRelationshipsList) {
      targetRelationshipsCell.set(newTargetRelationshipsList);
    }
  } catch (e) {
    // Transaction failed - both writes are rolled back
    const msg = e instanceof Error ? e.message : "Unknown error";
    errorMessage.set(`Failed to add relationship: ${msg}`);
  }
});

// ===== The Pattern =====
export const RelationshipsModule = recipe<RelationshipsModuleInput, RelationshipsModuleInput>(
  "RelationshipsModule",
  ({
    relationships,
    mentionable: mentionableProp,
    parentRecord: parentRecordProp,
  }) => {
    // Local state
    const filterMode = Cell.of<FilterMode>("all-records");
    const selectedType = Cell.of<string>(""); // User-selected relationship type (empty = auto)

    // Get mentionable charms - use prop if provided (pre-filtered by Record), otherwise wish
    // When passed from Record, the list is already filtered to exclude self
    const mentionableFromWish = wish<MentionableCharm[]>("#mentionable");
    const mentionable = mentionableProp ?? mentionableFromWish;
    // Track which relationship index is being edited (-1 means none)
    // Using index instead of target reference avoids Cell.equals() in reactive contexts
    const editingIndex = Cell.of<number>(-1);
    const typeInputValue = Cell.of("");
    const errorMessage = Cell.of("");

    // Parent record for bidirectional linking
    // When passed from Record, we use the prop directly - no need to search
    // This avoids all reactive proxy comparison issues
    const parentRecord = parentRecordProp ?? null;

    // Build autocomplete items from mentionable using lift()
    // lift() properly unwraps OpaqueRefs from wish()
    // NOTE: When mentionable comes from Record (mentionableProp), self is already filtered out
    // Self-filtering is done at the source (Record) to avoid reactive proxy comparison issues
    const autocompleteItems = lift(
      ({ mentionable: all, filterMode: mode }: {
        mentionable: MentionableCharm[];
        filterMode: FilterMode;
      }) => {
        const items = all || [];

        // Build array of { item, originalIndex } to track indices through filtering
        const indexedItems = items.map((item, idx) => ({ item, originalIndex: idx }));

        // Filter based on mode (self already excluded if using mentionableProp)
        let filtered: { item: MentionableCharm; originalIndex: number }[];
        switch (mode) {
          case "all-records":
            filtered = indexedItems.filter(({ item }) => isRecord(item));
            break;
          case "people":
            filtered = indexedItems.filter(({ item }) => {
              if (!isRecord(item)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(item));
              return inferred.type === "person";
            });
            break;
          case "families":
            filtered = indexedItems.filter(({ item }) => {
              if (!isRecord(item)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(item));
              return inferred.type === "family";
            });
            break;
          case "places":
            filtered = indexedItems.filter(({ item }) => {
              if (!isRecord(item)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(item));
              return inferred.type === "place";
            });
            break;
          case "everything":
          default:
            filtered = indexedItems;
        }

        // Build autocomplete items with charm index for lookup in handler
        // Reactive proxies become undefined during event sanitization, so we pass
        // the index into the mentionable array. The handler receives the mentionable
        // Cell and uses .key(index) for Cell navigation.
        return filtered.map(({ item: charm, originalIndex: charmIndex }) => {
          const name = getCharmName(charm);
          const charmIsRecord = isRecord(charm);

          let icon = "🔗";
          let group = "linked";
          let defaultType = "knows";

          // Get inferred type for icon/grouping if this is a Record
          if (charmIsRecord) {
            const targetModules = getModuleTypes(charm);
            const inferred = inferTypeFromModules(targetModules);
            icon = inferred.icon;
            group = inferred.type;
            // Compute default relationship type based on target
            defaultType = getDefaultRelationshipType(targetModules);
          }

          return {
            value: name, // Human-readable value
            label: `${icon} ${name}`,
            group,
            // Pass charm index, isRecord flag, and defaultType for handler context.
            // isRecord is pre-computed here where direct property access works.
            // The handler will use mentionable.key(charmIndex) for Cell navigation.
            data: {
              charmIndex,
              isRecord: charmIsRecord,
              defaultType,
            },
          };
        });
      },
    )({ mentionable, filterMode });

    // Display text for NAME
    const displayText = computed(() => {
      const count = (relationships || []).length || 0;
      return count > 0
        ? `${count} relationship${count !== 1 ? "s" : ""}`
        : "No relationships";
    });

    // Filter valid relationships (exclude deleted/null targets)
    const validRelationships = computed(() => {
      const all = relationships || [];
      return all.filter((entry: RelationshipEntry) => {
        try {
          return entry?.target != null;
        } catch {
          return false;
        }
      });
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Relationships: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          {/* Filter dropdown, type selector, and search */}
          <ct-hstack style={{ gap: "8px", alignItems: "center" }}>
            <ct-select
              $value={filterMode}
              items={FILTER_OPTIONS}
              style={{ width: "120px" }}
            />
            <ct-select
              $value={selectedType}
              items={RELATIONSHIP_TYPE_OPTIONS}
              style={{ width: "120px" }}
            />
            <ct-autocomplete
              items={autocompleteItems}
              placeholder="Search..."
              allowCustom={false}
              onct-select={addRelationship({
                relationships,
                parentRecord,
                errorMessage,
                mentionable,
                selectedType,
                createRecord: null,
              })}
              style={{ flex: "1" }}
            />
          </ct-hstack>

          {/* Error banner with dismiss */}
          {ifElse(
            computed(() => errorMessage.get().length > 0),
            <div
              style={{
                padding: "8px 12px",
                background: "#fee2e2",
                borderRadius: "6px",
                color: "#991b1b",
                fontSize: "13px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>{errorMessage}</span>
              <button
                type="button"
                onClick={() => errorMessage.set("")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#991b1b",
                  fontSize: "16px",
                  padding: "0 4px",
                }}
                title="Dismiss"
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>,
            null,
          )}

          {/* Relationship chips */}
          <ct-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
            {validRelationships.map((entry: RelationshipEntry, index: number) => {
              const targetIsRecord = isRecord(entry.target);
              const targetName = getCharmName(entry.target);

              // Get icon for records
              let icon = "🔗";
              if (targetIsRecord) {
                const inferred = inferTypeFromModules(
                  getModuleTypes(entry.target),
                );
                icon = inferred.icon;
              }

              return (
                <span
                  key={index}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    background: targetIsRecord ? "#dbeafe" : "#e5e7eb",
                    borderRadius: "16px",
                    padding: "4px 12px",
                    fontSize: "14px",
                    border: targetIsRecord
                      ? "1px solid #93c5fd"
                      : "1px solid #d1d5db",
                  }}
                >
                  <span style={{ fontSize: "12px" }}>{icon}</span>
                  <span
                    onClick={navigateToTarget({ target: entry.target })}
                    style={{ cursor: "pointer" }}
                  >
                    {targetName}
                  </span>
                  {/* Type editing - use index comparison to avoid Cell.equals() in reactive context */}
                  {ifElse(
                    computed(() => editingIndex.get() === index),
                    // Editing mode - inline input with save/cancel
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "2px",
                      }}
                      onClick={stopPropagationOnly({})}
                    >
                      <ct-input
                        $value={typeInputValue}
                        placeholder="Type..."
                        style="width: 80px; font-size: 12px;"
                      />
                      <button
                        type="button"
                        onClick={confirmTypeEdit({
                          relationships,
                          index,
                          typeInputValue,
                          editingIndex,
                        })}
                        style={{
                          background: "#3b82f6",
                          border: "none",
                          borderRadius: "3px",
                          color: "white",
                          cursor: "pointer",
                          fontSize: "10px",
                          padding: "2px 4px",
                        }}
                        title="Save type"
                        aria-label="Save type"
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        onClick={cancelTypeEdit({ editingIndex })}
                        style={{
                          background: "#e5e7eb",
                          border: "none",
                          borderRadius: "3px",
                          color: "#6b7280",
                          cursor: "pointer",
                          fontSize: "10px",
                          padding: "2px 4px",
                        }}
                        title="Cancel"
                        aria-label="Cancel type edit"
                      >
                        ✕
                      </button>
                    </span>,
                    // Display mode - show type (always present)
                    <span
                      style={{
                        color: "#6b7280",
                        fontSize: "12px",
                        fontStyle: "italic",
                        cursor: "text",
                      }}
                      onClick={startEditType({
                        editingIndex,
                        typeInputValue,
                        index,
                        currentType: entry.type || "knows",
                      })}
                      title="Click to edit type"
                    >
                      ({entry.type || "knows"})
                    </span>,
                  )}
                  {entry.bidirectional && (
                    <span style={{ fontSize: "10px", color: "#3b82f6" }}>
                      ↔
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={removeRelationship({
                      relationships,
                      target: entry.target,
                      parentRecord,
                      mentionable,
                      errorMessage,
                    })}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "0",
                      fontSize: "16px",
                      color: "#6b7280",
                      lineHeight: "1",
                      marginLeft: "2px",
                    }}
                    title="Remove relationship"
                    aria-label="Remove relationship"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </ct-hstack>

          {/* Empty state */}
          {computed(() => (validRelationships || []).length === 0) && (
            <span style={{ color: "#9ca3af", fontSize: "14px" }}>
              No relationships yet. Search to add relationships.
            </span>
          )}
        </ct-vstack>
      ),
      relationships,
    };
  },
);

export default RelationshipsModule;
