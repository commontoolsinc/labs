/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SelectControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface SvgStoryInput {}
interface SvgStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SvgStoryInput, SvgStoryOutput>(() => {
  const icon = Writable.of("sun");

  const content = computed(() => {
    switch (icon.get()) {
      case "moon":
        return `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="60" cy="60" r="48" fill="#0ea5e9"/><path d="M77 30a33 33 0 1 0 13 63 40 40 0 1 1-13-63z" fill="#f8fafc"/></svg>`;
      case "bolt":
        return `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="104" height="104" rx="20" fill="#fef3c7"/><path d="M67 14 33 66h22l-2 40 34-52H65z" fill="#f59e0b"/></svg>`;
      default:
        return `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="104" height="104" rx="20" fill="#dbeafe"/><circle cx="60" cy="60" r="24" fill="#fbbf24"/><path d="M60 18v14M60 88v14M18 60h14M88 60h14M30.3 30.3l10 10M79.7 79.7l10 10M89.7 30.3l-10 10M40.3 79.7l-10 10" stroke="#f59e0b" stroke-width="5" stroke-linecap="round"/></svg>`;
    }
  });

  return {
    [NAME]: "ct-svg Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            width: "140px",
            height: "140px",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "10px",
            backgroundColor: "#ffffff",
          }}
        >
          <ct-svg $content={content} style="width: 100%; height: 100%;" />
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="icon"
            description="Selects the SVG content string"
            defaultValue="sun"
            value={icon as any}
            items={[
              { label: "sun", value: "sun" },
              { label: "moon", value: "moon" },
              { label: "bolt", value: "bolt" },
            ]}
          />
        </>
      </Controls>
    ),
  };
});
