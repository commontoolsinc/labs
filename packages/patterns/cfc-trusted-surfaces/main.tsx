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

export type TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]],
> = Cfc<
  WriteAuthorizedBy<T, Binding>,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: Integrity;
    };
  }
>;

export type TrustedActionWrite<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
> = TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action,
  Pattern,
  [Pattern]
>;

export const TRUSTED_SAVE_SURFACE = "TrustedSaveSurface";
export const TRUSTED_SAVE_DRAFT_SURFACE = "TrustedSaveDraftSurface";
export const TRUSTED_REVIEW_SURFACE = "TrustedReviewSurface";
export const TRUSTED_PUBLISH_SURFACE = "TrustedPublishSurface";
export const TRUSTED_FORWARD_SURFACE = "TrustedForwardSurface";
export const TRUSTED_DIRECT_COMMAND_SURFACE = "TrustedDirectCommandSurface";
export const TRUSTED_SAFE_LINK_SURFACE = "TrustedSafeLinkSurface";
export const TRUSTED_CONVERSATION_SEND_SURFACE =
  "TrustedConversationSendSurface";
export const TRUSTED_AUDIENCE_PUBLISH_SURFACE = "TrustedAudiencePublishSurface";
export const TRUSTED_DISCLAIMER_ACK_SURFACE = "TrustedDisclaimerAckSurface";
export const TRUSTED_DISCLAIMER_RENDERED_EVIDENCE =
  "TrustedDisclaimerRenderedEvidence";
export const TRUSTED_PROVENANCE_REVIEW_SURFACE =
  "TrustedProvenanceReviewSurface";
export const TRUSTED_PROVENANCE_RENDERED_EVIDENCE =
  "TrustedProvenanceRenderedEvidence";
export const TRUSTED_FACT_CHECK_GATE_SURFACE = "TrustedFactCheckGateSurface";
export const TRUSTED_FACT_CHECK_DISCLAIMER_EVIDENCE =
  "TrustedFactCheckDisclaimerEvidence";
export const TRUSTED_SONG_ID_RECORDING_SURFACE =
  "TrustedSongIdRecordingSurface";
export const TRUSTED_SHARE_POLICY_SURFACE = "TrustedSharePolicySurface";
export const TRUSTED_LONG_RUNNING_JOB_SURFACE = "TrustedLongRunningJobSurface";

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
const CONVERSATION_SEND_ACTION = "TrustedConversationSend";
const PREPARE_AUDIENCE_PUBLISH_ACTION = "TrustedPrepareAudiencePublish";
const PUBLISH_AUDIENCE_POST_ACTION = "TrustedPublishAudiencePost";
const ACKNOWLEDGE_DISCLAIMER_ACTION = "TrustedAcknowledgeDisclaimer";
const REVIEW_PROVENANCE_ACTION = "TrustedReviewProvenance";
const FACT_CHECK_GATE_ACTION = "TrustedApproveFactCheckGate";
const RECORD_SONG_ID_ACTION = "TrustedRecordSongId";
const SAVE_SHARE_POLICY_ACTION = "TrustedSaveSharePolicy";
const AUTHORIZE_LONG_RUNNING_JOB_ACTION = "TrustedAuthorizeLongRunningJob";
const CANCEL_LONG_RUNNING_JOB_ACTION = "TrustedCancelLongRunningJob";

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

export const commitTrustedConversationSend = handler<
  void,
  {
    conversationTitle: Writable<string>;
    audienceInput: Writable<string>;
    messageDraft: Writable<string>;
    sentMessage: Writable<string>;
  }
>((_, { conversationTitle, audienceInput, messageDraft, sentMessage }) => {
  const title = conversationTitle.get().trim() || "conversation";
  const audience = audienceInput.get().trim() || "thread";
  const message = messageDraft.get().trim();
  sentMessage.set(
    message ? `Sent in ${title} to ${audience}: ${message}` : "",
  );
});

