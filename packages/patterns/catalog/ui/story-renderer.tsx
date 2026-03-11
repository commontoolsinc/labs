/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, Writable } from "commontools";

import ButtonStory from "../stories/ct-button-story.tsx";
import CheckboxStory from "../stories/ct-checkbox-story.tsx";
import InputStory from "../stories/ct-input-story.tsx";
import SelectStory from "../stories/ct-select-story.tsx";
import SwitchStory from "../stories/ct-switch-story.tsx";
import CardStory from "../stories/ct-card-story.tsx";
import ModalStory from "../stories/ct-modal-story.tsx";
import ProgressStory from "../stories/ct-progress-story.tsx";
import VStackStory from "../stories/ct-vstack-story.tsx";
import HStackStory from "../stories/ct-hstack-story.tsx";
import VGroupStory from "../stories/ct-vgroup-story.tsx";
import HGroupStory from "../stories/ct-hgroup-story.tsx";
import VScrollStory from "../stories/ct-vscroll-story.tsx";
import HScrollStory from "../stories/ct-hscroll-story.tsx";
import TextareaStory from "../stories/ct-textarea-story.tsx";
import MessageInputStory from "../stories/ct-message-input-story.tsx";
import ToolbarStory from "../stories/ct-toolbar-story.tsx";
import HeadingStory from "../stories/ct-heading-story.tsx";
import LabelStory from "../stories/ct-label-story.tsx";
import ChipStory from "../stories/ct-chip-story.tsx";
import BadgeStory from "../stories/ct-badge-story.tsx";
import SeparatorStory from "../stories/ct-separator-story.tsx";
import MarkdownStory from "../stories/ct-markdown-story.tsx";
import LoaderStory from "../stories/ct-loader-story.tsx";
import SkeletonStory from "../stories/ct-skeleton-story.tsx";
import CollapsibleStory from "../stories/ct-collapsible-story.tsx";
import TabsStory from "../stories/ct-tabs-story.tsx";
import ChartStory from "../stories/ct-chart-story.tsx";
import NoteStory from "../stories/note-story.tsx";

interface StoryRendererInput {
  selected: Writable<string>;
}

interface StoryRendererOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<StoryRendererInput, StoryRendererOutput>(
  ({ selected }) => {
    const story = computed(() => {
      switch (selected.get()) {
        case "button":
          return ButtonStory({});
        case "checkbox":
          return CheckboxStory({});
        case "input":
          return InputStory({});
        case "select":
          return SelectStory({});
        case "switch":
          return SwitchStory({});
        case "card":
          return CardStory({});
        case "modal":
          return ModalStory({});
        case "progress":
          return ProgressStory({});
        case "vstack":
          return VStackStory({});
        case "hstack":
          return HStackStory({});
        case "vgroup":
          return VGroupStory({});
        case "hgroup":
          return HGroupStory({});
        case "vscroll":
          return VScrollStory({});
        case "hscroll":
          return HScrollStory({});
        case "textarea":
          return TextareaStory({});
        case "message-input":
          return MessageInputStory({});
        case "toolbar":
          return ToolbarStory({});
        case "heading":
          return HeadingStory({});
        case "label":
          return LabelStory({});
        case "chip":
          return ChipStory({});
        case "badge":
          return BadgeStory({});
        case "separator":
          return SeparatorStory({});
        case "markdown":
          return MarkdownStory({});
        case "loader":
          return LoaderStory({});
        case "skeleton":
          return SkeletonStory({});
        case "collapsible":
          return CollapsibleStory({});
        case "tabs":
          return TabsStory({});
        case "chart":
          return ChartStory({});
        case "note":
          return NoteStory({});
        default:
          return null;
      }
    });

    return {
      [NAME]: "StoryRenderer",
      [UI]: <>{story}</>,
      controls: <>{story.controls}</>,
    };
  },
);
