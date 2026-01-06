/// <cts-enable />
/**
 * Members Module - Pattern for referencing other charms
 *
 * A composable pattern for Record that stores references to other charms
 * (typically people, organizations, or related records) with optional role metadata.
 * Displays as compact clickable chips with bidirectional linking for records.
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

// ===== Types =====

/** A member entry stores a reference to another charm with optional metadata */
export interface MemberEntry {
  /** Reference to the charm */
  charm: unknown;
  /** Optional role (e.g., "Host", "Parent", "Organizer") */
  role?: string;
  /** True if both sides are linked (for record-to-record) */
  bidirectional?: boolean;
}

export interface MembersModuleInput {
  /** Array of member entries */
  members: Default<MemberEntry[], []>;
  /** Parent's subCharms for finding self and bidirectional linking */
  parentSubCharms?: Cell<{ type: string; charm: unknown }[]>;
  /** Pattern JSON for creating new stub records (serialized pattern definition) */
  createPattern?: Default<string, "">;
  /** Pre-filtered mentionable list (excludes self). If not provided, uses wish("#mentionable") */
  mentionable?: MentionableCharm[];
  /** Parent record reference for bidirectional linking (passed directly from Record) */
  parentRecord?: MentionableCharm | null;
}

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "members",
  label: "Members",
  icon: "\u{1F465}", // busts in silhouette emoji
  schema: {
    // Members are charm references, not extractable from text
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
  const subCharms = (charm as any)?.subCharms;
  return subCharms !== undefined && subCharms !== null && typeof subCharms.length === "number";
}

/** Get module types from a record's subCharms */
function getModuleTypes(charm: unknown): string[] {
  const subCharms = (charm as any)?.subCharms;
  // Use length check instead of Array.isArray() - reactive proxies don't pass Array.isArray
  if (subCharms == null || typeof subCharms.length !== "number") return [];
  // Convert to array if it's array-like (reactive proxy), then map
  const arr = Array.from(subCharms as ArrayLike<unknown>);
  return arr.map((e: any) => e?.type).filter(Boolean);
}

/** Get display name from a charm */
function getCharmName(charm: unknown): string {
  return (charm as any)?.[NAME] || "Unknown";
}

// ===== Handlers =====

/** Navigate to a member charm when clicked */
const navigateToMember = handler<
  Event,
  { charm: unknown }
>((_event, { charm }) => {
  return navigateTo(charm as Cell<unknown>);
});

/** Remove a member by charm reference with reverse link cleanup */
const removeMember = handler<
  Event,
  {
    members: Cell<MemberEntry[]>;
    charm: unknown;
    parentRecord: unknown;
    errorMessage: Cell<string>;
  }
