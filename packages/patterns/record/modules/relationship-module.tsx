/// <cts-enable />
/**
 * Relationship Module - Sub-charm for people connections
 */
import { Cell, computed, type Default, handler, NAME, recipe, UI } from "commontools";

export interface RelationshipModuleInput {
  relationTypes: Default<string[], []>;
  closeness: Default<string, "">;
  howWeMet: Default<string, "">;
  innerCircle: Default<boolean, false>;
}

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

// Handler to toggle a relation type - type is in context
const toggleRelationType = handler<
  unknown,
  { relationTypes: Cell<string[]>; type: string }
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
  { innerCircle: Cell<boolean> }
>((_event, { innerCircle }) => {
  innerCircle.set(!innerCircle.get());
});

export const RelationshipModule = recipe<RelationshipModuleInput, RelationshipModuleInput>(
  "RelationshipModule",
  ({ relationTypes, closeness, howWeMet, innerCircle }) => {
    const displayText = computed(() => {
      const types = relationTypes || [];
      const count = types.length || 0;
      if (count > 0) return types.join(", ");
      const opt = CLOSENESS_OPTIONS.find((o) => o.value === closeness);
      return opt?.label || "Not set";
    });

    return {
      [NAME]: computed(() => `👥 Relationship: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "16px" }}>
          {/* Relation types (multi-select chips) */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Relationship Type(s)
            </label>
            <ct-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
              {RELATION_TYPE_OPTIONS.map((type, index) => {
                const isSelected = computed(() => (relationTypes || []).some((t: string) => t === type));
                return (
                  <button
                    key={index}
                    onClick={toggleRelationType({ relationTypes, type })}
                    style={{
                      padding: "6px 12px",
                      borderRadius: "16px",
                      border: isSelected ? "2px solid #3b82f6" : "1px solid #d1d5db",
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
  }
);

export default RelationshipModule;
