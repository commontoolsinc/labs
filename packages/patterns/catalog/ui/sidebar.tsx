/// <cts-enable />
import {
  computed,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

interface SidebarItem {
  id: string;
  label: string;
}

interface SidebarCategory {
  name: string;
  items: SidebarItem[];
}

interface SidebarInput {
  selected: Writable<string>;
  categories: SidebarCategory[];
}

interface SidebarOutput {
  [NAME]: string;
  [UI]: VNode;
}

const selectItem = handler<
  unknown,
  { id: string; selected: Writable<string> }
>((_event, { id, selected }) => {
  selected.set(id);
});

export default pattern<SidebarInput, SidebarOutput>(
  ({ selected, categories: _categories }) => {
    const current = computed(() => selected.get());

    return {
      [NAME]: "Sidebar",
      [UI]: (
        <div
          style={{
            width: "220px",
            backgroundColor: "#f6f7f9",
            borderRight: "1px solid #e6e9ed",
            overflowY: "auto",
            padding: "16px 0",
            flexShrink: "0",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          }}
        >
          {/* Logo area */}
          <div
            style={{
              padding: "0 16px 16px",
              borderBottom: "1px solid #e6e9ed",
              marginBottom: "12px",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                fontWeight: "700",
                color: "#2e3438",
                letterSpacing: "-0.01em",
              }}
            >
              Component Catalog
            </div>
          </div>

          {/* Inputs */}
          <div style={{ marginBottom: "8px" }}>
            <div
              style={{
                padding: "4px 16px 6px",
                fontSize: "11px",
                fontWeight: "700",
                color: "#798186",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Inputs
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "button" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "button"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "button" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "button", selected })}
            >
              Button
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "checkbox" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "checkbox"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "checkbox" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "checkbox", selected })}
            >
              Checkbox
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "input" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "input"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "input" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "input", selected })}
            >
              Input
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "select" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "select"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "select" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "select", selected })}
            >
              Select
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "switch" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "switch"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "switch" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "switch", selected })}
            >
              Switch
            </div>
          </div>

          {/* Layout */}
          <div style={{ marginBottom: "8px" }}>
            <div
              style={{
                padding: "4px 16px 6px",
                fontSize: "11px",
                fontWeight: "700",
                color: "#798186",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Layout
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "card" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "card" ? "#e8f4fd" : "transparent",
                fontWeight: current === "card" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "card", selected })}
            >
              Card
            </div>
          </div>

          {/* Data Visualization */}
          <div style={{ marginBottom: "8px" }}>
            <div
              style={{
                padding: "4px 16px 6px",
                fontSize: "11px",
                fontWeight: "700",
                color: "#798186",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Data Visualization
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "chart" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "chart"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "chart" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "chart", selected })}
            >
              Chart
            </div>
          </div>

          {/* Patterns */}
          <div style={{ marginBottom: "8px" }}>
            <div
              style={{
                padding: "4px 16px 6px",
                fontSize: "11px",
                fontWeight: "700",
                color: "#798186",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Patterns
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "note" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "note" ? "#e8f4fd" : "transparent",
                fontWeight: current === "note" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "note", selected })}
            >
              Note
            </div>
          </div>
        </div>
      ),
    };
  },
);