>((event, { members, charm, parentRecord, errorMessage }) => {
  event.stopPropagation?.();
  errorMessage.set("");

  try {
    // === PHASE 1: Read current state and prepare updates ===

    const current = members.get() || [];
    // Find the entry by charm reference using Cell.equals for robust identity comparison
    const index = current.findIndex((m: MemberEntry) =>
      Cell.equals(m?.charm as Cell<unknown>, charm as Cell<unknown>)
    );

    if (index < 0) return; // Entry not found

    const entry = current[index];

    // Prepare local update
    const newLocalMembersList = current.toSpliced(index, 1);

    // Prepare reverse link removal (if bidirectional)
    let targetMembersCell: Cell<MemberEntry[]> | null = null;
    let newTargetMembersList: MemberEntry[] | null = null;

    if (entry.bidirectional && isRecord(entry.charm) && parentRecord) {
      try {
        const targetCharm = entry.charm as Cell<any>;
        const targetSubCharms = targetCharm.key?.("subCharms")?.get?.() || [];
        const targetMembersEntry = targetSubCharms.find(
          (e: any) => e?.type === "members",
        );

        if (targetMembersEntry?.charm) {
          targetMembersCell = targetMembersEntry.charm.key("members") as Cell<
            MemberEntry[]
          >;
          const targetMembersList = targetMembersCell.get?.() || [];

          // Find reverse link (this record in target's members)
          const reverseIdx = targetMembersList.findIndex((m: MemberEntry) =>
            Cell.equals(
              m?.charm as Cell<unknown>,
              parentRecord as Cell<unknown>,
            )
          );

          if (reverseIdx >= 0) {
            newTargetMembersList = targetMembersList.toSpliced(reverseIdx, 1);
          }
        }
      } catch (e) {
        console.warn("Could not prepare reverse link removal:", e);
        // Continue anyway - we'll remove local even if reverse fails
      }
    }

    // === PHASE 2: Commit both updates atomically ===

    // Write local members
    members.set(newLocalMembersList);

    // Write reverse link removal (if prepared)
    if (targetMembersCell && newTargetMembersList) {
      targetMembersCell.set(newTargetMembersList);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errorMessage.set(`Failed to remove member: ${msg}`);
  }
});

/** Start editing a role (click handler that stops propagation) */
const startEditRole = handler<
  Event,
  {
    editingIndex: Cell<number>;
    roleInputValue: Cell<string>;
    index: number;
    currentRole: string;
  }
>((event, { editingIndex, roleInputValue, index, currentRole }) => {
  event.stopPropagation?.();
  roleInputValue.set(currentRole);
  editingIndex.set(index);
});

/** Stop event propagation for role input clicks */
const stopPropagationOnly = handler<Event, Record<string, never>>((event) => {
  event.stopPropagation?.();
});

/** Confirm role edit - saves the role and closes edit mode */
const confirmRoleEdit = handler<
  Event,
  {
    members: Cell<MemberEntry[]>;
    index: number;
    roleInputValue: Cell<string>;
    editingIndex: Cell<number>;
  }
>((event, { members, index, roleInputValue, editingIndex }) => {
  event.stopPropagation?.();
  const newRole = roleInputValue.get();
  const current = members.get() || [];
  // Use the index directly instead of Cell.equals lookup (avoids reactive subscriptions)
  if (index >= 0 && index < current.length) {
    const updated = [...current];
    updated[index] = { ...updated[index], role: newRole || undefined };
    members.set(updated);
  }
  editingIndex.set(-1);
});

/** Cancel role edit - just closes edit mode */
const cancelRoleEdit = handler<
  Event,
  { editingIndex: Cell<number> }
>((event, { editingIndex }) => {
  event.stopPropagation?.();
  editingIndex.set(-1);
});

/** Add a member from autocomplete selection */
const addMember = handler<
  CustomEvent<
    { value: string; label?: string; isCustom?: boolean; data?: unknown }
  >,
  {
    members: Cell<MemberEntry[]>;
    parentRecord: unknown;
    errorMessage: Cell<string>;
    mentionable: Cell<MentionableCharm[]>;
  }
>((event, { members, parentRecord, errorMessage, mentionable }) => {
  const { isCustom, data } = event.detail || {};

  // Clear previous errors
  errorMessage.set("");

  if (isCustom) {
    // TODO(CT-1130): Creating new records from Members is not yet supported.
    // The pattern system cannot pass factory functions through serialization.
    // See: https://linear.app/common-tools/issue/CT-1130
    errorMessage.set(
      "Creating new records is not yet supported. Please create the record first, then add it here.",
    );
    return;
  }

  // Extract charm index from data
  // Reactive proxies become undefined during event sanitization, so we pass
  // an index into mentionable instead of the charm reference directly.
  const { charmIndex, isRecord: targetIsRecord } =
    (data as {
      charmIndex: number;
      isRecord: boolean;
    }) || {};

  if (charmIndex === undefined || charmIndex < 0) {
    console.warn("No charm index in selection event");
    return;
  }

  // Sample the current value at index to capture the specific charm at selection time.
  // Using .get()[index] (not .key(index)) avoids forward-tracking - .key(index) would
  // reference whatever is at that position going forward, not the selected charm.
  const charm = mentionable.get()[charmIndex];

  // Also get a Cell reference for navigating to the target's subCharms.
  // We need .key() navigation to get writable Cell references for bidirectional linking.
  const charmCell = mentionable.key(charmIndex);

  if (!charm) {
    console.warn("Charm not found at index", charmIndex);
    return;
  }

  // === PHASE 1: Read current state and prepare updates ===

  // Read local members
  const currentMembers = members.get() || [];

  // Atomic duplicate check - if found, show feedback and bail
  // Cell.equals() resolves all links on both sides to compare actual data
  const isDuplicate = currentMembers.some((m) =>
    Cell.equals(m.charm as object, charm as unknown as object)
  );
  if (isDuplicate) {
    errorMessage.set("This member is already added.");
    return;
  }

  // Determine if bidirectional (both are records with Members modules)
  // targetIsRecord comes from the data (computed in lift context)
  // sourceIsRecord uses isRecord() which works on parentRecord from wish()
  const sourceIsRecord = parentRecord ? isRecord(parentRecord) : false;
  let bidirectional = targetIsRecord && sourceIsRecord;

  // Prepare reverse link update (if bidirectional)
  let targetMembersCell: Cell<MemberEntry[]> | null = null;
  let newTargetMembersList: MemberEntry[] | null = null;

  if (bidirectional && parentRecord) {
    try {
      // Navigate to the target charm's subCharms using Cell.key() for writable references.
      // Property access on .get() values returns plain values, not Cells.
      // We need actual Cell references to write the reverse link.
      const targetSubCharms = charmCell.key("subCharms").get() || [];

      // Find the members module entry
      const membersEntryIndex = targetSubCharms.findIndex(
        (e: any) => e?.type === "members",
      );

      if (membersEntryIndex >= 0) {
        // Navigate to the members Cell using .key() chain for a writable Cell reference.
        // This is the correct pattern - property access gives values, .key() gives Cells.
        targetMembersCell = charmCell
          .key("subCharms")
          .key(membersEntryIndex)
          .key("charm")
          .key("members") as Cell<MemberEntry[]>;

        const targetMembersList = targetMembersCell.get() || [];

        // Check if reverse link already exists
        const existingEntryIndex = targetMembersList.findIndex(
          (m: MemberEntry) =>
            Cell.equals(parentRecord as object, m?.charm as object),
        );

        if (existingEntryIndex === -1) {
          // No existing entry - add new one with bidirectional: true
          newTargetMembersList = [
            ...targetMembersList,
            { charm: parentRecord, bidirectional: true },
          ];
        } else {
          // Entry exists - update it to be bidirectional
          const existingEntry = targetMembersList[existingEntryIndex];
          if (!existingEntry.bidirectional) {
            // Only update if not already bidirectional
            newTargetMembersList = [
              ...targetMembersList.slice(0, existingEntryIndex),
              { ...existingEntry, bidirectional: true },
              ...targetMembersList.slice(existingEntryIndex + 1),
            ];
          }
          // else: already bidirectional, nothing to do (newTargetMembersList stays null)
        }
      } else {
        // Target has no Members module - can't be bidirectional
        bidirectional = false;
      }
    } catch (e) {
      // Target doesn't support members - mark as non-bidirectional
      bidirectional = false;
      console.warn("Target doesn't support bidirectional linking:", e);
    }
  }

  // Prepare local update
  const newEntry: MemberEntry = {
    charm,
    bidirectional,
  };
  const newLocalMembersList = [...currentMembers, newEntry];

  // === PHASE 2: Commit both updates atomically ===
  // Both writes happen in the same transaction context.
  // If either fails, the transaction will roll back both.

  try {
    // Write local members
    members.set(newLocalMembersList);

    // Write reverse link (if prepared)
    if (targetMembersCell && newTargetMembersList) {
      targetMembersCell.set(newTargetMembersList);
    }
  } catch (e) {
    // Transaction failed - both writes are rolled back
    const msg = e instanceof Error ? e.message : "Unknown error";
    errorMessage.set(`Failed to add member: ${msg}`);
  }
});

// ===== The Pattern =====
export const MembersModule = recipe<MembersModuleInput, MembersModuleInput>(
  "MembersModule",
  ({
    members,
    parentSubCharms,
    createPattern: _createPattern,
    mentionable: mentionableProp,
    parentRecord: parentRecordProp,
  }) => {
    // Local state
    const filterMode = Cell.of<FilterMode>("all-records");

    // Get mentionable charms - use prop if provided (pre-filtered by Record), otherwise wish
    // When passed from Record, the list is already filtered to exclude self
    const mentionableFromWish = wish<MentionableCharm[]>("#mentionable");
    const mentionable = mentionableProp ?? mentionableFromWish;
    // Track which member index is being edited (-1 means none)
    // Using index instead of charm reference avoids Cell.equals() in reactive contexts
    const editingIndex = Cell.of<number>(-1);
    const roleInputValue = Cell.of("");
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

          // Get inferred type for icon/grouping if this is a Record
          if (charmIsRecord) {
            const inferred = inferTypeFromModules(getModuleTypes(charm));
            icon = inferred.icon;
            group = inferred.type;
          }

          return {
            value: name, // Human-readable value
            label: `${icon} ${name}`,
            group,
            // Pass charm index and isRecord flag for handler context.
            // isRecord is pre-computed here where direct property access works.
            // The handler will use mentionable.key(charmIndex) for Cell navigation.
            data: {
              charmIndex,
              isRecord: charmIsRecord,
            },
          };
        });
      },
    )({ mentionable, filterMode });

    // Display text for NAME
    const displayText = computed(() => {
      const count = (members || []).length || 0;
      return count > 0
        ? `${count} member${count !== 1 ? "s" : ""}`
        : "No members";
    });

    // Filter valid members (exclude deleted/null charms)
    const validMembers = computed(() => {
      const all = members || [];
      return all.filter((entry: MemberEntry) => {
        try {
          return entry?.charm != null;
        } catch {
          return false;
        }
      });
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Members: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          {/* Filter dropdown and search */}
          <ct-hstack style={{ gap: "8px", alignItems: "center" }}>
            <ct-select
              $value={filterMode}
              items={FILTER_OPTIONS}
              style={{ width: "140px" }}
            />
            <ct-autocomplete
              items={autocompleteItems}
              placeholder="Search members..."
              onct-select={addMember({
                members,
                parentRecord,
                errorMessage,
                mentionable,
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

          {/* Member chips */}
          <ct-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
            {validMembers.map((entry: MemberEntry, index: number) => {
              const charmIsRecord = isRecord(entry.charm);
              const memberName = getCharmName(entry.charm);

              // Get icon for records
              let icon = "🔗";
              if (charmIsRecord) {
                const inferred = inferTypeFromModules(
                  getModuleTypes(entry.charm),
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
                    background: charmIsRecord ? "#dbeafe" : "#e5e7eb",
                    borderRadius: "16px",
                    padding: "4px 12px",
                    fontSize: "14px",
                    border: charmIsRecord
                      ? "1px solid #93c5fd"
                      : "1px solid #d1d5db",
                  }}
                >
                  <span style={{ fontSize: "12px" }}>{icon}</span>
                  <span
                    onClick={navigateToMember({ charm: entry.charm })}
                    style={{ cursor: "pointer" }}
                  >
                    {memberName}
                  </span>
                  {/* Role editing - use index comparison to avoid Cell.equals() in reactive context */}
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
                        $value={roleInputValue}
                        placeholder="Role..."
                        style="width: 60px; font-size: 12px;"
                      />
                      <button
                        type="button"
                        onClick={confirmRoleEdit({
                          members,
                          index,
                          roleInputValue,
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
                        title="Save role"
                        aria-label="Save role"
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        onClick={cancelRoleEdit({ editingIndex })}
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
                        aria-label="Cancel role edit"
                      >
                        ✕
                      </button>
                    </span>,
                    // Display mode - show role or +role button
                    entry.role
                      ? (
                        <span
                          style={{
                            color: "#6b7280",
                            fontSize: "12px",
                            fontStyle: "italic",
                            cursor: "text",
                          }}
                          onClick={startEditRole({
                            editingIndex,
                            roleInputValue,
                            index,
                            currentRole: entry.role || "",
                          })}
                          title="Click to edit role"
                        >
                          ({entry.role})
                        </span>
                      )
                      : (
                        <span
                          style={{
                            color: "#9ca3af",
                            fontSize: "12px",
                            cursor: "pointer",
                          }}
                          onClick={startEditRole({
                            editingIndex,
                            roleInputValue,
                            index,
                            currentRole: "",
                          })}
                          title="Click to edit role"
                        >
                          ()
                        </span>
                      ),
                  )}
                  {entry.bidirectional && (
                    <span style={{ fontSize: "10px", color: "#3b82f6" }}>
                      ↔
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={removeMember({
                      members,
                      charm: entry.charm,
                      parentRecord,
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
                    title="Remove member"
                    aria-label="Remove member"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </ct-hstack>

          {/* Empty state */}
          {computed(() => (validMembers || []).length === 0) && (
            <span style={{ color: "#9ca3af", fontSize: "14px" }}>
              No members yet. Search to add members.
            </span>
          )}
        </ct-vstack>
      ),
      members,
    };
  },
);

export default MembersModule;
