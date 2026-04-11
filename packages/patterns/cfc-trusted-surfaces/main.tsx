import {
  Cfc,
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

export type TrustedActionWrite<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
> = Cfc<
  WriteAuthorizedBy<T, Binding>,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: [Pattern];
    };
  }
>;

export const TRUSTED_SAVE_SURFACE = "TrustedSaveSurface";
export const TRUSTED_SAVE_DRAFT_SURFACE = "TrustedSaveDraftSurface";
export const TRUSTED_REVIEW_SURFACE = "TrustedReviewSurface";
export const TRUSTED_PUBLISH_SURFACE = "TrustedPublishSurface";
export const TRUSTED_FORWARD_SURFACE = "TrustedForwardSurface";
export const TRUSTED_DIRECT_COMMAND_SURFACE = "TrustedDirectCommandSurface";
export const TRUSTED_SAFE_LINK_SURFACE = "TrustedSafeLinkSurface";

const SAVE_TITLE_ACTION = "TrustedSaveTitle";
const SAVE_DRAFT_ACTION = "TrustedSaveDraft";
const REVIEW_SNAPSHOT_ACTION = "TrustedReviewSnapshot";
const PUBLISH_SNAPSHOT_ACTION = "TrustedPublishSnapshot";
const PREPARE_FORWARD_ACTION = "TrustedPrepareForward";
const FORWARD_NOTE_ACTION = "TrustedForwardNote";
const CAPTURE_COMMAND_ACTION = "TrustedCaptureDirectCommand";
const PREPARE_BRIEF_ACTION = "TrustedPrepareResearchBrief";
const AUTHORIZE_SEND_ACTION = "TrustedAuthorizeResearchSend";
const PREPARE_SAFE_LINK_ACTION = "TrustedPrepareSafeLink";
const RELEASE_SAFE_LINK_ACTION = "TrustedReleaseSafeLink";

export const commitTrustedSaveTitle = handler<
  void,
  {
    draftTitle: Writable<string>;
    savedTitle: Writable<string>;
  }
>((_, { draftTitle, savedTitle }) => {
  savedTitle.set(draftTitle.get().trim());
});

export const saveTrustedDraftSnapshot = handler<
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

export const reviewTrustedSnapshot = handler<
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

export const publishTrustedSnapshot = handler<
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

export const prepareTrustedForward = handler<
  void,
  {
    sourceNote: Writable<string>;
    recipientInput: Writable<string>;
    preparedPreview: Writable<string>;
  }
>((_, { sourceNote, recipientInput, preparedPreview }) => {
  const recipient = recipientInput.get().trim() || "ops@hotel.example";
  const excerpt = sourceNote.get().split(".")[0]?.trim() ?? sourceNote.get();
  preparedPreview.set(
    `Prepared for ${recipient}: ${excerpt}. Only the bounded itinerary excerpt will be forwarded.`,
  );
});

export const commitTrustedForward = handler<
  void,
  {
    preparedPreview: Writable<string>;
    forwardedNote: Writable<string>;
  }
>((_, { preparedPreview, forwardedNote }) => {
  forwardedNote.set(preparedPreview.get().trim());
});

export const captureTrustedDirectCommand = handler<
  void,
  {
    commandInput: Writable<string>;
    capturedCommand: Writable<string>;
    preparedBrief: Writable<string>;
  }
>((_, { commandInput, capturedCommand, preparedBrief }) => {
  capturedCommand.set(commandInput.get().trim());
  preparedBrief.set("");
});

export const prepareTrustedResearchBrief = handler<
  void,
  {
    capturedCommand: Writable<string>;
    preparedBrief: Writable<string>;
  }
>((_, { capturedCommand, preparedBrief }) => {
  const command = capturedCommand.get().trim();
  preparedBrief.set(
    command
      ? `Prepared outbound draft: concise summary for "${command}". The send action stays separately gated.`
      : "",
  );
});

export const commitTrustedResearchSend = handler<
  void,
  {
    capturedCommand: Writable<string>;
    preparedBrief: Writable<string>;
    authorizedSend: Writable<string>;
  }
>((_, { capturedCommand, preparedBrief, authorizedSend }) => {
  const command = capturedCommand.get().trim();
  const preview = preparedBrief.get().trim();
  authorizedSend.set(
    preview ? `Authorized outbound message for "${command}": ${preview}` : "",
  );
});

