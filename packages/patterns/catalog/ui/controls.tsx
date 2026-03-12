/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

// ============================================================
// Controls wrapper — provides the table chrome
// ============================================================

interface ControlsInput {
  children?: VNode;
}

interface ControlsOutput {
  [NAME]: string;
  [UI]: VNode;
}

export const Controls = pattern<ControlsInput, ControlsOutput>(
  ({ children }) => {
    return {
      [NAME]: "Controls",
      [UI]: (
        <div>
          {/* Table header */}
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid #e6e9ed",
              padding: "8px 0",
              fontSize: "11px",
              fontWeight: "700",
              color: "#798186",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            <div style={{ width: "140px", padding: "0 12px" }}>Name</div>
            <div style={{ flex: "1", padding: "0 12px" }}>Description</div>
            <div style={{ width: "100px", padding: "0 12px" }}>Default</div>
            <div style={{ width: "200px", padding: "0 12px" }}>Control</div>
          </div>
          {/* Rows */}
          {children}
        </div>
      ),
    };
  },
);

// ============================================================
// SelectControl — dropdown row
// ============================================================

interface SelectControlInput {
  label: string;
  description?: string;
  defaultValue?: string;
  value: Writable<unknown>;
  items: { label: string; value: unknown }[];
}

interface SelectControlOutput {
  [NAME]: string;
  [UI]: VNode;
}

export const SelectControl = pattern<SelectControlInput, SelectControlOutput>(
  ({ label, description, defaultValue, value, items }) => {
    return {
      [NAME]: "SelectControl",
      [UI]: (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderBottom: "1px solid #f0f1f3",
            padding: "10px 0",
            fontSize: "13px",
          }}
        >
          <div
            style={{
              width: "140px",
              padding: "0 12px",
              fontWeight: "600",
              color: "#2e3438",
            }}
          >
            {label}
          </div>
          <div
            style={{
              flex: "1",
              padding: "0 12px",
              color: "#798186",
              fontSize: "12px",
            }}
          >
            {description}
          </div>
          <div
            style={{
              width: "100px",
              padding: "0 12px",
              color: "#798186",
              fontSize: "12px",
              fontFamily: "monospace",
            }}
          >
            {defaultValue}
          </div>
          <div style={{ width: "200px", padding: "0 12px" }}>
            <ct-select $value={value} items={items} style="width: 100%;" />
          </div>
        </div>
      ),
    };
  },
);

// ============================================================
// SwitchControl — boolean toggle row
// ============================================================

interface SwitchControlInput {
  label: string;
  description?: string;
  defaultValue?: string;
  checked: Writable<boolean>;
}

interface SwitchControlOutput {
  [NAME]: string;
  [UI]: VNode;
}

export const SwitchControl = pattern<SwitchControlInput, SwitchControlOutput>(
  ({ label, description, defaultValue, checked }) => {
    return {
      [NAME]: "SwitchControl",
      [UI]: (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderBottom: "1px solid #f0f1f3",
            padding: "10px 0",
            fontSize: "13px",
          }}
        >
          <div
            style={{
              width: "140px",
              padding: "0 12px",
              fontWeight: "600",
              color: "#2e3438",
            }}
          >
            {label}
          </div>
          <div
            style={{
              flex: "1",
              padding: "0 12px",
              color: "#798186",
              fontSize: "12px",
            }}
          >
            {description}
          </div>
          <div
            style={{
              width: "100px",
              padding: "0 12px",
              color: "#798186",
              fontSize: "12px",
              fontFamily: "monospace",
            }}
          >
            {defaultValue}
          </div>
          <div style={{ width: "200px", padding: "0 12px" }}>
            <ct-switch $checked={checked} />
          </div>
        </div>
      ),
    };
  },
);

// ============================================================
// TextControl — text input row
// ============================================================

interface TextControlInput {
  label: string;
  description?: string;
  defaultValue?: string;
  value: Writable<string>;
}

interface TextControlOutput {
  [NAME]: string;
  [UI]: VNode;
}

export const TextControl = pattern<TextControlInput, TextControlOutput>(
  ({ label, description, defaultValue, value }) => {
    return {
      [NAME]: "TextControl",
      [UI]: (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderBottom: "1px solid #f0f1f3",
            padding: "10px 0",
            fontSize: "13px",
          }}
        >
          <div
            style={{
              width: "140px",
              padding: "0 12px",
              fontWeight: "600",
              color: "#2e3438",
            }}
          >
            {label}
          </div>
          <div
            style={{
              flex: "1",
              padding: "0 12px",
              color: "#798186",
              fontSize: "12px",
            }}
          >
            {description}
          </div>
          <div
            style={{
              width: "100px",
              padding: "0 12px",
              color: "#798186",
              fontSize: "12px",
              fontFamily: "monospace",
            }}
          >
            {defaultValue}
          </div>
          <div style={{ width: "200px", padding: "0 12px" }}>
            <ct-input $value={value} style="width: 100%;" />
          </div>
        </div>
      ),
    };
  },
);
