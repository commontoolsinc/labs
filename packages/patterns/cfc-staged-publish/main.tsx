import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

interface StagedPublishInput {
  draftTitle: Writable<Default<string, "">>;
  draftBody: Writable<Default<string, "">>;
  savedTitle: Writable<Default<string, "">>;
  savedBody: Writable<Default<string, "">>;
  reviewedTitle: Writable<Default<string, "">>;
  reviewedBody: Writable<Default<string, "">>;
  publishedTitle: Writable<Default<string, "">>;
  publishedBody: Writable<Default<string, "">>;
}

interface StagedPublishOutput {
  [NAME]: string;
  [UI]: unknown;
  draftTitle: string;
  draftBody: string;
  savedTitle: WriteAuthorizedBy<string, typeof saveDraftSnapshot>;
  savedBody: WriteAuthorizedBy<string, typeof saveDraftSnapshot>;
  reviewedTitle: WriteAuthorizedBy<string, typeof reviewSavedSnapshot>;
  reviewedBody: WriteAuthorizedBy<string, typeof reviewSavedSnapshot>;
  publishedTitle: WriteAuthorizedBy<string, typeof publishReviewedSnapshot>;
  publishedBody: WriteAuthorizedBy<string, typeof publishReviewedSnapshot>;
  stage: "drafting" | "saved" | "reviewed" | "published";
  saveDraft: Stream<void>;
  reviewSaved: Stream<void>;
  publishReviewed: Stream<void>;
}

const saveDraftSnapshot = handler<
  void,
  {
    draftTitle: Writable<string>;
    draftBody: Writable<string>;
    savedTitle: Writable<string>;
    savedBody: Writable<string>;
  }
>((_, { draftTitle, draftBody, savedTitle, savedBody }) => {
  savedTitle.set(draftTitle.get().trim());
  savedBody.set(draftBody.get().trim());
});

const reviewSavedSnapshot = handler<
  void,
  {
    savedTitle: Writable<string>;
    savedBody: Writable<string>;
    reviewedTitle: Writable<string>;
    reviewedBody: Writable<string>;
  }
>((_, { savedTitle, savedBody, reviewedTitle, reviewedBody }) => {
  reviewedTitle.set(savedTitle.get());
  reviewedBody.set(savedBody.get());
});

const publishReviewedSnapshot = handler<
  void,
  {
    reviewedTitle: Writable<string>;
    reviewedBody: Writable<string>;
    publishedTitle: Writable<string>;
    publishedBody: Writable<string>;
  }
>((_, { reviewedTitle, reviewedBody, publishedTitle, publishedBody }) => {
  publishedTitle.set(reviewedTitle.get());
  publishedBody.set(reviewedBody.get());
});

export default pattern<StagedPublishInput, StagedPublishOutput>(
  ({
    draftTitle,
    draftBody,
    savedTitle,
    savedBody,
    reviewedTitle,
    reviewedBody,
    publishedTitle,
    publishedBody,
  }) => {
    const saveDraft = saveDraftSnapshot({
      draftTitle,
      draftBody,
      savedTitle,
      savedBody,
    });
    const reviewSaved = reviewSavedSnapshot({
      savedTitle,
      savedBody,
      reviewedTitle,
      reviewedBody,
    });
    const publishReviewed = publishReviewedSnapshot({
      reviewedTitle,
      reviewedBody,
      publishedTitle,
      publishedBody,
    });

    const stage = computed(() =>
      publishedTitle.get()
        ? "published"
        : reviewedTitle.get()
        ? "reviewed"
        : savedTitle.get()
        ? "saved"
        : "drafting"
    );

    return {
      [NAME]: computed(() => `CFC Staged Publish (${stage})`),
      [UI]: (
        <div>
          <div>
            <strong>Stage:</strong> <span id="stage-pill">{stage}</span>
          </div>

          <section>
            <h3>Draft</h3>
            <cf-input $value={draftTitle} placeholder="Draft title" />
            <cf-input $value={draftBody} placeholder="Draft body" />
            <cf-button onClick={saveDraft}>Save draft</cf-button>
          </section>

          <section>
            <h3>Saved Snapshot</h3>
            <div id="saved-title">{savedTitle}</div>
            <div id="saved-body">{savedBody}</div>
            <cf-button onClick={reviewSaved}>Mark reviewed</cf-button>
          </section>

          <section>
            <h3>Reviewed Snapshot</h3>
            <div id="reviewed-title">{reviewedTitle}</div>
            <div id="reviewed-body">{reviewedBody}</div>
            <cf-button onClick={publishReviewed}>Publish</cf-button>
          </section>

          <section>
            <h3>Published Snapshot</h3>
            <div id="published-title">{publishedTitle}</div>
            <div id="published-body">{publishedBody}</div>
          </section>
        </div>
      ),
      draftTitle,
      draftBody,
      savedTitle,
      savedBody,
      reviewedTitle,
      reviewedBody,
      publishedTitle,
      publishedBody,
      stage,
      saveDraft,
      reviewSaved,
      publishReviewed,
    };
  },
);
