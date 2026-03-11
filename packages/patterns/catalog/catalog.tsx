/// <cts-enable />
import { Default, NAME, pattern, UI, type VNode, Writable } from "commontools";

import Sidebar from "./ui/sidebar.tsx";
import StoryRenderer from "./ui/story-renderer.tsx";

interface CatalogInput {
  selectedStory?: Writable<Default<string, "button">>;
}

interface CatalogOutput {
  [NAME]: string;
  [UI]: VNode;
  selectedStory: string;
}

export default pattern<CatalogInput, CatalogOutput>(({ selectedStory }) => {
  const stories = StoryRenderer({ selected: selectedStory });

  return {
    [NAME]: "Component Catalog",
    [UI]: (
      <ct-screen>
        <div
          style={{
            display: "flex",
            flex: "1",
            overflow: "hidden",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          }}
        >
          <Sidebar
            selected={selectedStory}
            categories={[
              {
                name: "Inputs",
                items: [
                  { id: "button", label: "Button" },
                  { id: "checkbox", label: "Checkbox" },
                  { id: "input", label: "Input" },
                  { id: "textarea", label: "Textarea" },
                  { id: "select", label: "Select" },
                  { id: "switch", label: "Switch" },
                  { id: "message-input", label: "Message Input" },
                  { id: "fab", label: "FAB" },
                ],
              },
              {
                name: "Layout",
                items: [
                  { id: "card", label: "Card" },
                  { id: "modal", label: "Modal" },
                  { id: "toolbar", label: "Toolbar" },
                  { id: "vstack", label: "VStack" },
                  { id: "hstack", label: "HStack" },
                  { id: "vgroup", label: "VGroup" },
                  { id: "hgroup", label: "HGroup" },
                  { id: "vscroll", label: "VScroll" },
                  { id: "hscroll", label: "HScroll" },
                ],
              },
              {
                name: "Display",
                items: [
                  { id: "heading", label: "Heading" },
                  { id: "label", label: "Label" },
                  { id: "chip", label: "Chip" },
                  { id: "badge", label: "Badge" },
                  { id: "separator", label: "Separator" },
                  { id: "markdown", label: "Markdown" },
                ],
              },
              {
                name: "Feedback",
                items: [
                  { id: "progress", label: "Progress" },
                  { id: "loader", label: "Loader" },
                  { id: "skeleton", label: "Skeleton" },
                ],
              },
              {
                name: "Interactive",
                items: [
                  { id: "collapsible", label: "Collapsible" },
                  { id: "tabs", label: "Tabs" },
                ],
              },
              {
                name: "Data Visualization",
                items: [{ id: "chart", label: "Chart" }],
              },
              {
                name: "Patterns",
                items: [{ id: "note", label: "Note" }],
              },
            ]}
          />

          {/* Main content area */}
          <div
            style={{
              flex: "1",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Preview */}
            <div
              style={{
                flex: "1",
                overflow: "auto",
                backgroundColor: "#ffffff",
              }}
            >
              {stories}
            </div>

            {/* Controls panel */}
            <div
              style={{
                borderTop: "1px solid #e6e9ed",
                padding: "16px",
                backgroundColor: "#fafafa",
                maxHeight: "400px",
                overflow: "auto",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  color: "#798186",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: "12px",
                }}
              >
                Controls
              </div>
              {stories.controls}
            </div>
          </div>
        </div>
      </ct-screen>
    ),
    selectedStory,
  };
});
