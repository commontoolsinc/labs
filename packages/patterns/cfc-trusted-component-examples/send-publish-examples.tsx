import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";
import {
  TrustedAudiencePublishSurface,
  TrustedConversationSendSurface,
  TrustedDirectCommandSurface,
  TrustedPublishSurface,
  TrustedReviewSurface,
  TrustedSaveDraftSurface,
} from "../cfc-trusted-surfaces/main.tsx";

const runDecoy = handler<
  void,
  { result: Writable<string>; message: string }
>((_, { result, message }) => {
  result.set(message);
});

type SendExampleOutput = {
  [NAME]: string;
  [UI]: unknown;
  conversationTitle?: string;
  audienceInput?: string;
  messageDraft?: string;
  commandInput?: string;
  decoyResult: string;
  sentMessage?: string;
  capturedCommand?: string;
  preparedBrief?: string;
  authorizedSend?: string;
  prepareConversation?: Stream<void>;
  sendMessage?: Stream<void>;
  captureCommand?: Stream<void>;
  prepareBrief?: Stream<void>;
  authorizeSend?: Stream<void>;
  triggerDecoy: Stream<void>;
};

type PublishExampleOutput = {
  [NAME]: string;
  [UI]: unknown;
  targetAudience?: string;
  publishSubject?: string;
  publishBody?: string;
  draftTitle?: string;
  draftBody?: string;
  decoyResult: string;
  preparedAudiencePublish?: string;
  publishedAudiencePost?: string;
  savedTitle?: string;
  savedBody?: string;
  reviewedTitle?: string;
  reviewedBody?: string;
  publishedTitle?: string;
  publishedBody?: string;
  saveDraft?: Stream<void>;
  reviewSaved?: Stream<void>;
  publishReviewed?: Stream<void>;
  prepareAudiencePublish?: Stream<void>;
  publishAudiencePost?: Stream<void>;
  triggerDecoy: Stream<void>;
};

export const ChatThreadSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Chat thread: project sync");
  const audienceInput = Writable.of("team thread");
  const messageDraft = Writable.of(
    "Please forward the short thread excerpt to the next owner.",
  );
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Host shortcut ignored; only the trusted send surface counts.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Chat Thread Send"),
    [UI]: (
      <cf-screen title="Chat Thread Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The host offers a lookalike control, but only the trusted
                conversation surface can authorize the send.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const IncidentChannelSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Incident channel: pager alert");
  const audienceInput = Writable.of("incident room");
  const messageDraft = Writable.of(
    "Pager fired, we only forward the bounded incident excerpt.",
  );
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Host incident button is not trusted.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Incident Channel Send"),
    [UI]: (
      <cf-screen title="Incident Channel Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The host incident shortcut is visible, but it does not bless the
                write.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const DirectMessageSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const commandInput = Writable.of(
    "Send the short summary to the client contact.",
  );
  const capturedCommand = Writable.of("");
  const preparedBrief = Writable.of("");
  const authorizedSend = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Untrusted DM button does not authorize sending.",
  });
  const trusted = TrustedDirectCommandSurface({
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
  });

  return {
    [NAME]: computed(() => "Direct Message Send"),
    [UI]: (
      <cf-screen title="Direct Message Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The DM chrome is decorative only.</cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
    decoyResult,
    captureCommand: trusted.captureCommand,
    prepareBrief: trusted.prepareBrief,
    authorizeSend: trusted.authorizeSend,
    triggerDecoy,
  };
});