export const prepareTrustedSafeLink = handler<
  void,
  {
    sourceUrl: Writable<string>;
    preparedSafeLink: Writable<string>;
  }
>((_, { sourceUrl, preparedSafeLink }) => {
  const [base] = sourceUrl.get().split("?");
  preparedSafeLink.set(base ? `${base}?view=summary` : "");
});

export const commitTrustedSafeLink = handler<
  void,
  {
    preparedSafeLink: Writable<string>;
    releasedSafeLink: Writable<string>;
  }
>((_, { preparedSafeLink, releasedSafeLink }) => {
  const prepared = preparedSafeLink.get().trim();
  releasedSafeLink.set(prepared ? `Released safe link ${prepared}` : "");
});

export interface TrustedSaveSurfaceInput {
  draftTitle: Writable<string>;
  savedTitle: Writable<string>;
}

export interface TrustedSaveSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  savedTitle: TrustedActionWrite<
    string,
    typeof commitTrustedSaveTitle,
    typeof SAVE_TITLE_ACTION,
    typeof TRUSTED_SAVE_SURFACE
  >;
  save: Stream<void>;
}

export const TrustedSaveSurface = pattern<
  TrustedSaveSurfaceInput,
  TrustedSaveSurfaceOutput
>(({ draftTitle, savedTitle }) => {
  const save = commitTrustedSaveTitle({ draftTitle, savedTitle });

  return {
    [NAME]: computed(() => "Trusted Save Surface"),
    [UI]: (
      <cf-card
        id="trusted-save-surface"
        data-ui-pattern={TRUSTED_SAVE_SURFACE}
        data-ui-event-integrity={TRUSTED_SAVE_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted save</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-save-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed surface means “copy the current draft title into
                the protected saved field.”
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-save-draft-input">Draft title</cf-label>
            <cf-input
              id="trusted-save-draft-input"
              $value={draftTitle}
              placeholder="Draft title"
            />
          </cf-vgroup>
          <cf-button data-ui-action={SAVE_TITLE_ACTION} onClick={save}>
            Save title
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    savedTitle,
    save,
  };
});

export interface TrustedSaveDraftSurfaceInput {
  draftTitle: Writable<string>;
  draftBody: Writable<string>;
  savedTitle: Writable<string>;
  savedBody: Writable<string>;
}

export interface TrustedSaveDraftSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  savedTitle: TrustedActionWrite<
    string,
    typeof saveTrustedDraftSnapshot,
    typeof SAVE_DRAFT_ACTION,
    typeof TRUSTED_SAVE_DRAFT_SURFACE
  >;
  savedBody: TrustedActionWrite<
    string,
    typeof saveTrustedDraftSnapshot,
    typeof SAVE_DRAFT_ACTION,
    typeof TRUSTED_SAVE_DRAFT_SURFACE
  >;
  saveDraft: Stream<void>;
}

export const TrustedSaveDraftSurface = pattern<
  TrustedSaveDraftSurfaceInput,
  TrustedSaveDraftSurfaceOutput
>(({ draftTitle, draftBody, savedTitle, savedBody }) => {
  const saveDraft = saveTrustedDraftSnapshot({
    draftTitle,
    draftBody,
    savedTitle,
    savedBody,
  });

  return {
    [NAME]: computed(() => "Trusted Save Draft Surface"),
    [UI]: (
      <cf-card
        id="trusted-save-draft-surface"
        data-ui-pattern={TRUSTED_SAVE_DRAFT_SURFACE}
        data-ui-event-integrity={TRUSTED_SAVE_DRAFT_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted save draft</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-save-draft-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed surface snapshots the current draft title and body
                into the protected saved copy.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-save-draft-title-input">
              Draft title
            </cf-label>
            <cf-input
              id="trusted-save-draft-title-input"
              $value={draftTitle}
              placeholder="Draft title"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-save-draft-body-input">Draft body</cf-label>
            <cf-input
              id="trusted-save-draft-body-input"
              $value={draftBody}
              placeholder="Draft body"
            />
          </cf-vgroup>
          <cf-button data-ui-action={SAVE_DRAFT_ACTION} onClick={saveDraft}>
            Save draft
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    savedTitle,
    savedBody,
    saveDraft,
  };
});

export interface TrustedReviewSurfaceInput {
  savedTitle: Writable<string>;
  savedBody: Writable<string>;
  reviewedTitle: Writable<string>;
  reviewedBody: Writable<string>;
}

export interface TrustedReviewSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  reviewedTitle: TrustedActionWrite<
    string,
    typeof reviewTrustedSnapshot,
    typeof REVIEW_SNAPSHOT_ACTION,
    typeof TRUSTED_REVIEW_SURFACE
  >;
  reviewedBody: TrustedActionWrite<
    string,
    typeof reviewTrustedSnapshot,
    typeof REVIEW_SNAPSHOT_ACTION,
    typeof TRUSTED_REVIEW_SURFACE
  >;
  reviewSaved: Stream<void>;
}

export const TrustedReviewSurface = pattern<
  TrustedReviewSurfaceInput,
  TrustedReviewSurfaceOutput
>(({ savedTitle, savedBody, reviewedTitle, reviewedBody }) => {
  const reviewSaved = reviewTrustedSnapshot({
    savedTitle,
    savedBody,
    reviewedTitle,
    reviewedBody,
  });

  return {
    [NAME]: computed(() => "Trusted Review Surface"),
    [UI]: (
      <cf-card
        id="trusted-review-surface"
        data-ui-pattern={TRUSTED_REVIEW_SURFACE}
        data-ui-event-integrity={TRUSTED_REVIEW_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted review</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-review-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed button means “promote the current saved snapshot
                into the protected reviewed copy.”
              </cf-label>
            </cf-vstack>
          </cf-card>
          <div id="trusted-review-source-title">{savedTitle}</div>
          <div id="trusted-review-source-body">{savedBody}</div>
          <cf-button
            data-ui-action={REVIEW_SNAPSHOT_ACTION}
            onClick={reviewSaved}
          >
            Mark reviewed
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    reviewedTitle,
    reviewedBody,
    reviewSaved,
  };
});

export interface TrustedPublishSurfaceInput {
  reviewedTitle: Writable<string>;
  reviewedBody: Writable<string>;
  publishedTitle: Writable<string>;
  publishedBody: Writable<string>;
}

export interface TrustedPublishSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  publishedTitle: TrustedActionWrite<
    string,
    typeof publishTrustedSnapshot,
    typeof PUBLISH_SNAPSHOT_ACTION,
    typeof TRUSTED_PUBLISH_SURFACE
  >;
  publishedBody: TrustedActionWrite<
    string,
    typeof publishTrustedSnapshot,
    typeof PUBLISH_SNAPSHOT_ACTION,
    typeof TRUSTED_PUBLISH_SURFACE
  >;
  publishReviewed: Stream<void>;
}

export const TrustedPublishSurface = pattern<
  TrustedPublishSurfaceInput,
  TrustedPublishSurfaceOutput
>(({ reviewedTitle, reviewedBody, publishedTitle, publishedBody }) => {
  const publishReviewed = publishTrustedSnapshot({
    reviewedTitle,
    reviewedBody,
    publishedTitle,
    publishedBody,
  });

  return {
    [NAME]: computed(() => "Trusted Publish Surface"),
    [UI]: (
      <cf-card
        id="trusted-publish-surface"
        data-ui-pattern={TRUSTED_PUBLISH_SURFACE}
        data-ui-event-integrity={TRUSTED_PUBLISH_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted publish</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-publish-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed button means “copy the reviewed snapshot into the
                protected published output.”
              </cf-label>
            </cf-vstack>
          </cf-card>
          <div id="trusted-publish-source-title">{reviewedTitle}</div>
          <div id="trusted-publish-source-body">{reviewedBody}</div>
          <cf-button
            data-ui-action={PUBLISH_SNAPSHOT_ACTION}
            onClick={publishReviewed}
          >
            Publish
          </cf-button>
        </cf-vstack>
      </cf-card>
    ),
    publishedTitle,
    publishedBody,
    publishReviewed,
  };
});

export interface TrustedForwardSurfaceInput {
  sourceNote: Writable<string>;
  recipientInput: Writable<string>;
  preparedPreview: Writable<string>;
  forwardedNote: Writable<string>;
}

export interface TrustedForwardSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  recipientInput: string;
  preparedPreview: TrustedActionWrite<
    string,
    typeof prepareTrustedForward,
    typeof PREPARE_FORWARD_ACTION,
    typeof TRUSTED_FORWARD_SURFACE
  >;
  forwardedNote: TrustedActionWrite<
    string,
    typeof commitTrustedForward,
    typeof FORWARD_NOTE_ACTION,
    typeof TRUSTED_FORWARD_SURFACE
  >;
  prepareForward: Stream<void>;
  forwardNote: Stream<void>;
}

export const TrustedForwardSurface = pattern<
  TrustedForwardSurfaceInput,
  TrustedForwardSurfaceOutput
>(({ sourceNote, recipientInput, preparedPreview, forwardedNote }) => {
  const prepareForward = prepareTrustedForward({
    sourceNote,
    recipientInput,
    preparedPreview,
  });
  const forwardNote = commitTrustedForward({
    preparedPreview,
    forwardedNote,
  });

  return {
    [NAME]: computed(() => "Trusted Forward Surface"),
    [UI]: (
      <cf-card
        id="trusted-forward-surface"
        data-ui-pattern={TRUSTED_FORWARD_SURFACE}
        data-ui-event-integrity={TRUSTED_FORWARD_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-hstack justify="between" align="center" wrap>
            <cf-vstack gap="1">
              <cf-heading level={3}>Trusted forward</cf-heading>
              <cf-label>
                Prepare a bounded excerpt, then release it through the reviewed
                forward action.
              </cf-label>
            </cf-vstack>
          </cf-hstack>
          <cf-card data-ui-disclosure-kind="trusted-forward-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>Incoming note excerpt</cf-label>
              <div id="trusted-forward-source-note">{sourceNote}</div>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-forward-recipient">
              Forward recipient
            </cf-label>
            <cf-input
              id="trusted-forward-recipient"
              $value={recipientInput}
              placeholder="ops@hotel.example"
            />
          </cf-vgroup>
          <cf-hstack gap="2" wrap>
            <cf-button
              data-ui-action={PREPARE_FORWARD_ACTION}
              onClick={prepareForward}
            >
              Prepare forward
            </cf-button>
            <cf-button
              data-ui-action={FORWARD_NOTE_ACTION}
              onClick={forwardNote}
            >
              Forward trusted note
            </cf-button>
          </cf-hstack>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Prepared outbound request</cf-label>
              <div id="trusted-forward-prepared">{preparedPreview}</div>
              <cf-label>Committed release</cf-label>
              <div id="trusted-forward-result">{forwardedNote}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    recipientInput,
    preparedPreview,
    forwardedNote,
    prepareForward,
    forwardNote,
  };
});

export interface TrustedDirectCommandSurfaceInput {
  commandInput: Writable<string>;
  capturedCommand: Writable<string>;
  preparedBrief: Writable<string>;
  authorizedSend: Writable<string>;
}

export interface TrustedDirectCommandSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  commandInput: string;
  capturedCommand: TrustedActionWrite<
    string,
    typeof captureTrustedDirectCommand,
    typeof CAPTURE_COMMAND_ACTION,
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  preparedBrief: TrustedActionWrite<
    string,
    typeof prepareTrustedResearchBrief,
    typeof PREPARE_BRIEF_ACTION,
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  authorizedSend: TrustedActionWrite<
    string,
    typeof commitTrustedResearchSend,
    typeof AUTHORIZE_SEND_ACTION,
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  captureCommand: Stream<void>;
  prepareBrief: Stream<void>;
  authorizeSend: Stream<void>;
}

export const TrustedDirectCommandSurface = pattern<
  TrustedDirectCommandSurfaceInput,
  TrustedDirectCommandSurfaceOutput
>(({ commandInput, capturedCommand, preparedBrief, authorizedSend }) => {
  const captureCommand = captureTrustedDirectCommand({
    commandInput,
    capturedCommand,
    preparedBrief,
  });
  const prepareBrief = prepareTrustedResearchBrief({
    capturedCommand,
    preparedBrief,
  });
  const authorizeSend = commitTrustedResearchSend({
    capturedCommand,
    preparedBrief,
    authorizedSend,
  });

  return {
    [NAME]: computed(() => "Trusted Direct Command Surface"),
    [UI]: (
      <cf-card
        id="trusted-direct-command-surface"
        data-ui-pattern={TRUSTED_DIRECT_COMMAND_SURFACE}
        data-ui-event-integrity={TRUSTED_DIRECT_COMMAND_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted direct command</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-direct-command-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed surface captures a bounded agent command, prepares
                a draft, and requires a separate release click to send it.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-command-input">Direct command</cf-label>
            <cf-textarea
              data-ui-surface="DirectAgentCommand"
              data-ui-role="assistant"
              $value={commandInput}
              rows={4}
            />
          </cf-vgroup>
          <cf-hstack gap="2" wrap>
            <cf-button
              data-ui-action={CAPTURE_COMMAND_ACTION}
              onClick={captureCommand}
            >
              Capture direct command
            </cf-button>
            <cf-button
              data-ui-action={PREPARE_BRIEF_ACTION}
              onClick={prepareBrief}
            >
              Prepare brief
            </cf-button>
            <cf-button
              data-ui-action={AUTHORIZE_SEND_ACTION}
              onClick={authorizeSend}
            >
              Authorize research send
            </cf-button>
          </cf-hstack>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Captured command</cf-label>
              <div id="trusted-command-captured">{capturedCommand}</div>
              <cf-label>Prepared brief</cf-label>
              <div id="trusted-command-prepared">{preparedBrief}</div>
              <cf-label>Committed outbound action</cf-label>
              <div id="trusted-command-result">{authorizedSend}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
    captureCommand,
    prepareBrief,
    authorizeSend,
  };
});

export interface TrustedSafeLinkSurfaceInput {
  sourceUrl: Writable<string>;
  preparedSafeLink: Writable<string>;
  releasedSafeLink: Writable<string>;
}

export interface TrustedSafeLinkSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  sourceUrl: string;
  preparedSafeLink: TrustedActionWrite<
    string,
    typeof prepareTrustedSafeLink,
    typeof PREPARE_SAFE_LINK_ACTION,
    typeof TRUSTED_SAFE_LINK_SURFACE
  >;
  releasedSafeLink: TrustedActionWrite<
    string,
    typeof commitTrustedSafeLink,
    typeof RELEASE_SAFE_LINK_ACTION,
    typeof TRUSTED_SAFE_LINK_SURFACE
  >;
  prepareSafeLink: Stream<void>;
  releaseSafeLink: Stream<void>;
}

export const TrustedSafeLinkSurface = pattern<
  TrustedSafeLinkSurfaceInput,
  TrustedSafeLinkSurfaceOutput
>(({ sourceUrl, preparedSafeLink, releasedSafeLink }) => {
  const prepareSafeLink = prepareTrustedSafeLink({
    sourceUrl,
    preparedSafeLink,
  });
  const releaseSafeLink = commitTrustedSafeLink({
    preparedSafeLink,
    releasedSafeLink,
  });

  return {
    [NAME]: computed(() => "Trusted Safe Link Surface"),
    [UI]: (
      <cf-card
        id="trusted-safe-link-surface"
        data-ui-pattern={TRUSTED_SAFE_LINK_SURFACE}
        data-ui-event-integrity={TRUSTED_SAFE_LINK_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted safe-link release</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-safe-link-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed surface strips risky query material and releases
                only the safe summary link.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-safe-link-source">Source URL</cf-label>
            <cf-input
              id="trusted-safe-link-source"
              $value={sourceUrl}
              placeholder="https://source.example.com/private/report"
            />
          </cf-vgroup>
          <cf-hstack gap="2" wrap>
            <cf-button
              data-ui-action={PREPARE_SAFE_LINK_ACTION}
              onClick={prepareSafeLink}
            >
              Prepare safe link
            </cf-button>
            <cf-button
              data-ui-action={RELEASE_SAFE_LINK_ACTION}
              onClick={releaseSafeLink}
            >
              Release safe link
            </cf-button>
          </cf-hstack>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Prepared safe derivative</cf-label>
              <div id="trusted-safe-link-prepared">{preparedSafeLink}</div>
              <cf-label>Committed release</cf-label>
              <div id="trusted-safe-link-result">{releasedSafeLink}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    sourceUrl,
    preparedSafeLink,
    releasedSafeLink,
    prepareSafeLink,
    releaseSafeLink,
  };
});

export default pattern<Record<PropertyKey, never>>(() => ({
  [NAME]: computed(() => "CFC Trusted Surfaces"),
  [UI]: (
    <cf-screen title="CFC Trusted Surfaces">
      <cf-vstack gap="3" style={{ padding: "1rem" }}>
        <cf-card>
          <cf-vstack slot="content" gap="2">
            <cf-heading level={2}>Reusable trusted sub-UIs</cf-heading>
            <cf-label>
              Import the named exports from this module to embed reviewed
              trusted surfaces inside broader host patterns.
            </cf-label>
          </cf-vstack>
        </cf-card>
      </cf-vstack>
    </cf-screen>
  ),
}));
