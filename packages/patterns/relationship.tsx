/// <cts-enable />
/**
 * Relationship Module - Pattern for people connections
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Tracks relationship types, closeness, and inner circle status.
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "relationship",
  label: "Relationship",
  icon: "\u{1F465}", // busts in silhouette emoji
  schema: {
    relationTypes: {
      type: "array",
      items: { type: "string" },
      description: "Relationship types",
    },
    closeness: {
      type: "string",
      enum: ["intimate", "close", "casual", "distant"],
      description: "Closeness level",
    },
    howWeMet: { type: "string", description: "How we met" },
    innerCircle: { type: "boolean", description: "Inner circle member" },
  },
  fieldMapping: ["relationTypes", "closeness", "howWeMet", "innerCircle"],
};

// ===== Types =====

/** Closeness level for relationships */
type ClosenessLevel = "intimate" | "close" | "casual" | "distant";

export interface RelationshipModuleInput {
  /** Relationship types (e.g., friend, family, colleague) */
  relationTypes: Default<string[], []>;
  /** Closeness level */
  closeness: Default<ClosenessLevel | "", "">;
  /** How we met */
  howWeMet: Default<string, "">;
  /** Inner circle member */
  innerCircle: Default<boolean, false>;
}

// ===== Constants =====
const RELATION_TYPE_OPTIONS = [
  "friend",
  "family",
  "colleague",
  "neighbor",
  "mentor",
  "mentee",
  "acquaintance",
];

const CLOSENESS_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "intimate", label: "💜 Intimate" },
  { value: "close", label: "💙 Close" },
  { value: "casual", label: "💚 Casual" },
  { value: "distant", label: "🤍 Distant" },
];

// ===== Handlers =====

// Handler to toggle a relation type - type is in context
const toggleRelationType = handler<
  unknown,
  { relationTypes: Writable<string[]>; type: string }
>((_event, { relationTypes, type }) => {
  const current = relationTypes.get() || [];
  if (current.includes(type)) {
    relationTypes.set(current.filter((t) => t !== type));
  } else {
    relationTypes.set([...current, type]);
  }
});

// Handler to toggle inner circle
const toggleInnerCircle = handler<
  unknown,
  { innerCircle: Writable<boolean> }
>((_event, { innerCircle }) => {
  innerCircle.set(!innerCircle.get());
});

// ===== The Pattern =====
export const RelationshipModule = pattern<
  RelationshipModuleInput,
  RelationshipModuleInput
>(
  ({ relationTypes, closeness, howWeMet, innerCircle }) => {
    const displayText = computed(() => {
      const types = relationTypes || [];
      const count = types.length || 0;
      if (count > 0) return types.join(", ");
      const opt = CLOSENESS_OPTIONS.find((o) => o.value === closeness);
      return opt?.label || "Not set";
    });

    return {
      [NAME]: computed(() =>
        `${MODULE_METADATA.icon} Relationship: ${displayText}`
      ),
      [UI]: (
        <ct-vstack style={{ gap: "16px" }}>
          {/* Relation types (multi-select chips) */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Relationship Type(s)
            </label>
            <ct-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
              {RELATION_TYPE_OPTIONS.map((type, index) => {
                const isSelected = computed(() =>
                  (relationTypes || []).some((t: string) => t === type)
                );
                return (
                  <button
                    type="button"
                    key={index}
                    onClick={toggleRelationType({ relationTypes, type })}
                    style={{
                      padding: "6px 12px",
                      borderRadius: "16px",
                      border: isSelected
                        ? "2px solid #3b82f6"
                        : "1px solid #d1d5db",
                      background: isSelected ? "#eff6ff" : "white",
                      color: isSelected ? "#1d4ed8" : "#374151",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    {type}
                  </button>
                );
              })}
            </ct-hstack>
          </ct-vstack>

          {/* Closeness */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Closeness
            </label>
            <ct-select $value={closeness} items={CLOSENESS_OPTIONS} />
          </ct-vstack>

          {/* How we met */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              How We Met
            </label>
            <ct-textarea
              $value={howWeMet}
              placeholder="How did you meet?"
              rows={2}
            />
          </ct-vstack>

          {/* Inner circle toggle */}
          <ct-hstack style={{ alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              onClick={toggleInnerCircle({ innerCircle })}
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "4px",
                border: "1px solid #d1d5db",
                background: innerCircle ? "#3b82f6" : "white",
                color: "white",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "16px",
              }}
            >
              {innerCircle ? "✓" : ""}
            </button>
            <span style={{ fontSize: "14px" }}>Inner Circle ⭐</span>
          </ct-hstack>
        </ct-vstack>
      ),
      relationTypes,
      closeness,
      howWeMet,
      innerCircle,
    };
  },
);

export default RelationshipModule;