export const SupportCaseReplyExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Support case: ticket reply");
  const audienceInput = Writable.of("support queue");
  const messageDraft = Writable.of(
    "Reply with the ticket-safe excerpt and next step.",
  );
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "The case toolbar shortcut is only a lookalike.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Support Case Reply"),
    [UI]: (
      <cf-screen title="Support Case Reply">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The reply box is embedded in support chrome, but only the
                trusted surface can release the message.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Reply without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const ClassroomAnnouncementExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("classroom");
  const publishSubject = Writable.of("Exam schedule update");
  const publishBody = Writable.of(
    "The next review session is moved to Thursday afternoon.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Classroom publish shortcut is not trusted.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Classroom Announcement"),
    [UI]: (
      <cf-screen title="Classroom Announcement">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The host post button is a decoy.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const ProjectUpdatePublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("project board");
  const publishSubject = Writable.of("Milestone delta");
  const publishBody = Writable.of(
    "The ship target moved by two days; release scope stayed fixed.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Project publish banner is only decorative.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Project Update Publish"),
    [UI]: (
      <cf-screen title="Project Update Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The project banner is not authoritative.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const ReleaseNotesPublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const draftTitle = Writable.of("v2.8 release notes");
  const draftBody = Writable.of(
    "This release includes a rollback-safe migration and UI polish.",
  );
  const savedTitle = Writable.of("");
  const savedBody = Writable.of("");
  const reviewedTitle = Writable.of("");
  const reviewedBody = Writable.of("");
  const publishedTitle = Writable.of("");
  const publishedBody = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Release notes quick-publish button is untrusted.",
  });
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

  return {
    [NAME]: computed(() => "Release Notes Publish"),
    [UI]: (
      <cf-screen title="Release Notes Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The host quick-publish link is a decoy.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trustedSaveDraft[UI] as never}
          {trustedReview[UI] as never}
          {trustedPublish[UI] as never}
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
    decoyResult,
    saveDraft: trustedSaveDraft.saveDraft,
    reviewSaved: trustedReview.reviewSaved,
    publishReviewed: trustedPublish.publishReviewed,
    triggerDecoy,
  };
});

export const PublicStatusPublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("public status");
  const publishSubject = Writable.of("Service status update");
  const publishBody = Writable.of(
    "All systems are operational after the maintenance window.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Status-page publish link is not the trusted path.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Public Status Publish"),
    [UI]: (
      <cf-screen title="Public Status Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The public-status shortcut is a lookalike.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const InternalRepostExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const draftTitle = Writable.of("Internal recap");
  const draftBody = Writable.of(
    "This stays inside the team channel and never becomes public.",
  );
  const savedTitle = Writable.of("");
  const savedBody = Writable.of("");
  const reviewedTitle = Writable.of("");
  const reviewedBody = Writable.of("");
  const publishedTitle = Writable.of("");
  const publishedBody = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Repost button in the host shell is not blessed.",
  });
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

  return {
    [NAME]: computed(() => "Internal Repost"),
    [UI]: (
      <cf-screen title="Internal Repost">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The repost shortcut is just a decorative affordance.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trustedSaveDraft[UI] as never}
          {trustedReview[UI] as never}
          {trustedPublish[UI] as never}
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
    decoyResult,
    saveDraft: trustedSaveDraft.saveDraft,
    reviewSaved: trustedReview.reviewSaved,
    publishReviewed: trustedPublish.publishReviewed,
    triggerDecoy,
  };
});

export const TeamDigestPublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("team digest");
  const publishSubject = Writable.of("Weekly digest");
  const publishBody = Writable.of(
    "Top issues, resolved items, and a short owner list.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Digest shortcut is just a lookalike control.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Team Digest Publish"),
    [UI]: (
      <cf-screen title="Team Digest Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The digest shortcut does not carry authority.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const RoadmapUpdatePublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("roadmap viewers");
  const publishSubject = Writable.of("Roadmap checkpoint");
  const publishBody = Writable.of(
    "We only release the approved milestone slice here.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Roadmap release shortcut is untrusted.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Roadmap Update Publish"),
    [UI]: (
      <cf-screen title="Roadmap Update Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The roadmap publish shortcut is not blessed.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const IncidentSummaryPublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("incident review board");
  const publishSubject = Writable.of("Incident summary");
  const publishBody = Writable.of(
    "Root cause and mitigation were confirmed by on-call.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Incident publish shortcut is a decoy.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Incident Summary Publish"),
    [UI]: (
      <cf-screen title="Incident Summary Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The incident publish shortcut is a fake control.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const PolicyPublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const draftTitle = Writable.of("Policy revision");
  const draftBody = Writable.of(
    "The policy wording changed, but the meaning stayed bounded.",
  );
  const savedTitle = Writable.of("");
  const savedBody = Writable.of("");
  const reviewedTitle = Writable.of("");
  const reviewedBody = Writable.of("");
  const publishedTitle = Writable.of("");
  const publishedBody = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Policy publish control is not trusted.",
  });
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

  return {
    [NAME]: computed(() => "Policy Publish"),
    [UI]: (
      <cf-screen title="Policy Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The policy publish shortcut is a lookalike.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trustedSaveDraft[UI] as never}
          {trustedReview[UI] as never}
          {trustedPublish[UI] as never}
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
    decoyResult,
    saveDraft: trustedSaveDraft.saveDraft,
    reviewSaved: trustedReview.reviewSaved,
    publishReviewed: trustedPublish.publishReviewed,
    triggerDecoy,
  };
});

