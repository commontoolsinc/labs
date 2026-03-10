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
import FabStory from "../stories/ct-fab-story.tsx";
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
    const s = computed(() => selected.get());
    const buttonStory = ButtonStory({});
    const checkboxStory = CheckboxStory({});
    const inputStory = InputStory({});
    const selectStory = SelectStory({});
    const switchStory = SwitchStory({});
    const cardStory = CardStory({});
    const modalStory = ModalStory({});
    const progressStory = ProgressStory({});
    const vstackStory = VStackStory({});
    const hstackStory = HStackStory({});
    const vgroupStory = VGroupStory({});
    const hgroupStory = HGroupStory({});
    const vscrollStory = VScrollStory({});
    const hscrollStory = HScrollStory({});
    const textareaStory = TextareaStory({});
    const messageInputStory = MessageInputStory({});
    const fabStory = FabStory({});
    const toolbarStory = ToolbarStory({});
    const headingStory = HeadingStory({});
    const labelStory = LabelStory({});
    const chipStory = ChipStory({});
    const badgeStory = BadgeStory({});
    const separatorStory = SeparatorStory({});
    const markdownStory = MarkdownStory({});
    const loaderStory = LoaderStory({});
    const skeletonStory = SkeletonStory({});
    const collapsibleStory = CollapsibleStory({});
    const tabsStory = TabsStory({});
    const chartStory = ChartStory({});
    const noteStory = NoteStory({});

    return {
      [NAME]: "StoryRenderer",
      [UI]: (
        <>
          {s === "button" ? buttonStory : null}
          {s === "checkbox" ? checkboxStory : null}
          {s === "input" ? inputStory : null}
          {s === "select" ? selectStory : null}
          {s === "switch" ? switchStory : null}
          {s === "card" ? cardStory : null}
          {s === "modal" ? modalStory : null}
          {s === "progress" ? progressStory : null}
          {s === "vstack" ? vstackStory : null}
          {s === "hstack" ? hstackStory : null}
          {s === "vgroup" ? vgroupStory : null}
          {s === "hgroup" ? hgroupStory : null}
          {s === "vscroll" ? vscrollStory : null}
          {s === "hscroll" ? hscrollStory : null}
          {s === "textarea" ? textareaStory : null}
          {s === "message-input" ? messageInputStory : null}
          {s === "fab" ? fabStory : null}
          {s === "toolbar" ? toolbarStory : null}
          {s === "heading" ? headingStory : null}
          {s === "label" ? labelStory : null}
          {s === "chip" ? chipStory : null}
          {s === "badge" ? badgeStory : null}
          {s === "separator" ? separatorStory : null}
          {s === "markdown" ? markdownStory : null}
          {s === "loader" ? loaderStory : null}
          {s === "skeleton" ? skeletonStory : null}
          {s === "collapsible" ? collapsibleStory : null}
          {s === "tabs" ? tabsStory : null}
          {s === "chart" ? chartStory : null}
          {s === "note" ? noteStory : null}
        </>
      ),
      controls: (
        <>
          {s === "button" ? buttonStory.controls : null}
          {s === "checkbox" ? checkboxStory.controls : null}
          {s === "input" ? inputStory.controls : null}
          {s === "select" ? selectStory.controls : null}
          {s === "switch" ? switchStory.controls : null}
          {s === "card" ? cardStory.controls : null}
          {s === "modal" ? modalStory.controls : null}
          {s === "progress" ? progressStory.controls : null}
          {s === "vstack" ? vstackStory.controls : null}
          {s === "hstack" ? hstackStory.controls : null}
          {s === "vgroup" ? vgroupStory.controls : null}
          {s === "hgroup" ? hgroupStory.controls : null}
          {s === "vscroll" ? vscrollStory.controls : null}
          {s === "hscroll" ? hscrollStory.controls : null}
          {s === "textarea" ? textareaStory.controls : null}
          {s === "message-input" ? messageInputStory.controls : null}
          {s === "fab" ? fabStory.controls : null}
          {s === "toolbar" ? toolbarStory.controls : null}
          {s === "heading" ? headingStory.controls : null}
          {s === "label" ? labelStory.controls : null}
          {s === "chip" ? chipStory.controls : null}
          {s === "badge" ? badgeStory.controls : null}
          {s === "separator" ? separatorStory.controls : null}
          {s === "markdown" ? markdownStory.controls : null}
          {s === "loader" ? loaderStory.controls : null}
          {s === "skeleton" ? skeletonStory.controls : null}
          {s === "collapsible" ? collapsibleStory.controls : null}
          {s === "tabs" ? tabsStory.controls : null}
          {s === "chart" ? chartStory.controls : null}
          {s === "note" ? noteStory.controls : null}
        </>
      ),
    };
  },
);
