/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";
import { Controls, SwitchControl } from "../ui/controls/controls.tsx";

// deno-lint-ignore no-empty-interface
interface LoaderStoryInput {}
interface LoaderStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<LoaderStoryInput, LoaderStoryOutput>(() => {
  const showElapsed = Writable.of(false);

  return {
    [NAME]: "ct-loader Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "12px",
              color: "#2e3438",
            }}
          >
            Sizes
          </div>
          <div style={{ display: "flex", gap: "24px", alignItems: "center" }}>
            <ct-vstack gap="1" align="center">
              <ct-loader size="sm" show-elapsed={showElapsed} />
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                sm
              </span>
            </ct-vstack>
            <ct-vstack gap="1" align="center">
              <ct-loader size="md" show-elapsed={showElapsed} />
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                md
              </span>
            </ct-vstack>
            <ct-vstack gap="1" align="center">
              <ct-loader size="lg" show-elapsed={showElapsed} />
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                lg
              </span>
            </ct-vstack>
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <SwitchControl
          label="show-elapsed"
          description="Show elapsed time"
          defaultValue="false"
          checked={showElapsed}
        />
      </Controls>
    ),
  };
});
