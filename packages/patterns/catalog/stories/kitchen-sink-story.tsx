/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

import ButtonStory from "./ct-button-story.tsx";
import CheckboxStory from "./ct-checkbox-story.tsx";
import CodeEditorStory from "./ct-code-editor-story.tsx";
import InputStory from "./ct-input-story.tsx";
import SelectStory from "./ct-select-story.tsx";
import SwitchStory from "./ct-switch-story.tsx";
import CardStory from "./ct-card-story.tsx";
import ModalStory from "./ct-modal-story.tsx";
import ProgressStory from "./ct-progress-story.tsx";
import VStackStory from "./ct-vstack-story.tsx";
import HStackStory from "./ct-hstack-story.tsx";
import VGroupStory from "./ct-vgroup-story.tsx";
import HGroupStory from "./ct-hgroup-story.tsx";
import VScrollStory from "./ct-vscroll-story.tsx";
import HScrollStory from "./ct-hscroll-story.tsx";
import TextareaStory from "./ct-textarea-story.tsx";
import MessageInputStory from "./ct-message-input-story.tsx";
import ToolbarStory from "./ct-toolbar-story.tsx";
import HeadingStory from "./ct-heading-story.tsx";
import LabelStory from "./ct-label-story.tsx";
import ChipStory from "./ct-chip-story.tsx";
import BadgeStory from "./ct-badge-story.tsx";
import SeparatorStory from "./ct-separator-story.tsx";
import MarkdownStory from "./ct-markdown-story.tsx";
import LoaderStory from "./ct-loader-story.tsx";
import SkeletonStory from "./ct-skeleton-story.tsx";
import CollapsibleStory from "./ct-collapsible-story.tsx";
import TabsStory from "./ct-tabs-story.tsx";
import ChartStory from "./ct-chart-story.tsx";

// deno-lint-ignore no-empty-interface
interface KitchenSinkStoryInput {}
interface KitchenSinkStoryOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<KitchenSinkStoryInput, KitchenSinkStoryOutput>(() => {
  const sections = [
    { label: "Button", node: ButtonStory({}) },
    { label: "Checkbox", node: CheckboxStory({}) },
    { label: "Code Editor", node: CodeEditorStory({}) },
    { label: "Input", node: InputStory({}) },
    { label: "Select", node: SelectStory({}) },
    { label: "Switch", node: SwitchStory({}) },
    { label: "Card", node: CardStory({}) },
    { label: "Modal", node: ModalStory({}) },
    { label: "Progress", node: ProgressStory({}) },
    { label: "VStack", node: VStackStory({}) },
    { label: "HStack", node: HStackStory({}) },
    { label: "VGroup", node: VGroupStory({}) },
    { label: "HGroup", node: HGroupStory({}) },
    { label: "VScroll", node: VScrollStory({}) },
    { label: "HScroll", node: HScrollStory({}) },
    { label: "Textarea", node: TextareaStory({}) },
    { label: "Message Input", node: MessageInputStory({}) },
    { label: "Toolbar", node: ToolbarStory({}) },
    { label: "Heading", node: HeadingStory({}) },
    { label: "Label", node: LabelStory({}) },
    { label: "Chip", node: ChipStory({}) },
    { label: "Badge", node: BadgeStory({}) },
    { label: "Separator", node: SeparatorStory({}) },
    { label: "Markdown", node: MarkdownStory({}) },
    { label: "Loader", node: LoaderStory({}) },
    { label: "Skeleton", node: SkeletonStory({}) },
    { label: "Collapsible", node: CollapsibleStory({}) },
    { label: "Tabs", node: TabsStory({}) },
    { label: "Chart", node: ChartStory({}) },
  ];

  return {
    [NAME]: "Kitchen Sink Story",
    [UI]: (
      <div style={{ padding: "1rem 1rem 4rem" }}>
        <div
          style={{
            marginBottom: "1rem",
            color: "#334155",
            fontSize: "14px",
          }}
        >
          All catalog component stories in one place.
        </div>
        {sections.map((section) => (
          <div
            style={{
              marginBottom: "1.5rem",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              overflow: "hidden",
              backgroundColor: "#ffffff",
            }}
          >
            <div
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid #e2e8f0",
                fontSize: "12px",
                fontWeight: "700",
                color: "#475569",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                backgroundColor: "#f8fafc",
              }}
            >
              {section.label}
            </div>
            <div style={{ padding: "12px" }}>{section.node}</div>
          </div>
        ))}
      </div>
    ),
  };
});
