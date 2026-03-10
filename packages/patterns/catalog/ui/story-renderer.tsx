/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, Writable } from "commontools";

import ButtonStory from "../stories/ct-button-story.tsx";
import CheckboxStory from "../stories/ct-checkbox-story.tsx";
import InputStory from "../stories/ct-input-story.tsx";
import SelectStory from "../stories/ct-select-story.tsx";
import SwitchStory from "../stories/ct-switch-story.tsx";
import CardStory from "../stories/ct-card-story.tsx";
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
          {s === "chart" ? chartStory.controls : null}
          {s === "note" ? noteStory.controls : null}
        </>
      ),
    };
  },
);
