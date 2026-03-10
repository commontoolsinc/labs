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
                  { id: "input", label: "Input" },
                ],
              },
              {
                name: "Layout",
                items: [{ id: "card", label: "Card" }],
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
