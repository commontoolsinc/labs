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
  // NOTE: categories prop is intentionally unused. Sidebar items are hardcoded
  // because passing dynamic items as sub-pattern props makes `id` a reactive
  // cell, which breaks handler bindings (selected.set(id) sets a cell ref, not
  // the string value).
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

          {/* Overview */}
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
              Overview
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "kitchen-sink" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "kitchen-sink"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "kitchen-sink" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "kitchen-sink", selected })}
            >
              Kitchen Sink
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
                color: current === "code-editor" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "code-editor"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "code-editor" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "code-editor", selected })}
            >
              Code Editor
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
                color: current === "picker" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "picker"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "picker" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "picker", selected })}
            >
              Picker
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "textarea" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "textarea"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "textarea" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "textarea", selected })}
            >
              Textarea
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
                color: current === "slider" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "slider"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "slider" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "slider", selected })}
            >
              Slider
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
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "toggle" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "toggle"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "toggle" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "toggle", selected })}
            >
              Toggle
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "toggle-group" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "toggle-group"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "toggle-group" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "toggle-group", selected })}
            >
              Toggle Group
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "message-input" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "message-input"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "message-input" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "message-input", selected })}
            >
              Message Input
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
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "modal" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "modal"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "modal" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "modal", selected })}
            >
              Modal
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "toolbar" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "toolbar"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "toolbar" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "toolbar", selected })}
            >
              Toolbar
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "vstack" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "vstack"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "vstack" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "vstack", selected })}
            >
              VStack
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "hstack" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "hstack"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "hstack" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "hstack", selected })}
            >
              HStack
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "vgroup" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "vgroup"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "vgroup" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "vgroup", selected })}
            >
              VGroup
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "hgroup" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "hgroup"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "hgroup" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "hgroup", selected })}
            >
              HGroup
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "vscroll" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "vscroll"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "vscroll" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "vscroll", selected })}
            >
              VScroll
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "hscroll" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "hscroll"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "hscroll" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "hscroll", selected })}
            >
              HScroll
            </div>
          </div>

          {/* Display */}
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
              Display
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "heading" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "heading"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "heading" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "heading", selected })}
            >
              Heading
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "label" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "label"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "label" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "label", selected })}
            >
              Label
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "chip" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "chip" ? "#e8f4fd" : "transparent",
                fontWeight: current === "chip" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "chip", selected })}
            >
              Chip
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "badge" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "badge"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "badge" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "badge", selected })}
            >
              Badge
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "separator" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "separator"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "separator" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "separator", selected })}
            >
              Separator
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "markdown" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "markdown"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "markdown" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "markdown", selected })}
            >
              Markdown
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "svg" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "svg" ? "#e8f4fd" : "transparent",
                fontWeight: current === "svg" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "svg", selected })}
            >
              SVG
            </div>
          </div>

          {/* Feedback */}
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
              Feedback
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "alert" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "alert"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "alert" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "alert", selected })}
            >
              Alert
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "progress" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "progress"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "progress" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "progress", selected })}
            >
              Progress
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "loader" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "loader"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "loader" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "loader", selected })}
            >
              Loader
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "skeleton" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "skeleton"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "skeleton" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "skeleton", selected })}
            >
              Skeleton
            </div>
          </div>

          {/* Interactive */}
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
              Interactive
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "collapsible" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "collapsible"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "collapsible" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "collapsible", selected })}
            >
              Collapsible
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "tab-list" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "tab-list"
                  ? "#e8f4fd"
                  : "transparent",
                fontWeight: current === "tab-list" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "tab-list", selected })}
            >
              Tab List
            </div>
            <div
              style={{
                padding: "4px 12px",
                margin: "1px 8px",
                borderRadius: "4px",
                fontSize: "13px",
                color: current === "tabs" ? "#1ea7fd" : "#2e3438",
                backgroundColor: current === "tabs" ? "#e8f4fd" : "transparent",
                fontWeight: current === "tabs" ? "600" : "400",
                cursor: "pointer",
              }}
              onClick={selectItem({ id: "tabs", selected })}
            >
              Tabs
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
