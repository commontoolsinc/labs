import { computed, NAME, pattern, UI } from "commonfabric";
import SubmitInputStory from "./cf-submit-input-story.tsx";

// Lane-2 pattern test (run by `cf test`): instantiating the story runs its body
// — the [UI] and controls JSX — so the story's authored lines are recorded as
// covered, and the assertion checks the story builds the shape the catalog
// renderer expects.
export default pattern(() => {
  const story = SubmitInputStory({});
  const assert_story_built = computed(() =>
    story[NAME] === "cf-submit-input Story" &&
    story[UI] != null &&
    story.controls != null
  );
  return { tests: [{ assertion: assert_story_built }] };
});
