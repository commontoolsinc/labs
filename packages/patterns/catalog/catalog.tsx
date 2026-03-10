/// <cts-enable />
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

import Sidebar from "./ui/sidebar.tsx";
import ButtonStory from "./stories/ct-button-story.tsx";
import InputStory from "./stories/ct-input-story.tsx";
import CardStory from "./stories/ct-card-story.tsx";

interface CatalogInput {
  selectedStory?: Writable<Default<string, "button">>;
}

interface CatalogOutput {
  [NAME]: string;
  [UI]: VNode;
  selectedStory: string;
}

export default pattern<CatalogInput, CatalogOutput>(({ selectedStory }) => {
  const selected = computed(() => selectedStory.get());
  const buttonStory = ButtonStory({});
  const inputStory = InputStory({});
  const cardStory = CardStory({});

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
              {selected === "button"
                ? buttonStory
                : selected === "input"
                  ? inputStory
                  : selected === "card"
                    ? cardStory
                    : null}
            </div>

            {/* Controls panel */}
            <div
              style={{
                borderTop: "1px solid #e6e9ed",
                padding: "16px",
                backgroundColor: "#fafafa",
                maxHeight: "250px",
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
              {selected === "button"
                ? buttonStory.controls
                : selected === "input"
                  ? inputStory.controls
                  : selected === "card"
                    ? cardStory.controls
                    : null}
            </div>
          </div>
        </div>
      </ct-screen>
    ),
    selectedStory,
  };
});
