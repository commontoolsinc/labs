/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, Writable } from "commontools";

import ButtonStory from "../stories/ct-button-story.tsx";
import InputStory from "../stories/ct-input-story.tsx";
import CardStory from "../stories/ct-card-story.tsx";

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
    const inputStory = InputStory({});
    const cardStory = CardStory({});

    return {
      [NAME]: "StoryRenderer",
      [UI]: (
        <>
          {s === "button" ? buttonStory : null}
          {s === "input" ? inputStory : null}
          {s === "card" ? cardStory : null}
        </>
      ),
      controls: (
        <>
          {s === "button" ? buttonStory.controls : null}
          {s === "input" ? inputStory.controls : null}
          {s === "card" ? cardStory.controls : null}
        </>
      ),
    };
  },
);