export const prepareTrustedAudiencePublish = handler<
  void,
  {
    targetAudience: Writable<string>;
    publishSubject: Writable<string>;
    publishBody: Writable<string>;
    preparedAudiencePublish: Writable<string>;
  }
>((_, {
  targetAudience,
  publishSubject,
  publishBody,
  preparedAudiencePublish,
}) => {
  const audience = targetAudience.get().trim() || "public";
  const subject = publishSubject.get().trim() || "Untitled";
  const body = publishBody.get().trim();
  preparedAudiencePublish.set(
    body
      ? `Prepared publish for ${audience}: ${subject} — ${body}`
      : `Prepared publish for ${audience}: ${subject}`,
  );
});

export const commitTrustedAudiencePublish = handler<
  void,
  {
    preparedAudiencePublish: Writable<string>;
    publishedAudiencePost: Writable<string>;
  }
>((_, { preparedAudiencePublish, publishedAudiencePost }) => {
  publishedAudiencePost.set(preparedAudiencePublish.get().trim());
});

export const acknowledgeTrustedDisclaimer = handler<
  void,
  {
    disclaimerText: Writable<string>;
    acknowledgedDisclaimer: Writable<string>;
  }
>((_, { disclaimerText, acknowledgedDisclaimer }) => {
  const disclaimer = disclaimerText.get().trim();
  acknowledgedDisclaimer.set(
    disclaimer ? `Acknowledged trusted disclaimer: ${disclaimer}` : "",
  );
});

export const reviewTrustedProvenance = handler<
  void,
  {
    provenanceText: Writable<string>;
    reviewedProvenance: Writable<string>;
  }
>((_, { provenanceText, reviewedProvenance }) => {
  const provenance = provenanceText.get().trim();
  reviewedProvenance.set(
    provenance ? `Reviewed provenance: ${provenance}` : "",
  );
});

export const commitTrustedFactCheckGate = handler<
  void,
  {
    factCheckClaim: Writable<string>;
    factCheckResult: Writable<string>;
  }
>((_, { factCheckClaim, factCheckResult }) => {
  const claim = factCheckClaim.get().trim();
  factCheckResult.set(
    claim ? `Fact-check gate opened for: ${claim}` : "",
  );
});

export const recordTrustedSongId = handler<
  void,
  {
    songHint: Writable<string>;
    identifiedSongId: Writable<string>;
  }
>((_, { songHint, identifiedSongId }) => {
  const normalized = songHint.get().trim().toLowerCase().replace(/\s+/g, "-");
  identifiedSongId.set(
    normalized ? `Mock song id: ${normalized}` : "Mock song id: unavailable",
  );
});

export const saveTrustedSharePolicy = handler<
  void,
  {
    policyAudience: Writable<string>;
    policyScope: Writable<string>;
    savedSharePolicy: Writable<string>;
  }
>((_, { policyAudience, policyScope, savedSharePolicy }) => {
  const audience = policyAudience.get().trim() || "internal";
  const scope = policyScope.get().trim() || "shared";
  savedSharePolicy.set(`Share policy saved for ${audience} (${scope})`);
});

export const authorizeTrustedLongRunningJob = handler<
  void,
  {
    jobName: Writable<string>;
    jobStatus: Writable<string>;
    jobAuthorization: Writable<string>;
  }
>((_, { jobName, jobStatus, jobAuthorization }) => {
  const name = jobName.get().trim() || "job";
  jobStatus.set("Running");
  jobAuthorization.set(`Authorized long-running job: ${name}`);
});

export const cancelTrustedLongRunningJob = handler<
  void,
  {
    jobName: Writable<string>;
    jobStatus: Writable<string>;
    jobCancellation: Writable<string>;
  }
