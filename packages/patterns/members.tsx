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
  lift,
  NAME,
  navigateTo,
  recipe,
  UI,
  wish,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";
import { type MentionableCharm } from "./backlinks-index.tsx";

// NOTE: We inline type inference here to avoid circular dependency:
// members.tsx -> template-registry.ts -> registry.ts -> members.tsx

interface InferredType {
  type: string;
  icon: string;
  confidence: number;
}

/** Infer record "type" from the modules it contains (inlined to avoid circular dep) */
function inferTypeFromModules(moduleTypes: string[]): InferredType {
  const typeSet = new Set(moduleTypes);

  // Person: has birthday AND (contact OR relationship)
  if (
    typeSet.has("birthday") &&
    (typeSet.has("contact") || typeSet.has("relationship"))
  ) {
    return { type: "person", icon: "\u{1F464}", confidence: 0.9 };
  }

  // Recipe: has timing (cooking-specific module)
  if (typeSet.has("timing")) {
    return { type: "recipe", icon: "\u{1F373}", confidence: 0.85 };
  }

  // Project: has timeline AND status
  if (typeSet.has("timeline") && typeSet.has("status")) {
    return { type: "project", icon: "\u{1F4BC}", confidence: 0.85 };
  }

  // Place: has location OR address (but not birthday - that's a person)
  if (
    (typeSet.has("location") || typeSet.has("address")) &&
    !typeSet.has("birthday")
  ) {
    return { type: "place", icon: "\u{1F4CD}", confidence: 0.8 };
  }

  // Family: has address AND relationship (but not birthday - individual person)
  if (
    typeSet.has("address") && typeSet.has("relationship") &&
    !typeSet.has("birthday")
  ) {
    return {
      type: "family",
      icon: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}",
      confidence: 0.75,
    };
  }

  // Default: generic record
  return { type: "record", icon: "\u{1F4CB}", confidence: 0.5 };
}

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
type FilterMode = "all-records" | "people" | "families" | "places" | "everything";

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
  { members: Cell<MemberEntry[]>; index: number }
>((event, { members, index }) => {
  event.stopPropagation?.();

  const current = members.get() || [];
  const entry = current[index];

  // If bidirectional, try to remove reverse link from target
  if (entry?.bidirectional && isRecord(entry.charm)) {
    try {
      const targetCharm = entry.charm as Cell<any>;
      const targetSubCharms = targetCharm.key?.("subCharms")?.get?.() || [];
      const targetMembersEntry = targetSubCharms.find(
        (e: any) => e?.type === "members"
      );

      if (targetMembersEntry?.charm) {
        const targetMembersList = targetMembersEntry.charm.key?.("members")?.get?.() || [];
        // Find reverse link (this record in target's members)
        const reverseIdx = targetMembersList.findIndex((m: MemberEntry) => {
          // Compare by reference or entity ID
          return m?.charm === members ||
                 (m?.charm as any)?.["/"] === (members as any)?.["/"];
        });

        if (reverseIdx >= 0) {
          targetMembersEntry.charm.key("members").set(
            targetMembersList.toSpliced(reverseIdx, 1)
          );
        }
      }
    } catch (e) {
      console.warn("Could not remove reverse link:", e);
    }
  }

  // Remove from local members
  members.set(current.toSpliced(index, 1));
});

/** Add a member from autocomplete selection */
const addMember = handler<
  CustomEvent<{ value: string; label?: string; charmRef?: unknown; isCustom?: boolean }>,
  { members: Cell<MemberEntry[]> }
