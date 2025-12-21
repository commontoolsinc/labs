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
import { type MentionableCharm } from "./backlinks-index.tsx";
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
  /** Pattern JSON for creating new stub records */
  createPattern?: Default<string, "">;
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

/** Check if a charm is a Record */
function isRecord(charm: unknown): boolean {
  return (charm as any)?.["#record"] === true;
}

/** Get module types from a record's subCharms */
function getModuleTypes(charm: unknown): string[] {
  const subCharms = (charm as any)?.subCharms;
  if (!Array.isArray(subCharms)) return [];
  return subCharms.map((e: any) => e?.type).filter(Boolean);
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

/** Remove a member by index with reverse link cleanup */
const removeMember = handler<
  Event,
  { members: Cell<MemberEntry[]>; index: number; parentRecord: unknown }
>((event, { members, index, parentRecord }) => {
  event.stopPropagation?.();

  // === PHASE 1: Read current state and prepare updates ===

  const current = members.get() || [];
  const entry = current[index];

  if (!entry) return; // Invalid index

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
          Cell.equals(m?.charm as Cell<unknown>, parentRecord as Cell<unknown>)
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
});

/** Start editing a role (click handler that stops propagation) */
const startEditRole = handler<
  Event,
  {
    editingRoleIndex: Cell<number | null>;
    roleInputValue: Cell<string>;
    index: number;
    currentRole: string;
  }
>((event, { editingRoleIndex, roleInputValue, index, currentRole }) => {
  event.stopPropagation?.();
  roleInputValue.set(currentRole);
  editingRoleIndex.set(index);
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
    editingRoleIndex: Cell<number | null>;
  }
>((event, { members, index, roleInputValue, editingRoleIndex }) => {
  event.stopPropagation?.();
  const newRole = roleInputValue.get();
  const current = members.get() || [];
  if (index >= 0 && index < current.length) {
    const updated = [...current];
    updated[index] = { ...updated[index], role: newRole || undefined };
    members.set(updated);
  }
  editingRoleIndex.set(null);
});

/** Cancel role edit - just closes edit mode */
const cancelRoleEdit = handler<
  Event,
  { editingRoleIndex: Cell<number | null> }
>((event, { editingRoleIndex }) => {
  event.stopPropagation?.();
  editingRoleIndex.set(null);
});

/** Add a member from autocomplete selection */
const addMember = handler<
  CustomEvent<
    { value: string; label?: string; charmRef?: unknown; isCustom?: boolean }
  >,
  {
    members: Cell<MemberEntry[]>;
    parentRecord: unknown;
    createPattern: string;
    errorMessage: Cell<string>;
  }
>((event, { members, parentRecord, createPattern, errorMessage }) => {
  const { value, charmRef, isCustom } = event.detail || {};

  // Clear previous errors
  errorMessage.set("");

  if (isCustom) {
    // Create new blank record with the typed name
    if (!createPattern) {
      errorMessage.set("Cannot create record: no template available");
      return;
    }

    try {
      // Access runtime and space from the members Cell
      const rt = (members as any).runtime;
      const spaceName = (members as any).space;

      if (!rt || !spaceName) {
        errorMessage.set("Cannot create record: runtime unavailable");
        return;
      }

      // Start transaction
      const tx = rt.edit();

      // Create a unique cause Cell for the new charm
      const result = rt.getCell(spaceName, {
        memberName: value,
        timestamp: Date.now(),
      });

      // Parse the pattern JSON
      const pattern = JSON.parse(createPattern);

      // Define inputs for the new Record (just title)
      const inputs: Record<string, unknown> = {
        title: value,
      };

      // Instantiate and run the pattern
      rt.run(tx, pattern, inputs, result);

      // Commit the transaction
      tx.commit();

      // Add the new charm to members list
      // Note: bidirectional=false because new records don't have a Members module yet.
      // When the user adds a Members module to the new record, they can add the reverse link.
      const newEntry: MemberEntry = {
        charm: result,
        bidirectional: false,
      };
      members.push(newEntry);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      errorMessage.set(`Failed to create record: ${msg}`);
    }
    return;
  }

  // Use charmRef from autocomplete item (already included)
  const charm = charmRef;

  if (!charm) {
    console.warn("Could not find charm for:", value);
    return;
  }

  // === PHASE 1: Read current state and prepare updates ===

  // Read local members
  const currentMembers = members.get() || [];

  // Atomic duplicate check - if found, bail early
  const isDuplicate = currentMembers.some((m) =>
    Cell.equals(m.charm as Cell<unknown>, charm as Cell<unknown>)
  );
  if (isDuplicate) return;

  // Determine if bidirectional (both are records with Members modules)
  const targetIsRecord = isRecord(charm);
  const sourceIsRecord = parentRecord ? isRecord(parentRecord) : false;
  let bidirectional = targetIsRecord && sourceIsRecord;

  // Prepare reverse link update (if bidirectional)
  let targetMembersCell: Cell<MemberEntry[]> | null = null;
  let newTargetMembersList: MemberEntry[] | null = null;

  if (bidirectional && parentRecord) {
    try {
      const targetCharm = charm as Cell<any>;
      const targetSubCharms = targetCharm.key?.("subCharms")?.get?.() || [];
      const targetMembersEntry = targetSubCharms.find(
        (e: any) => e?.type === "members",
      );

      if (targetMembersEntry?.charm) {
        targetMembersCell = targetMembersEntry.charm.key("members") as Cell<
          MemberEntry[]
        >;
        const targetMembersList = targetMembersCell.get?.() || [];

        // Check if reverse link already exists
        const hasReverseLink = targetMembersList.some((m: MemberEntry) =>
          Cell.equals(m?.charm as Cell<unknown>, parentRecord as Cell<unknown>)
        );

        if (!hasReverseLink) {
          // Prepare the new target members array
          newTargetMembersList = [
            ...targetMembersList,
            { charm: parentRecord, bidirectional: true },
          ];
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
  ({ members, parentSubCharms, createPattern }) => {
    // Local state
    const filterMode = Cell.of<FilterMode>("all-records");
    const editingRoleIndex = Cell.of<number | null>(null);
    const roleInputValue = Cell.of("");
    const errorMessage = Cell.of("");

    // Get mentionable charms via wish
    const mentionable = wish<Default<MentionableCharm[], []>>("#mentionable");

    // Derive parent ID from parentSubCharms Cell for self-filtering
    // Used by autocomplete to exclude self from search results
    const parentId = computed(() => {
      if (!parentSubCharms) return null;
      // Use parentSubCharms Cell's entity ID as proxy for parent record ID
      return (parentSubCharms as any)?.["/"] || null;
    });

    // Find parent record lazily - only used for bidirectional linking
    // Cached via lift, only recalculates when mentionable changes
    const parentRecord = lift(
      ({ mentionable: all, parentSC }: {
        mentionable: MentionableCharm[];
        parentSC: { type: string; charm: unknown }[] | undefined;
      }) => {
        if (!parentSC) return null;
        // Find the record that contains our members module in its subCharms
        for (const item of all || []) {
          if (!isRecord(item)) continue;
          const subCharms = (item as any)?.subCharms;
          if (!Array.isArray(subCharms)) continue;
          const membersEntry = subCharms.find((sc: any) =>
            sc?.type === "members"
          );
          if (
            membersEntry &&
            parentSC.some((psc: any) =>
              psc?.type === "members" && psc?.charm === membersEntry?.charm
            )
          ) {
            return item;
          }
        }
        return null;
      },
    )({ mentionable, parentSC: parentSubCharms });

    // Build autocomplete items from mentionable using lift()
    // lift() properly unwraps OpaqueRefs from wish()
    // Also filters out self (using parentId) to prevent self-reference
    const autocompleteItems = lift(
      ({ mentionable: all, filterMode: mode, pid }: {
        mentionable: MentionableCharm[];
        filterMode: FilterMode;
        pid: string | null;
      }) => {
        const items = all || [];

        // Helper to check if item is self (using pre-computed parentId)
        const isSelf = (m: any) => pid && (m as any)?.["/"] === pid;

        // Filter based on mode (and always exclude self)
        let filtered: MentionableCharm[];
        switch (mode) {
          case "all-records":
            filtered = items.filter((m: any) => !isSelf(m) && isRecord(m));
            break;
          case "people":
            filtered = items.filter((m: any) => {
              if (isSelf(m) || !isRecord(m)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(m));
              return inferred.type === "person";
            });
            break;
          case "families":
            filtered = items.filter((m: any) => {
              if (isSelf(m) || !isRecord(m)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(m));
              return inferred.type === "family";
            });
            break;
          case "places":
            filtered = items.filter((m: any) => {
              if (isSelf(m) || !isRecord(m)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(m));
              return inferred.type === "place";
            });
            break;
          case "everything":
          default:
            filtered = items.filter((m: any) => !isSelf(m));
        }

        // Build autocomplete items
        return filtered.map((charm: any) => {
          const name = getCharmName(charm);
          const charmIsRecord = isRecord(charm);

          let icon = "🔗";
          let group = "linked";

          if (charmIsRecord) {
            const inferred = inferTypeFromModules(getModuleTypes(charm));
            icon = inferred.icon;
            group = inferred.type;
          }

          return {
            value: (charm as any)?.["/"] || name,
            label: `${icon} ${name}`,
            group,
            charmRef: charm,
          };
        });
      },
    )({ mentionable, filterMode, pid: parentId });

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
              allowCustom
              onct-select={addMember({
                members,
                parentRecord,
                createPattern,
                errorMessage,
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
                  {/* Role editing */}
                  {ifElse(
                    computed(() => editingRoleIndex.get() === index),
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
                          editingRoleIndex,
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
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        onClick={cancelRoleEdit({ editingRoleIndex })}
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
                            editingRoleIndex,
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
                            editingRoleIndex,
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
                    onClick={removeMember({ members, index, parentRecord })}
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
