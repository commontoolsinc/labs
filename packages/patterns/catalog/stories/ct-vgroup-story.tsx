/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SelectControl } from "../ui/controls.tsx";

// deno-lint-ignore no-empty-interface
interface VGroupStoryInput {}
interface VGroupStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<VGroupStoryInput, VGroupStoryOutput>(() => {
  const gap = Writable.of<"sm" | "md" | "lg">("md");

  return {
    [NAME]: "ct-vgroup Story",
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
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Interactive
          </div>
          <ct-vgroup gap={gap}>
            <ct-card>
              <span>First card in group</span>
            </ct-card>
            <ct-card>
              <span>Second card in group</span>
            </ct-card>
            <ct-card>
              <span>Third card in group</span>
            </ct-card>
          </ct-vgroup>
        </div>

        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Gap Sizes
          </div>
          <ct-hstack gap="4">
            <ct-vstack gap="1" style="flex: 1;">
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                gap=sm
              </span>
              <ct-vgroup gap="sm">
                <ct-card>
                  <span>A</span>
                </ct-card>
                <ct-card>
                  <span>B</span>
                </ct-card>
                <ct-card>
                  <span>C</span>
                </ct-card>
              </ct-vgroup>
            </ct-vstack>
            <ct-vstack gap="1" style="flex: 1;">
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                gap=md
              </span>
              <ct-vgroup gap="md">
                <ct-card>
                  <span>A</span>
                </ct-card>
                <ct-card>
                  <span>B</span>
                </ct-card>
                <ct-card>
                  <span>C</span>
                </ct-card>
              </ct-vgroup>
            </ct-vstack>
            <ct-vstack gap="1" style="flex: 1;">
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                gap=lg
              </span>
              <ct-vgroup gap="lg">
                <ct-card>
                  <span>A</span>
                </ct-card>
                <ct-card>
                  <span>B</span>
                </ct-card>
                <ct-card>
                  <span>C</span>
                </ct-card>
              </ct-vgroup>
            </ct-vstack>
          </ct-hstack>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <SelectControl
          label="gap"
          description="Space between grouped items"
          defaultValue="md"
          value={gap}
          items={[
            { label: "Small", value: "sm" },
            { label: "Medium", value: "md" },
            { label: "Large", value: "lg" },
          ]}
        />
      </Controls>
    ),
  };
});
