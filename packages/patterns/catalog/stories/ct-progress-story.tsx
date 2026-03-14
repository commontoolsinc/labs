/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SwitchControl } from "../ui/controls/controls.tsx";

// deno-lint-ignore no-empty-interface
interface ProgressStoryInput {}
interface ProgressStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ProgressStoryInput, ProgressStoryOutput>(() => {
  const indeterminate = Writable.of(false);

  return {
    [NAME]: "ct-progress Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <ct-vstack gap="1">
          <span style="font-weight: 600;">Interactive</span>
          <ct-progress value={65} max={100} indeterminate={indeterminate} />
        </ct-vstack>

        <ct-vstack gap="1">
          <span style="font-weight: 600;">Various Values</span>
          <ct-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--ct-color-gray-500); width: 30px;">
              0%
            </span>
            <div style={{ flex: "1" }}>
              <ct-progress value={0} max={100} />
            </div>
          </ct-hstack>
          <ct-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--ct-color-gray-500); width: 30px;">
              25%
            </span>
            <div style={{ flex: "1" }}>
              <ct-progress value={25} max={100} />
            </div>
          </ct-hstack>
          <ct-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--ct-color-gray-500); width: 30px;">
              50%
            </span>
            <div style={{ flex: "1" }}>
              <ct-progress value={50} max={100} />
            </div>
          </ct-hstack>
          <ct-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--ct-color-gray-500); width: 30px;">
              75%
            </span>
            <div style={{ flex: "1" }}>
              <ct-progress value={75} max={100} />
            </div>
          </ct-hstack>
          <ct-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--ct-color-gray-500); width: 30px;">
              100%
            </span>
            <div style={{ flex: "1" }}>
              <ct-progress value={100} max={100} />
            </div>
          </ct-hstack>
        </ct-vstack>

        <ct-vstack gap="1">
          <span style="font-weight: 600;">Indeterminate</span>
          <ct-progress indeterminate />
        </ct-vstack>
      </div>
    ),
    controls: (
      <Controls>
        <SwitchControl
          label="indeterminate"
          description="Show indeterminate animation (interactive bar)"
          defaultValue="false"
          checked={indeterminate}
        />
      </Controls>
    ),
  };
});