>((_, { jobName, jobStatus, jobCancellation }) => {
  const name = jobName.get().trim() || "job";
  jobStatus.set("Cancelled");
  jobCancellation.set(`Cancelled long-running job: ${name}`);
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

export interface TrustedConversationSendSurfaceInput {
  conversationTitle: Writable<string>;
  audienceInput: Writable<string>;
  messageDraft: Writable<string>;
  sentMessage: Writable<string>;
}

export interface TrustedConversationSendSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  sentMessage: TrustedActionWrite<
    string,
    typeof commitTrustedConversationSend,
    typeof CONVERSATION_SEND_ACTION,
    typeof TRUSTED_CONVERSATION_SEND_SURFACE
  >;
  sendMessage: Stream<void>;
}

export const TrustedConversationSendSurface = pattern<
  TrustedConversationSendSurfaceInput,
  TrustedConversationSendSurfaceOutput
>(({ conversationTitle, audienceInput, messageDraft, sentMessage }) => {
  const sendMessage = commitTrustedConversationSend({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Trusted Conversation Send Surface"),
    [UI]: (
      <cf-card
        id="trusted-conversation-send-surface"
        data-ui-pattern={TRUSTED_CONVERSATION_SEND_SURFACE}
        data-ui-event-integrity={TRUSTED_CONVERSATION_SEND_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted conversation send</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-conversation-send-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Send a message from within the current conversation context.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-conversation-title">
              Conversation title
            </cf-label>
            <cf-input
              id="trusted-conversation-title"
              $value={conversationTitle}
              placeholder="Project sync"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-conversation-audience">
              Audience within conversation
            </cf-label>
            <cf-input
              id="trusted-conversation-audience"
              $value={audienceInput}
              placeholder="team thread"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-conversation-message">Message</cf-label>
            <cf-textarea
              id="trusted-conversation-message"
              $value={messageDraft}
              rows={3}
            />
          </cf-vgroup>
          <cf-button
            data-ui-action={CONVERSATION_SEND_ACTION}
            onClick={sendMessage}
          >
            Send in conversation
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Sent message</cf-label>
              <div id="trusted-conversation-sent">{sentMessage}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    sentMessage,
    sendMessage,
  };
});

export interface TrustedAudiencePublishSurfaceInput {
  targetAudience: Writable<string>;
  publishSubject: Writable<string>;
  publishBody: Writable<string>;
  preparedAudiencePublish: Writable<string>;
  publishedAudiencePost: Writable<string>;
}

export interface TrustedAudiencePublishSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  preparedAudiencePublish: TrustedActionWrite<
    string,
    typeof prepareTrustedAudiencePublish,
    typeof PREPARE_AUDIENCE_PUBLISH_ACTION,
    typeof TRUSTED_AUDIENCE_PUBLISH_SURFACE
  >;
  publishedAudiencePost: TrustedActionWrite<
    string,
    typeof commitTrustedAudiencePublish,
    typeof PUBLISH_AUDIENCE_POST_ACTION,
    typeof TRUSTED_AUDIENCE_PUBLISH_SURFACE
  >;
  prepareAudiencePublish: Stream<void>;
  publishAudiencePost: Stream<void>;
}

export const TrustedAudiencePublishSurface = pattern<
  TrustedAudiencePublishSurfaceInput,
  TrustedAudiencePublishSurfaceOutput
>(
  ({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  }) => {
    const prepareAudiencePublish = prepareTrustedAudiencePublish({
      targetAudience,
      publishSubject,
      publishBody,
      preparedAudiencePublish,
    });
    const publishAudiencePost = commitTrustedAudiencePublish({
      preparedAudiencePublish,
      publishedAudiencePost,
    });

    return {
      [NAME]: computed(() => "Trusted Audience Publish Surface"),
      [UI]: (
        <cf-card
          id="trusted-audience-publish-surface"
          data-ui-pattern={TRUSTED_AUDIENCE_PUBLISH_SURFACE}
          data-ui-event-integrity={TRUSTED_AUDIENCE_PUBLISH_SURFACE}
        >
          <cf-vstack slot="content" gap="3">
            <cf-heading level={3}>Trusted audience publish</cf-heading>
            <cf-card data-ui-disclosure-kind="trusted-audience-publish-disclosure">
              <cf-vstack slot="content" gap="1">
                <cf-label>
                  Stage a publish and then commit it to a named audience.
                </cf-label>
              </cf-vstack>
            </cf-card>
            <cf-vgroup gap="sm">
              <cf-label for="trusted-audience-target">Audience</cf-label>
              <cf-input
                id="trusted-audience-target"
                $value={targetAudience}
                placeholder="public"
              />
            </cf-vgroup>
            <cf-vgroup gap="sm">
              <cf-label for="trusted-audience-subject">Subject</cf-label>
              <cf-input
                id="trusted-audience-subject"
                $value={publishSubject}
                placeholder="Status update"
              />
            </cf-vgroup>
            <cf-vgroup gap="sm">
              <cf-label for="trusted-audience-body">Body</cf-label>
              <cf-textarea
                id="trusted-audience-body"
                $value={publishBody}
                rows={3}
              />
            </cf-vgroup>
            <cf-hstack gap="2" wrap>
              <cf-button
                data-ui-action={PREPARE_AUDIENCE_PUBLISH_ACTION}
                onClick={prepareAudiencePublish}
              >
                Prepare publish
              </cf-button>
              <cf-button
                data-ui-action={PUBLISH_AUDIENCE_POST_ACTION}
                onClick={publishAudiencePost}
              >
                Publish to audience
              </cf-button>
            </cf-hstack>
            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-label>Prepared audience release</cf-label>
                <div id="trusted-audience-prepared">
                  {preparedAudiencePublish}
                </div>
                <cf-label>Committed audience release</cf-label>
                <div id="trusted-audience-published">
                  {publishedAudiencePost}
                </div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-card>
      ),
      preparedAudiencePublish,
      publishedAudiencePost,
      prepareAudiencePublish,
      publishAudiencePost,
    };
  },
);

export interface TrustedDisclaimerAckSurfaceInput {
  disclaimerText: Writable<string>;
  acknowledgedDisclaimer: Writable<string>;
}

export interface TrustedDisclaimerAckSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  acknowledgedDisclaimer: TrustedActionWriteWithIntegrity<
    string,
    typeof acknowledgeTrustedDisclaimer,
    typeof ACKNOWLEDGE_DISCLAIMER_ACTION,
    typeof TRUSTED_DISCLAIMER_ACK_SURFACE,
    [
      typeof TRUSTED_DISCLAIMER_ACK_SURFACE,
      typeof TRUSTED_DISCLAIMER_RENDERED_EVIDENCE,
    ]
  >;
  acknowledgeDisclaimer: Stream<void>;
}

export const TrustedDisclaimerAckSurface = pattern<
  TrustedDisclaimerAckSurfaceInput,
  TrustedDisclaimerAckSurfaceOutput
>(({ disclaimerText, acknowledgedDisclaimer }) => {
  const acknowledgeDisclaimer = acknowledgeTrustedDisclaimer({
    disclaimerText,
    acknowledgedDisclaimer,
  });

  return {
    [NAME]: computed(() => "Trusted Disclaimer Ack Surface"),
    [UI]: (
      <cf-card
        id="trusted-disclaimer-ack-surface"
        data-ui-pattern={TRUSTED_DISCLAIMER_ACK_SURFACE}
        data-ui-event-integrity={`${TRUSTED_DISCLAIMER_ACK_SURFACE} ${TRUSTED_DISCLAIMER_RENDERED_EVIDENCE}`}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted disclaimer acknowledgment</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-disclaimer-ack-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                The trusted disclaimer must be rendered before acknowledgement.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label id="trusted-disclaimer-rendered">
            {TRUSTED_DISCLAIMER_RENDERED_EVIDENCE}
          </cf-label>
          <cf-label>{disclaimerText}</cf-label>
          <cf-button
            data-ui-action={ACKNOWLEDGE_DISCLAIMER_ACTION}
            onClick={acknowledgeDisclaimer}
          >
            Acknowledge disclaimer
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Acknowledgement result</cf-label>
              <div id="trusted-disclaimer-acknowledged">
                {acknowledgedDisclaimer}
              </div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    acknowledgedDisclaimer,
    acknowledgeDisclaimer,
  };
});

export interface TrustedProvenanceReviewSurfaceInput {
  provenanceText: Writable<string>;
  reviewedProvenance: Writable<string>;
}

export interface TrustedProvenanceReviewSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  reviewedProvenance: TrustedActionWriteWithIntegrity<
    string,
    typeof reviewTrustedProvenance,
    typeof REVIEW_PROVENANCE_ACTION,
    typeof TRUSTED_PROVENANCE_REVIEW_SURFACE,
    [
      typeof TRUSTED_PROVENANCE_REVIEW_SURFACE,
      typeof TRUSTED_PROVENANCE_RENDERED_EVIDENCE,
    ]
  >;
  reviewProvenance: Stream<void>;
}

export const TrustedProvenanceReviewSurface = pattern<
  TrustedProvenanceReviewSurfaceInput,
  TrustedProvenanceReviewSurfaceOutput
>(({ provenanceText, reviewedProvenance }) => {
  const reviewProvenance = reviewTrustedProvenance({
    provenanceText,
    reviewedProvenance,
  });

  return {
    [NAME]: computed(() => "Trusted Provenance Review Surface"),
    [UI]: (
      <cf-card
        id="trusted-provenance-review-surface"
        data-ui-pattern={TRUSTED_PROVENANCE_REVIEW_SURFACE}
        data-ui-event-integrity={`${TRUSTED_PROVENANCE_REVIEW_SURFACE} ${TRUSTED_PROVENANCE_RENDERED_EVIDENCE}`}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted provenance review</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-provenance-review-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Review the provenance disclosure before reusing the content.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label id="trusted-provenance-rendered">
            {TRUSTED_PROVENANCE_RENDERED_EVIDENCE}
          </cf-label>
          <cf-label>{provenanceText}</cf-label>
          <cf-button
            data-ui-action={REVIEW_PROVENANCE_ACTION}
            onClick={reviewProvenance}
          >
            Accept provenance
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Reviewed provenance result</cf-label>
              <div id="trusted-provenance-reviewed">
                {reviewedProvenance}
              </div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    reviewedProvenance,
    reviewProvenance,
  };
});

export interface TrustedFactCheckGateSurfaceInput {
  factCheckClaim: Writable<string>;
  factCheckResult: Writable<string>;
}

export interface TrustedFactCheckGateSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  factCheckResult: TrustedActionWriteWithIntegrity<
    string,
    typeof commitTrustedFactCheckGate,
    typeof FACT_CHECK_GATE_ACTION,
    typeof TRUSTED_FACT_CHECK_GATE_SURFACE,
    [
      typeof TRUSTED_FACT_CHECK_GATE_SURFACE,
      typeof TRUSTED_FACT_CHECK_DISCLAIMER_EVIDENCE,
    ]
  >;
  releaseFactCheckGate: Stream<void>;
}

export const TrustedFactCheckGateSurface = pattern<
  TrustedFactCheckGateSurfaceInput,
  TrustedFactCheckGateSurfaceOutput
>(({ factCheckClaim, factCheckResult }) => {
  const releaseFactCheckGate = commitTrustedFactCheckGate({
    factCheckClaim,
    factCheckResult,
  });

  return {
    [NAME]: computed(() => "Trusted Fact Check Gate Surface"),
    [UI]: (
      <cf-card
        id="trusted-fact-check-gate-surface"
        data-ui-pattern={TRUSTED_FACT_CHECK_GATE_SURFACE}
        data-ui-event-integrity={`${TRUSTED_FACT_CHECK_GATE_SURFACE} ${TRUSTED_FACT_CHECK_DISCLAIMER_EVIDENCE}`}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted fact-check gate</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-fact-check-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Fact-check the claim before allowing it to leave the trusted
                boundary.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label id="trusted-fact-check-rendered">
            {TRUSTED_FACT_CHECK_DISCLAIMER_EVIDENCE}
          </cf-label>
          <cf-label>{factCheckClaim}</cf-label>
          <cf-button
            data-ui-action={FACT_CHECK_GATE_ACTION}
            onClick={releaseFactCheckGate}
          >
            Release after fact-check
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Fact-check result</cf-label>
              <div id="trusted-fact-check-result">{factCheckResult}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    factCheckResult,
    releaseFactCheckGate,
  };
});

export interface TrustedSongIdRecordingSurfaceInput {
  songHint: Writable<string>;
  identifiedSongId: Writable<string>;
}

export interface TrustedSongIdRecordingSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  identifiedSongId: TrustedActionWrite<
    string,
    typeof recordTrustedSongId,
    typeof RECORD_SONG_ID_ACTION,
    typeof TRUSTED_SONG_ID_RECORDING_SURFACE
  >;
  recordSongId: Stream<void>;
}

export const TrustedSongIdRecordingSurface = pattern<
  TrustedSongIdRecordingSurfaceInput,
  TrustedSongIdRecordingSurfaceOutput
>(({ songHint, identifiedSongId }) => {
  const recordSongId = recordTrustedSongId({
    songHint,
    identifiedSongId,
  });

  return {
    [NAME]: computed(() => "Trusted Song ID Recording Surface"),
    [UI]: (
      <cf-card
        id="trusted-song-id-recording-surface"
        data-ui-pattern={TRUSTED_SONG_ID_RECORDING_SURFACE}
        data-ui-event-integrity={TRUSTED_SONG_ID_RECORDING_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted song ID recording</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-song-id-recording-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Record only the song identification result, not raw audio.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label>Mock classifier input</cf-label>
          <cf-label>{songHint}</cf-label>
          <cf-button
            data-ui-action={RECORD_SONG_ID_ACTION}
            onClick={recordSongId}
          >
            Record song ID
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Identified song</cf-label>
              <div id="trusted-song-id-result">{identifiedSongId}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    identifiedSongId,
    recordSongId,
  };
});

export interface TrustedSharePolicySurfaceInput {
  policyAudience: Writable<string>;
  policyScope: Writable<string>;
  savedSharePolicy: Writable<string>;
}

export interface TrustedSharePolicySurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  savedSharePolicy: TrustedActionWrite<
    string,
    typeof saveTrustedSharePolicy,
    typeof SAVE_SHARE_POLICY_ACTION,
    typeof TRUSTED_SHARE_POLICY_SURFACE
  >;
  saveSharePolicy: Stream<void>;
}

export const TrustedSharePolicySurface = pattern<
  TrustedSharePolicySurfaceInput,
  TrustedSharePolicySurfaceOutput
>(({ policyAudience, policyScope, savedSharePolicy }) => {
  const saveSharePolicy = saveTrustedSharePolicy({
    policyAudience,
    policyScope,
    savedSharePolicy,
  });

  return {
    [NAME]: computed(() => "Trusted Share Policy Surface"),
    [UI]: (
      <cf-card
        id="trusted-share-policy-surface"
        data-ui-pattern={TRUSTED_SHARE_POLICY_SURFACE}
        data-ui-event-integrity={TRUSTED_SHARE_POLICY_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted share policy</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-share-policy-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Persist a policy that governs the audience or scope of sharing.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-share-policy-audience">Audience</cf-label>
            <cf-input
              id="trusted-share-policy-audience"
              $value={policyAudience}
              placeholder="internal"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-share-policy-scope">Scope</cf-label>
            <cf-input
              id="trusted-share-policy-scope"
              $value={policyScope}
              placeholder="shared notes"
            />
          </cf-vgroup>
          <cf-button
            data-ui-action={SAVE_SHARE_POLICY_ACTION}
            onClick={saveSharePolicy}
          >
            Save policy
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Saved policy</cf-label>
              <div id="trusted-share-policy-result">{savedSharePolicy}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    savedSharePolicy,
    saveSharePolicy,
  };
});

export interface TrustedLongRunningJobSurfaceInput {
  jobName: Writable<string>;
  jobStatus: Writable<string>;
  jobAuthorization: Writable<string>;
  jobCancellation: Writable<string>;
}

export interface TrustedLongRunningJobSurfaceOutput {
  [NAME]: string;
  [UI]: unknown;
  jobAuthorization: TrustedActionWrite<
    string,
    typeof authorizeTrustedLongRunningJob,
    typeof AUTHORIZE_LONG_RUNNING_JOB_ACTION,
    typeof TRUSTED_LONG_RUNNING_JOB_SURFACE
  >;
  jobCancellation: TrustedActionWrite<
    string,
    typeof cancelTrustedLongRunningJob,
    typeof CANCEL_LONG_RUNNING_JOB_ACTION,
    typeof TRUSTED_LONG_RUNNING_JOB_SURFACE
  >;
  startJob: Stream<void>;
  cancelJob: Stream<void>;
}

export const TrustedLongRunningJobSurface = pattern<
  TrustedLongRunningJobSurfaceInput,
  TrustedLongRunningJobSurfaceOutput
>(
  ({ jobName, jobStatus, jobAuthorization, jobCancellation }) => {
    const startJob = authorizeTrustedLongRunningJob({
      jobName,
      jobStatus,
      jobAuthorization,
    });
    const cancelJob = cancelTrustedLongRunningJob({
      jobName,
      jobStatus,
      jobCancellation,
    });

    return {
      [NAME]: computed(() => "Trusted Long Running Job Surface"),
      [UI]: (
        <cf-card
          id="trusted-long-running-job-surface"
          data-ui-pattern={TRUSTED_LONG_RUNNING_JOB_SURFACE}
          data-ui-event-integrity={TRUSTED_LONG_RUNNING_JOB_SURFACE}
        >
          <cf-vstack slot="content" gap="3">
            <cf-heading level={3}>Trusted long-running job</cf-heading>
            <cf-card data-ui-disclosure-kind="trusted-long-running-job-disclosure">
              <cf-vstack slot="content" gap="1">
                <cf-label>
                  Keep the job visible and cancelable while the trusted kernel
                  authorizes it.
                </cf-label>
              </cf-vstack>
            </cf-card>
            <cf-vgroup gap="sm">
              <cf-label for="trusted-job-name">Job name</cf-label>
              <cf-input
                id="trusted-job-name"
                $value={jobName}
                placeholder="Bulk export"
              />
            </cf-vgroup>
            <cf-hstack gap="2" wrap>
              <cf-button
                data-ui-action={AUTHORIZE_LONG_RUNNING_JOB_ACTION}
                onClick={startJob}
              >
                Authorize job
              </cf-button>
              <cf-button
                data-ui-action={CANCEL_LONG_RUNNING_JOB_ACTION}
                onClick={cancelJob}
              >
                Cancel job
              </cf-button>
            </cf-hstack>
            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-label>Current status</cf-label>
                <div id="trusted-job-status">{jobStatus}</div>
                <cf-label>Authorization</cf-label>
                <div id="trusted-job-authorization">{jobAuthorization}</div>
                <cf-label>Cancellation</cf-label>
                <div id="trusted-job-cancellation">{jobCancellation}</div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-card>
      ),
      jobAuthorization,
      jobCancellation,
      startJob,
      cancelJob,
    };
  },
);

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
