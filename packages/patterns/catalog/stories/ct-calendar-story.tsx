/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SwitchControl, TextControl } from "../ui/controls.tsx";

// deno-lint-ignore no-empty-interface
interface CalendarStoryInput {}
interface CalendarStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CalendarStoryInput, CalendarStoryOutput>(() => {
  const disabled = Writable.of(false);
  const minDate = Writable.of("");
  const maxDate = Writable.of("");

  return {
    [NAME]: "ct-calendar Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            maxWidth: "320px",
            margin: "0 auto",
            padding: "1rem",
          }}
        >
          <ct-calendar
            value="2026-03-13"
            markedDates={[
              "2026-03-10",
              "2026-03-15",
              "2026-03-20",
              "2026-03-25",
            ]}
            disabled={disabled}
            min={minDate}
            max={maxDate}
          />
          <div
            style={{
              fontSize: "0.875rem",
              color: "#6b7280",
              marginTop: "8px",
              textAlign: "center",
            }}
          >
            Selected: 2026-03-13
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SwitchControl
            label="disabled"
            description="Disables date selection"
            defaultValue="false"
            checked={disabled}
          />
          <TextControl
            label="min"
            description="Minimum selectable date (YYYY-MM-DD)"
            defaultValue=""
            value={minDate}
          />
          <TextControl
            label="max"
            description="Maximum selectable date (YYYY-MM-DD)"
            defaultValue=""
            value={maxDate}
          />
        </>
      </Controls>
    ),
  };
});
