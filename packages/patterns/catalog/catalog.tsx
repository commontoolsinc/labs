/// <cts-enable />
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

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

const selectStory = handler<
  unknown,
  { id: string; selectedStory: Writable<string> }
>((_event, { id, selectedStory }) => {
  selectedStory.set(id);
});

export default pattern<CatalogInput, CatalogOutput>(({ selectedStory }) => {
  const selected = computed(() => selectedStory.get());
  return {
    [NAME]: "Component Catalog",
    [UI]: (
      <ct-screen>
        <ct-hstack
          slot="header"
          gap="2"
          align="center"
          style="padding: 0 1rem;"
        >
          <ct-heading level={4}>Component Catalog</ct-heading>
        </ct-hstack>

        <div style={{ display: "flex", flex: "1", overflow: "hidden" }}>
          {/* Sidebar */}
          <div
            style={{
              width: "200px",
              borderRight: "1px solid var(--ct-color-gray-200)",
              overflowY: "auto",
              padding: "0.5rem",
              flexShrink: "0",
            }}
          >
            <ct-vstack gap="3">
              <ct-vstack gap="1">
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: "600",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--ct-color-gray-400)",
                    padding: "0 0.5rem",
                  }}
                >
                  Inputs
                </span>
                <ct-button
                  variant={selected === "button" ? "primary" : "ghost"}
                  onClick={selectStory({ id: "button", selectedStory })}
                  style="justify-content: flex-start; width: 100%;"
                >
                  ct-button
                </ct-button>
                <ct-button
                  variant={selected === "input" ? "primary" : "ghost"}
                  onClick={selectStory({ id: "input", selectedStory })}
                  style="justify-content: flex-start; width: 100%;"
                >
                  ct-input
                </ct-button>
              </ct-vstack>
              <ct-vstack gap="1">
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: "600",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--ct-color-gray-400)",
                    padding: "0 0.5rem",
                  }}
                >
                  Layout
                </span>
                <ct-button
                  variant={selected === "card" ? "primary" : "ghost"}
                  onClick={selectStory({ id: "card", selectedStory })}
                  style="justify-content: flex-start; width: 100%;"
                >
                  ct-card
                </ct-button>
              </ct-vstack>
            </ct-vstack>
          </div>

          {/* Main content area */}
          <ct-vscroll flex showScrollbar fadeEdges style="flex: 1;">
            {/* This seems a bit gross :\ */}
            {selected === "button"
              ? ButtonStory({})
              : selected === "input"
              ? InputStory({})
              : selected === "card"
              ? CardStory({})
              : null}
          </ct-vscroll>
        </div>
      </ct-screen>
    ),
    selectedStory,
  };
});
