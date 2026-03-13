/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// ===== Types =====

type ReproInput = Record<string, never>;

interface ReproOutput {
  [NAME]: string;
  [UI]: VNode;
}

// ===== Shared style object (BUG) =====
// This single object reference is reused across all siblings.
// The runtime sees the same reference and assumes nothing changed,
// so only the first element actually gets the style applied.
const sharedCardStyle = {
  background: "white",
  borderRadius: "8px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
  padding: "16px",
  borderLeft: "4px solid #3b82f6",
  marginBottom: "8px",
};

// ===== Factory function (FIX) =====
// Returns a fresh object each time, so the runtime sees a new
// reference for every sibling and applies the style correctly.
function makeCardStyle() {
  return {
    background: "white",
    borderRadius: "8px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
    padding: "16px",
    borderLeft: "4px solid #10b981",
    marginBottom: "8px",
  };
}

// ===== Pattern =====

const StyleObjectRepro = pattern<ReproInput, ReproOutput>(() => {
  const bugItems = ["Card A", "Card B", "Card C", "Card D", "Card E"];
  const fixItems = ["Card A", "Card B", "Card C", "Card D", "Card E"];

  return {
    [NAME]: "Style Object Reference Gotcha",
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-heading level={4}>Style Object Reference Gotcha</ct-heading>
        </ct-vstack>

        <ct-vscroll style="flex: 1; padding: 1.5rem;">
          {/* ===== BUG DEMO ===== */}
          <ct-vstack gap="2">
            <ct-heading level={5} style="color: #ef4444;">
              Bug Demo (shared style object)
            </ct-heading>
            <div style="color: var(--ct-color-gray-500); fontSize: 0.875rem; marginBottom: 8px;">
              These boxes share a style object reference — only the first one
              renders correctly:
            </div>
            {bugItems.map((label) => (
              <div style={sharedCardStyle}>
                <span style="fontWeight: 600;">{label}</span>
                <span style="color: var(--ct-color-gray-400); marginLeft: 8px;">
                  — using sharedCardStyle
                </span>
              </div>
            ))}
          </ct-vstack>

          {/* ===== Divider ===== */}
          <div
            style={{
              borderTop: "2px dashed var(--ct-color-gray-300)",
              margin: "8px 0",
            }}
          />

          {/* ===== FIX DEMO ===== */}
          <ct-vstack gap="2">
            <ct-heading level={5} style="color: #10b981;">
              Fix Demo (factory function)
            </ct-heading>
            <div style="color: var(--ct-color-gray-500); fontSize: 0.875rem; marginBottom: 8px;">
              These boxes each get a fresh style object from a factory function
              — all render correctly:
            </div>
            {fixItems.map((label) => (
              <div style={makeCardStyle()}>
                <span style="fontWeight: 600;">{label}</span>
                <span style="color: var(--ct-color-gray-400); marginLeft: 8px;">
                  — using makeCardStyle()
                </span>
              </div>
            ))}
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});

export default StyleObjectRepro;
