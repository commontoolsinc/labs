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
          {s === "chart" ? chartStory.controls : null}
          {s === "note" ? noteStory.controls : null}
        </>
      ),
    };
  },
);