>((event, { members }) => {
  const { value, charmRef, isCustom } = event.detail || {};

  if (isCustom) {
    // TODO: Create new blank record with the typed name
    console.log("Create new record:", value);
    return;
  }

  // Use charmRef from autocomplete item (already included)
  const charm = charmRef;

  if (!charm) {
    console.warn("Could not find charm for:", value);
    return;
  }

  // Check for duplicates
  const current = members.get() || [];
  const isDuplicate = current.some((m) => m.charm === charm);
  if (isDuplicate) return;

  // Determine if bidirectional (both are records)
  const targetIsRecord = isRecord(charm);
  const bidirectional = targetIsRecord; // TODO: also check if source is record

  // Add to members
  const newEntry: MemberEntry = {
    charm,
    bidirectional,
  };
  members.push(newEntry);

  // If bidirectional, add reverse link to target's members
  if (bidirectional) {
    try {
      const targetCharm = charm as Cell<any>;
      const targetSubCharms = targetCharm.key?.("subCharms")?.get?.() || [];
      const targetMembersEntry = targetSubCharms.find(
        (e: any) => e?.type === "members"
      );

      if (targetMembersEntry?.charm) {
        // Add reverse link - need reference to current record
        // This is tricky - we need the parent record reference
        // For now, log and skip
        console.log("Would add reverse link to target's members");
      }
    } catch (e) {
      console.warn("Could not add reverse link:", e);
    }
  }
});

// ===== The Pattern =====
export const MembersModule = recipe<MembersModuleInput, MembersModuleInput>(
  "MembersModule",
  ({ members }) => {
    // Local state
    const filterMode = Cell.of<FilterMode>("all-records");

    // Get mentionable charms via wish
    const mentionable = wish<Default<MentionableCharm[], []>>("#mentionable");

    // Build autocomplete items from mentionable using lift()
    // lift() properly unwraps OpaqueRefs from wish()
    const autocompleteItems = lift(
      ({ mentionable: all, filterMode: mode }: {
        mentionable: MentionableCharm[];
        filterMode: FilterMode;
      }) => {
        const items = all || [];

        // Filter based on mode
        let filtered: MentionableCharm[];
        switch (mode) {
          case "all-records":
            filtered = items.filter((m: any) => isRecord(m));
            break;
          case "people":
            filtered = items.filter((m: any) => {
              if (!isRecord(m)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(m));
              return inferred.type === "person";
            });
            break;
          case "families":
            filtered = items.filter((m: any) => {
              if (!isRecord(m)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(m));
              return inferred.type === "family";
            });
            break;
          case "places":
            filtered = items.filter((m: any) => {
              if (!isRecord(m)) return false;
              const inferred = inferTypeFromModules(getModuleTypes(m));
              return inferred.type === "place";
            });
            break;
          case "everything":
          default:
            filtered = items;
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
      }
    )({ mentionable, filterMode });

    // Display text for NAME
    const displayText = computed(() => {
      const count = (members || []).length || 0;
      return count > 0 ? `${count} member${count !== 1 ? "s" : ""}` : "No members";
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
              onct-select={addMember({ members })}
              style={{ flex: "1" }}
            />
          </ct-hstack>

          {/* Member chips */}
          <ct-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
            {validMembers.map((entry: MemberEntry, index: number) => {
              const charmIsRecord = isRecord(entry.charm);
              const memberName = getCharmName(entry.charm);

              // Get icon for records
              let icon = "🔗";
              if (charmIsRecord) {
                const inferred = inferTypeFromModules(getModuleTypes(entry.charm));
                icon = inferred.icon;
              }

              return (
                <span
                  key={index}
                  onClick={navigateToMember({ charm: entry.charm })}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    background: charmIsRecord ? "#dbeafe" : "#e5e7eb",
                    borderRadius: "16px",
                    padding: "4px 12px",
                    fontSize: "14px",
                    cursor: "pointer",
                    border: charmIsRecord
                      ? "1px solid #93c5fd"
                      : "1px solid #d1d5db",
                  }}
                >
                  <span style={{ fontSize: "12px" }}>{icon}</span>
                  <span>{memberName}</span>
                  {entry.role && (
                    <span style={{
                      color: "#6b7280",
                      fontSize: "12px",
                      fontStyle: "italic",
                    }}>
                      ({entry.role})
                    </span>
                  )}
                  {entry.bidirectional && (
                    <span style={{ fontSize: "10px", color: "#3b82f6" }}>↔</span>
                  )}
                  <button
                    type="button"
                    onClick={removeMember({ members, index })}
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
