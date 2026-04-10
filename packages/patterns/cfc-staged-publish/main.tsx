import {
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";
import {
  publishTrustedSnapshot,
  reviewTrustedSnapshot,
  saveTrustedDraftSnapshot,
  TrustedActionWrite,
  TrustedPublishSurface,
  TrustedReviewSurface,
  TrustedSaveDraftSurface,
} from "../cfc-trusted-surfaces/main.tsx";

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
  savedTitle: TrustedActionWrite<
    string,
    typeof saveTrustedDraftSnapshot,
    "TrustedSaveDraft"
  >;
  savedBody: TrustedActionWrite<
    string,
    typeof saveTrustedDraftSnapshot,
    "TrustedSaveDraft"
  >;
  reviewedTitle: TrustedActionWrite<
    string,
    typeof reviewTrustedSnapshot,
    "TrustedReviewSnapshot"
  >;
  reviewedBody: TrustedActionWrite<
    string,
    typeof reviewTrustedSnapshot,
    "TrustedReviewSnapshot"
  >;
  publishedTitle: TrustedActionWrite<
    string,
    typeof publishTrustedSnapshot,
    "TrustedPublishSnapshot"
  >;
  publishedBody: TrustedActionWrite<
    string,
    typeof publishTrustedSnapshot,
    "TrustedPublishSnapshot"
  >;
  stage: "drafting" | "saved" | "reviewed" | "published";
  saveDraft: Stream<void>;
  reviewSaved: Stream<void>;
  publishReviewed: Stream<void>;
}

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
    const trustedSaveDraft = TrustedSaveDraftSurface({
      draftTitle,
      draftBody,
      savedTitle,
      savedBody,
    });
    const trustedReview = TrustedReviewSurface({
      savedTitle,
      savedBody,
      reviewedTitle,
      reviewedBody,
    });
    const trustedPublish = TrustedPublishSurface({
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
        <cf-screen title="CFC Staged Publish">
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-hstack slot="content" justify="between" align="center">
                <cf-label>Stage</cf-label>
                <cf-badge id="stage-pill">{stage}</cf-badge>
              </cf-hstack>
            </cf-card>

            {trustedSaveDraft}

            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-heading level={3}>Saved snapshot</cf-heading>
                <div id="saved-title">{savedTitle}</div>
                <div id="saved-body">{savedBody}</div>
              </cf-vstack>
            </cf-card>

            {trustedReview}

            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-heading level={3}>Reviewed snapshot</cf-heading>
                <div id="reviewed-title">{reviewedTitle}</div>
                <div id="reviewed-body">{reviewedBody}</div>
              </cf-vstack>
            </cf-card>

            {trustedPublish}

            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-heading level={3}>Published snapshot</cf-heading>
                <div id="published-title">{publishedTitle}</div>
                <div id="published-body">{publishedBody}</div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
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
      saveDraft: trustedSaveDraft.saveDraft,
      reviewSaved: trustedReview.reviewSaved,
      publishReviewed: trustedPublish.publishReviewed,
    };
  },
);