export const ChangelogPublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("product changelog");
  const publishSubject = Writable.of("Changelog entry");
  const publishBody = Writable.of(
    "Two fixes and one behavior clarification are ready.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Changelog host button is not authoritative.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Changelog Publish"),
    [UI]: (
      <cf-screen title="Changelog Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The changelog host button is just a lookalike.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const LaunchReadinessPublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("launch review");
  const publishSubject = Writable.of("Launch readiness");
  const publishBody = Writable.of(
    "Beta checklist is complete and the release gate stayed closed.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Launch-ready button is a lookalike.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Launch Readiness Publish"),
    [UI]: (
      <cf-screen title="Launch Readiness Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The launch-ready button is only decorative.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const EmbeddedComposerSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Nested composer");
  const audienceInput = Writable.of("embedded composer");
  const messageDraft = Writable.of(
    "Send only the bounded excerpt from the nested composer.",
  );
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Embedded composer shortcut does not count.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Embedded Composer Send"),
    [UI]: (
      <cf-screen title="Embedded Composer Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The nested composer button is not the trusted path.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const TeamDigestContextSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Team digest context");
  const audienceInput = Writable.of("digest recipients");
  const messageDraft = Writable.of(
    "Forward just the digest summary and not the raw notes.",
  );
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Context send is only a fake affordance.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Team Digest Context Send"),
    [UI]: (
      <cf-screen title="Team Digest Context Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The context send is visible but untrusted.</cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const ExecutiveBriefSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const commandInput = Writable.of(
    "Prepare and send the executive-safe brief.",
  );
  const capturedCommand = Writable.of("");
  const preparedBrief = Writable.of("");
  const authorizedSend = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Executive brief button is not trusted.",
  });
  const trusted = TrustedDirectCommandSurface({
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
  });

  return {
    [NAME]: computed(() => "Executive Brief Send"),
    [UI]: (
      <cf-screen title="Executive Brief Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The executive brief shortcut does not authorize a send.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
    decoyResult,
    captureCommand: trusted.captureCommand,
    prepareBrief: trusted.prepareBrief,
    authorizeSend: trusted.authorizeSend,
    triggerDecoy,
  };
});

export const SupportEscalationSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const commandInput = Writable.of(
    "Escalate the issue and keep the response concise.",
  );
  const capturedCommand = Writable.of("");
  const preparedBrief = Writable.of("");
  const authorizedSend = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Support escalation shortcut is a decoy.",
  });
  const trusted = TrustedDirectCommandSurface({
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
  });

  return {
    [NAME]: computed(() => "Support Escalation Send"),
    [UI]: (
      <cf-screen title="Support Escalation Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The escalation shortcut is not the trusted path.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
    decoyResult,
    captureCommand: trusted.captureCommand,
    prepareBrief: trusted.prepareBrief,
    authorizeSend: trusted.authorizeSend,
    triggerDecoy,
  };
});

export const CustomerReplySendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Customer reply");
  const audienceInput = Writable.of("customer support");
  const messageDraft = Writable.of("Reply with the safe account status only.");
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Customer reply control is not the trusted path.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Customer Reply Send"),
    [UI]: (
      <cf-screen title="Customer Reply Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The reply control is only a lookalike.</cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const ClassroomDigestSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Classroom digest");
  const audienceInput = Writable.of("students");
  const messageDraft = Writable.of(
    "Send the class digest and omit the raw teacher notes.",
  );
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Classroom send button is untrusted.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Classroom Digest Send"),
    [UI]: (
      <cf-screen title="Classroom Digest Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The classroom send button is just a fake affordance.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const InternalOnlyRepostExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const draftTitle = Writable.of("Internal repost");
  const draftBody = Writable.of(
    "This stays in the internal channel and never widens.",
  );
  const savedTitle = Writable.of("");
  const savedBody = Writable.of("");
  const reviewedTitle = Writable.of("");
  const reviewedBody = Writable.of("");
  const publishedTitle = Writable.of("");
  const publishedBody = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Internal repost shortcut is not trusted.",
  });
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

  return {
    [NAME]: computed(() => "Internal Only Repost"),
    [UI]: (
      <cf-screen title="Internal Only Repost">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The repost control is not blessed.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trustedSaveDraft[UI] as never}
          {trustedReview[UI] as never}
          {trustedPublish[UI] as never}
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
    decoyResult,
    saveDraft: trustedSaveDraft.saveDraft,
    reviewSaved: trustedReview.reviewSaved,
    publishReviewed: trustedPublish.publishReviewed,
    triggerDecoy,
  };
});

