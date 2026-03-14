/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface HGroupStoryInput {}
interface HGroupStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<HGroupStoryInput, HGroupStoryOutput>(() => {
  const gap = Writable.of<"sm" | "md" | "lg">("md");
  const wrap = Writable.of(false);

  return {
    [NAME]: "ct-hgroup Story",
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
          <ct-hgroup gap={gap} wrap={wrap}>
            <ct-card>
              <span>Card A</span>
            </ct-card>
            <ct-card>
              <span>Card B</span>
            </ct-card>
            <ct-card>
              <span>Card C</span>
            </ct-card>
          </ct-hgroup>
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
          <ct-vstack gap="2">
            <ct-vstack gap="1">
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                gap=sm
              </span>
              <ct-hgroup gap="sm">
                <ct-card>
                  <span>A</span>
                </ct-card>
                <ct-card>
                  <span>B</span>
                </ct-card>
                <ct-card>
                  <span>C</span>
                </ct-card>
              </ct-hgroup>
            </ct-vstack>
            <ct-vstack gap="1">
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                gap=md
              </span>
              <ct-hgroup gap="md">
                <ct-card>
                  <span>A</span>
                </ct-card>
                <ct-card>
                  <span>B</span>
                </ct-card>
                <ct-card>
                  <span>C</span>
                </ct-card>
              </ct-hgroup>
            </ct-vstack>
            <ct-vstack gap="1">
              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                gap=lg
              </span>
              <ct-hgroup gap="lg">
                <ct-card>
                  <span>A</span>
                </ct-card>
                <ct-card>
                  <span>B</span>
                </ct-card>
                <ct-card>
                  <span>C</span>
                </ct-card>
              </ct-hgroup>
            </ct-vstack>
          </ct-vstack>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
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
          <SwitchControl
            label="wrap"
            description="Wrap items to next line"
            defaultValue="false"
            checked={wrap}
          />
        </>
      </Controls>
    ),
  };
});
