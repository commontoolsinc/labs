/// <cts-enable />
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import { Sidebar } from "./ui/sidebar/sidebar.tsx";
import StoryRenderer from "./ui/story-renderer.tsx";

export interface CategoryItem {
  id: string;
  label: string;
}

export interface Category {
  name: string;
  items: CategoryItem[];
}
interface CatalogInput {
  selectedStory?: Writable<Default<string, "button">>;
  categories?: Default<Category[], [
    {
      name: "Overview";
      items: [{ id: "kitchen-sink"; label: "Kitchen Sink" }];
    },
    {
      name: "Inputs";
      items: [
        { id: "button"; label: "Button" },
        { id: "checkbox"; label: "Checkbox" },
        { id: "code-editor"; label: "Code Editor" },
        { id: "input"; label: "Input" },
        { id: "picker"; label: "Picker" },
        { id: "textarea"; label: "Textarea" },
        { id: "select"; label: "Select" },
        { id: "slider"; label: "Slider" },
        { id: "switch"; label: "Switch" },
        { id: "toggle"; label: "Toggle" },
        { id: "toggle-group"; label: "Toggle Group" },
        { id: "message-input"; label: "Message Input" },
        { id: "calendar"; label: "Calendar" },
        { id: "radio"; label: "Radio" },
        { id: "autocomplete"; label: "Autocomplete" },
        { id: "tags"; label: "Tags" },
        { id: "fab"; label: "FAB" },
      ];
    },
    {
      name: "Layout";
      items: [
        { id: "card"; label: "Card" },
        { id: "modal"; label: "Modal" },
        { id: "toolbar"; label: "Toolbar" },
        { id: "vstack"; label: "VStack" },
        { id: "hstack"; label: "HStack" },
        { id: "vgroup"; label: "VGroup" },
        { id: "hgroup"; label: "HGroup" },
        { id: "vscroll"; label: "VScroll" },
        { id: "hscroll"; label: "HScroll" },
        { id: "grid"; label: "Grid" },
      ];
    },
    {
      name: "Display";
      items: [
        { id: "heading"; label: "Heading" },
        { id: "label"; label: "Label" },
        { id: "chip"; label: "Chip" },
        { id: "badge"; label: "Badge" },
        { id: "separator"; label: "Separator" },
        { id: "markdown"; label: "Markdown" },
        { id: "svg"; label: "SVG" },
        { id: "kbd"; label: "Kbd" },
        { id: "code-editor"; label: "Code Editor" },
        { id: "copy-button"; label: "Copy Button" },
      ];
    },
    {
      name: "Feedback";
      items: [
        { id: "progress"; label: "Progress" },
        { id: "loader"; label: "Loader" },
        { id: "skeleton"; label: "Skeleton" },
        { id: "alert"; label: "Alert" },
      ];
    },
    {
      name: "Interactive";
      items: [
        { id: "collapsible"; label: "Collapsible" },
        { id: "tab-list"; label: "Tab List" },
        { id: "tabs"; label: "Tabs" },
        { id: "table"; label: "Table" },
      ];
    },
    {
      name: "Data Visualization";
      items: [{ id: "chart"; label: "Chart" }];
    },
    {
      name: "Patterns";
      items: [{ id: "note"; label: "Note" }];
    },
  ]>;
}

interface CatalogOutput {
  [NAME]: string;
  [UI]: VNode;
  selectedStory: string;
}

const styles = {
  root: {
    display: "flex",
    flex: "1",
    overflow: "hidden",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  main: {
    flex: "1",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  preview: {
    flex: "1",
    overflow: "auto",
    backgroundColor: "#ffffff",
  },
  controls: {
    borderTop: "1px solid #e6e9ed",
    padding: "16px",
    backgroundColor: "#fafafa",
    maxHeight: "400px",
    overflow: "auto",
  },
  controlsHeading: {
    fontSize: "12px",
    fontWeight: "700",
    color: "#798186",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: "12px",
  },
};

export default pattern<CatalogInput, CatalogOutput>(
  ({ selectedStory, categories }) => {
    const selected = computed(() => selectedStory.get());
    const story = StoryRenderer({ selected });

    const handleSelect = action(({ id }: { id: string }) => {
      selectedStory.set(id);
    });

    return {
      [NAME]: "Component Catalog",
      [UI]: (
        <cf-screen>
          <div style={styles.root}>
            <Sidebar
              selected={selected}
              categories={categories}
              onSelect={handleSelect}
            />

            {/* Main content area */}
            <main style={styles.main}>
              {/* Preview */}
              <div style={styles.preview}>
                {story}
              </div>

              {/* Controls panel */}
              <div style={styles.controls}>
                <div style={styles.controlsHeading}>
                  Controls
                </div>
                {story?.controls}
              </div>
            </main>
          </div>
        </cf-screen>
      ),
      selectedStory,
    };
  },
);
