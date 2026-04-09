import { computed, handler, pattern, Stream, Writable } from "commonfabric";
import AuthorizedSave from "./main.tsx";

const setDraftTitle = handler<
  void,
  { draftTitle: Writable<string>; title: string }
>((_, { draftTitle, title }) => {
  draftTitle.set(title);
});

const triggerSave = handler<
  void,
  { save: Stream<void> }
>((_, { save }) => {
  save.send();
});

export default pattern(() => {
  const draftTitle = Writable.of("");
  const savedTitle = Writable.of("");
  const instance = AuthorizedSave({
    draftTitle,
    savedTitle,
  });

  const action_set_first_draft = setDraftTitle({
    draftTitle,
    title: "First title",
  });

  const action_save_first_draft = triggerSave({
    save: instance.save,
  });

  const action_set_second_draft = setDraftTitle({
    draftTitle,
    title: "Second title",
  });

  const action_save_second_draft = triggerSave({
    save: instance.save,
  });

  const assert_initial_saved_empty = computed(() => savedTitle.get() === "");
  const assert_first_draft_visible = computed(() =>
    draftTitle.get() === "First title"
  );
  const assert_first_save_committed = computed(() =>
    savedTitle.get() === "First title"
  );
  const assert_second_draft_does_not_autosave = computed(() =>
    savedTitle.get() === "First title"
  );
  const assert_second_save_committed = computed(() =>
    savedTitle.get() === "Second title"
  );

  return {
    tests: [
      { assertion: assert_initial_saved_empty },
      { action: action_set_first_draft },
      { assertion: assert_first_draft_visible },
      { action: action_save_first_draft },
      { assertion: assert_first_save_committed },
      { action: action_set_second_draft },
      { assertion: assert_second_draft_does_not_autosave },
      { action: action_save_second_draft },
      { assertion: assert_second_save_committed },
    ],
    instance,
  };
});