export const PublicBulletinExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("public bulletin");
  const publishSubject = Writable.of("Public bulletin");
  const publishBody = Writable.of(
    "This version is ready for the public-facing board.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Public bulletin shortcut is only a lookalike.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Public Bulletin"),
    [UI]: (
      <cf-screen title="Public Bulletin">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The public bulletin shortcut is not trusted.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const StagedAnnouncementExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const draftTitle = Writable.of("Announcement draft");
  const draftBody = Writable.of(
    "The final announcement is only published after review.",
  );
  const savedTitle = Writable.of("");
  const savedBody = Writable.of("");
  const reviewedTitle = Writable.of("");
  const reviewedBody = Writable.of("");
  const publishedTitle = Writable.of("");
  const publishedBody = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Announcement quick-post is not blessed.",
  });
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

  return {
    [NAME]: computed(() => "Staged Announcement"),
    [UI]: (
      <cf-screen title="Staged Announcement">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The quick-post control is a decoy.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trustedSaveDraft[UI] as never}
          {trustedReview[UI] as never}
          {trustedPublish[UI] as never}
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
    decoyResult,
    saveDraft: trustedSaveDraft.saveDraft,
    reviewSaved: trustedReview.reviewSaved,
    publishReviewed: trustedPublish.publishReviewed,
    triggerDecoy,
  };
});

export const AnnouncementQueueExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("announcement queue");
  const publishSubject = Writable.of("Queued announcement");
  const publishBody = Writable.of(
    "Wait for the review step before exposing this update.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Queue publish button is a fake control.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Announcement Queue"),
    [UI]: (
      <cf-screen title="Announcement Queue">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The queue publish button is not trusted.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const VisibleQueueExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("visible queue");
  const publishSubject = Writable.of("Queue entry");
  const publishBody = Writable.of(
    "The publish queue is visible, but only the trusted flow works.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Visible queue shortcut is not trusted.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Visible Queue"),
    [UI]: (
      <cf-screen title="Visible Queue">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The queue shortcut is only a lookalike.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

export const ConversationTargetSendExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Conversation target");
  const audienceInput = Writable.of("current conversation");
  const messageDraft = Writable.of("Target the current conversation only.");
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Conversation target shortcut is a decoy.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Conversation Target Send"),
    [UI]: (
      <cf-screen title="Conversation Target Send">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The conversation-target shortcut does not authorize sending.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const HostLookalikeControlExample = pattern<
  Record<PropertyKey, never>,
  SendExampleOutput
>(() => {
  const conversationTitle = Writable.of("Lookalike host control");
  const audienceInput = Writable.of("trusted send");
  const messageDraft = Writable.of(
    "The host's own control must not authorize the send.",
  );
  const sentMessage = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Lookalike host control updated, not the protected output.",
  });
  const trusted = TrustedConversationSendSurface({
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
  });

  return {
    [NAME]: computed(() => "Host Lookalike Control"),
    [UI]: (
      <cf-screen title="Host Lookalike Control">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The host control looks plausible but stays untrusted.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Send without trust</cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    conversationTitle,
    audienceInput,
    messageDraft,
    sentMessage,
    sendMessage: trusted.sendMessage,
    decoyResult,
    triggerDecoy,
  };
});

export const InternalNoteRepostExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const draftTitle = Writable.of("Internal note");
  const draftBody = Writable.of(
    "The note remains bounded to the approved audience.",
  );
  const savedTitle = Writable.of("");
  const savedBody = Writable.of("");
  const reviewedTitle = Writable.of("");
  const reviewedBody = Writable.of("");
  const publishedTitle = Writable.of("");
  const publishedBody = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Internal note repost button is not trusted.",
  });
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

  return {
    [NAME]: computed(() => "Internal Note Repost"),
    [UI]: (
      <cf-screen title="Internal Note Repost">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>
                The note repost control is not the trusted path.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trustedSaveDraft[UI] as never}
          {trustedReview[UI] as never}
          {trustedPublish[UI] as never}
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
    decoyResult,
    saveDraft: trustedSaveDraft.saveDraft,
    reviewSaved: trustedReview.reviewSaved,
    publishReviewed: trustedPublish.publishReviewed,
    triggerDecoy,
  };
});

export const MeetingRecapPublishExample = pattern<
  Record<PropertyKey, never>,
  PublishExampleOutput
