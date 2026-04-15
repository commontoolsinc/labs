import { computed, handler, pattern, Stream, Writable } from "commonfabric";
import StagedPublish from "./main.tsx";

const setDraft = handler<
  void,
  {
    draftTitle: Writable<string>;
    draftBody: Writable<string>;
    title: string;
    body: string;
  }
>((_, { draftTitle, draftBody, title, body }) => {
  draftTitle.set(title);
  draftBody.set(body);
});

const trigger = handler<void, { stream: Stream<void> }>((_, { stream }) => {
  stream.send();
});

export default pattern(() => {
  const draftTitle = Writable.of("");
  const draftBody = Writable.of("");
  const savedTitle = Writable.of("");
  const savedBody = Writable.of("");
  const reviewedTitle = Writable.of("");
  const reviewedBody = Writable.of("");
  const publishedTitle = Writable.of("");
  const publishedBody = Writable.of("");

  const instance = StagedPublish({
    draftTitle,
    draftBody,
    savedTitle,
    savedBody,
    reviewedTitle,
    reviewedBody,
    publishedTitle,
    publishedBody,
  });

  const action_set_draft = setDraft({
    draftTitle,
    draftBody,
    title: "Launch checklist",
    body: "Ship the staged publish demo with trusted UI gates.",
  });
  const action_save = trigger({ stream: instance.saveDraft });
  const action_edit_draft = setDraft({
    draftTitle,
    draftBody,
    title: "Launch checklist v2",
    body: "Edited after save but before review.",
  });
  const action_review = trigger({ stream: instance.reviewSaved });
  const action_publish = trigger({ stream: instance.publishReviewed });

  const assert_initial_stage = computed(() => instance.stage === "drafting");
  const assert_saved_snapshot = computed(() =>
    savedTitle.get() === "Launch checklist" &&
    savedBody.get() === "Ship the staged publish demo with trusted UI gates." &&
    instance.stage === "saved"
  );
  const assert_saved_stays_stable_after_edit = computed(() =>
    savedTitle.get() === "Launch checklist" &&
    savedBody.get() === "Ship the staged publish demo with trusted UI gates."
  );
  const assert_reviewed_snapshot = computed(() =>
    reviewedTitle.get() === "Launch checklist" &&
    reviewedBody.get() ===
      "Ship the staged publish demo with trusted UI gates." &&
    instance.stage === "reviewed"
  );
  const assert_published_snapshot = computed(() =>
    publishedTitle.get() === "Launch checklist" &&
    publishedBody.get() ===
      "Ship the staged publish demo with trusted UI gates." &&
    instance.stage === "published"
  );

  return {
    tests: [
      { assertion: assert_initial_stage },
      { action: action_set_draft },
      { action: action_save },
      { assertion: assert_saved_snapshot },
      { action: action_edit_draft },
      { assertion: assert_saved_stays_stable_after_edit },
      { action: action_review },
      { assertion: assert_reviewed_snapshot },
      { action: action_publish },
      { assertion: assert_published_snapshot },
    ],
    instance,
  };
});
