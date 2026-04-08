/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode } from "commonfabric";

import ButtonStory from "../stories/cf-button-story.tsx";
import CheckboxStory from "../stories/cf-checkbox-story.tsx";
import CodeEditorStory from "../stories/cf-code-editor-story.tsx";
import InputStory from "../stories/cf-input-story.tsx";
import PickerStory from "../stories/cf-picker-story.tsx";
import SelectStory from "../stories/cf-select-story.tsx";
import SliderStory from "../stories/cf-slider-story.tsx";
import SwitchStory from "../stories/cf-switch-story.tsx";
import ToggleStory from "../stories/cf-toggle-story.tsx";
import ToggleGroupStory from "../stories/cf-toggle-group-story.tsx";
import CardStory from "../stories/cf-card-story.tsx";
import ModalStory from "../stories/cf-modal-story.tsx";
import ProgressStory from "../stories/cf-progress-story.tsx";
import VStackStory from "../stories/cf-vstack-story.tsx";
import HStackStory from "../stories/cf-hstack-story.tsx";
import VGroupStory from "../stories/cf-vgroup-story.tsx";
import HGroupStory from "../stories/cf-hgroup-story.tsx";
import VScrollStory from "../stories/cf-vscroll-story.tsx";
import HScrollStory from "../stories/cf-hscroll-story.tsx";
import TextareaStory from "../stories/cf-textarea-story.tsx";
import MessageInputStory from "../stories/cf-message-input-story.tsx";
import ToolbarStory from "../stories/cf-toolbar-story.tsx";
import HeadingStory from "../stories/cf-heading-story.tsx";
import LabelStory from "../stories/cf-label-story.tsx";
import ChipStory from "../stories/cf-chip-story.tsx";
import BadgeStory from "../stories/cf-badge-story.tsx";
import AlertStory from "../stories/cf-alert-story.tsx";
import SeparatorStory from "../stories/cf-separator-story.tsx";
import MarkdownStory from "../stories/cf-markdown-story.tsx";
import SvgStory from "../stories/cf-svg-story.tsx";
import LoaderStory from "../stories/cf-loader-story.tsx";
import SkeletonStory from "../stories/cf-skeleton-story.tsx";
import CollapsibleStory from "../stories/cf-collapsible-story.tsx";
import TabListStory from "../stories/cf-tab-list-story.tsx";
import TabsStory from "../stories/cf-tabs-story.tsx";
import ChartStory from "../stories/cf-chart-story.tsx";
import NoteStory from "../stories/note-story.tsx";
import KitchenSinkStory from "../stories/kitchen-sink-story.tsx";
import ChatStory from "../stories/cf-chat-story.tsx";
import CalendarStory from "../stories/cf-calendar-story.tsx";
import RadioStory from "../stories/cf-radio-story.tsx";
import AutocompleteStory from "../stories/cf-autocomplete-story.tsx";
import TableStory from "../stories/cf-table-story.tsx";
import KbdStory from "../stories/cf-kbd-story.tsx";
import CopyButtonStory from "../stories/cf-copy-button-story.tsx";
import TagsStory from "../stories/cf-tags-story.tsx";
import GridStory from "../stories/cf-grid-story.tsx";
import VignetteRecipeStory from "../stories/vignette-recipe-story.tsx";
import VignetteFinanceStory from "../stories/vignette-finance-story.tsx";

interface StoryRendererInput {
  selected: string;
}

interface StoryRendererOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

type CatalogStory = {
  [NAME]: string;
  [UI]: VNode;
  controls?: VNode;
} | null;

export default pattern<StoryRendererInput, StoryRendererOutput>(
  ({ selected }) => {
    const story = computed<CatalogStory>(() => {
      switch (selected) {
        case "button":
          return ButtonStory({});
        case "checkbox":
          return CheckboxStory({});
        case "code-editor":
          return CodeEditorStory({});
        case "input":
          return InputStory({});
        case "picker":
          return PickerStory({});
        case "select":
          return SelectStory({});
        case "slider":
          return SliderStory({});
        case "switch":
          return SwitchStory({});
        case "toggle":
          return ToggleStory({});
        case "toggle-group":
          return ToggleGroupStory({});
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
        case "alert":
          return AlertStory({});
        case "separator":
          return SeparatorStory({});
        case "markdown":
          return MarkdownStory({});
        case "svg":
          return SvgStory({});
        case "loader":
          return LoaderStory({});
        case "skeleton":
          return SkeletonStory({});
        case "collapsible":
          return CollapsibleStory({});
        case "tab-list":
          return TabListStory({});
        case "tabs":
          return TabsStory({});
        case "chart":
          return ChartStory({});
        case "note":
          return NoteStory({});
        case "kitchen-sink":
          return KitchenSinkStory({});
        case "chat":
          return ChatStory({});
        case "calendar":
          return CalendarStory({});
        case "radio":
          return RadioStory({});
        case "autocomplete":
          return AutocompleteStory({});
        case "table":
          return TableStory({});
        case "kbd":
          return KbdStory({});
        case "copy-button":
          return CopyButtonStory({});
        case "tags":
          return TagsStory({});
        case "grid":
          return GridStory({});
        case "vignette-recipe":
          return VignetteRecipeStory({});
        case "vignette-finance":
          return VignetteFinanceStory({});
        default:
          return null;
      }
    });

    return {
      [NAME]: "StoryRenderer",
      [UI]: <>{story}</>,
      controls: <>{story?.controls ?? null}</>,
    };
  },
);