>(() => {
  const targetAudience = Writable.of("meeting recap");
  const publishSubject = Writable.of("Meeting recap");
  const publishBody = Writable.of(
    "Only the approved summary is released here.",
  );
  const preparedAudiencePublish = Writable.of("");
  const publishedAudiencePost = Writable.of("");
  const decoyResult = Writable.of("");
  const triggerDecoy = runDecoy({
    result: decoyResult,
    message: "Meeting recap quick-post is only decorative.",
  });
  const trusted = TrustedAudiencePublishSurface({
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
  });

  return {
    [NAME]: computed(() => "Meeting Recap Publish"),
    [UI]: (
      <cf-screen title="Meeting Recap Publish">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted host wrapper</cf-heading>
              <cf-label>The recap button is only a fake affordance.</cf-label>
              <cf-button onClick={triggerDecoy}>
                Publish without trust
              </cf-button>
              <div>{decoyResult}</div>
            </cf-vstack>
          </cf-card>
          {trusted[UI] as never}
        </cf-vstack>
      </cf-screen>
    ),
    targetAudience,
    publishSubject,
    publishBody,
    preparedAudiencePublish,
    publishedAudiencePost,
    decoyResult,
    prepareAudiencePublish: trusted.prepareAudiencePublish,
    publishAudiencePost: trusted.publishAudiencePost,
    triggerDecoy,
  };
});

const exampleTitles = [
  "Chat Thread Send",
  "Incident Channel Send",
  "Direct Message Send",
  "Support Case Reply",
  "Classroom Announcement",
  "Project Update Publish",
  "Release Notes Publish",
  "Public Status Publish",
  "Internal Repost",
  "Team Digest Publish",
  "Roadmap Update Publish",
  "Incident Summary Publish",
  "Policy Publish",
  "Changelog Publish",
  "Launch Readiness Publish",
  "Embedded Composer Send",
  "Team Digest Context Send",
  "Executive Brief Send",
  "Support Escalation Send",
  "Customer Reply Send",
  "Classroom Digest Send",
  "Internal Only Repost",
  "Public Bulletin",
  "Staged Announcement",
  "Announcement Queue",
  "Visible Queue",
  "Conversation Target Send",
  "Host Lookalike Control",
  "Internal Note Repost",
  "Meeting Recap Publish",
] as const;

export const SEND_PUBLISH_EXAMPLE_COUNT = 30;
export const SEND_PUBLISH_RENDERED_EXAMPLE_COUNT = 30;

export default pattern<Record<PropertyKey, never>>(() => {
  const renderedExamples = [
    ChatThreadSendExample({}),
    IncidentChannelSendExample({}),
    DirectMessageSendExample({}),
    SupportCaseReplyExample({}),
    ClassroomAnnouncementExample({}),
    ProjectUpdatePublishExample({}),
    ReleaseNotesPublishExample({}),
    PublicStatusPublishExample({}),
    InternalRepostExample({}),
    TeamDigestPublishExample({}),
    RoadmapUpdatePublishExample({}),
    IncidentSummaryPublishExample({}),
    PolicyPublishExample({}),
    ChangelogPublishExample({}),
    LaunchReadinessPublishExample({}),
    EmbeddedComposerSendExample({}),
    TeamDigestContextSendExample({}),
    ExecutiveBriefSendExample({}),
    SupportEscalationSendExample({}),
    CustomerReplySendExample({}),
    ClassroomDigestSendExample({}),
    InternalOnlyRepostExample({}),
    PublicBulletinExample({}),
    StagedAnnouncementExample({}),
    AnnouncementQueueExample({}),
    VisibleQueueExample({}),
    ConversationTargetSendExample({}),
    HostLookalikeControlExample({}),
    InternalNoteRepostExample({}),
    MeetingRecapPublishExample({}),
  ];

  return {
    [NAME]: computed(() => "Send / Publish Trusted Component Examples"),
    [UI]: (
      <cf-screen title="Send / Publish Trusted Component Examples">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>Untrusted host wrappers</cf-heading>
              <cf-label>
                These examples embed reviewed trusted send and publish surfaces
                in deliberately untrusted hosts. The host controls are visible
                but do not authorize protected writes.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Catalog</cf-heading>
              {exampleTitles.map((title, index) => (
                <div>
                  {index + 1}. {title}
                </div>
              ))}
            </cf-vstack>
          </cf-card>
          {renderedExamples.map((example) => <div>{example[UI] as never}</div>)}
        </cf-vstack>
      </cf-screen>
    ),
    exampleCount: SEND_PUBLISH_EXAMPLE_COUNT,
    renderedExampleCount: renderedExamples.length,
  };
});
