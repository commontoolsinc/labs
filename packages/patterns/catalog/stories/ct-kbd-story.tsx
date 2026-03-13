/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface KbdStoryInput {}
interface KbdStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<KbdStoryInput, KbdStoryOutput>(() => {
  return {
    [NAME]: "ct-kbd Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ct-kbd>⌘</ct-kbd>
          <ct-kbd>C</ct-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>Copy</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ct-kbd>⌘</ct-kbd>
          <ct-kbd>V</ct-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>Paste</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ct-kbd>⌘</ct-kbd>
          <ct-kbd>Shift</ct-kbd>
          <ct-kbd>P</ct-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            Command Palette
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ct-kbd>Ctrl</ct-kbd>
          <ct-kbd>Alt</ct-kbd>
          <ct-kbd>Del</ct-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            Task Manager
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ct-kbd>Esc</ct-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>Close</span>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Inline keyboard hint element for displaying
        shortcuts.
      </div>
    ),
  };
});
