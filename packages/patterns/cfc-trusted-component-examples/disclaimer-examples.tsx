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
  acknowledgeTrustedDisclaimer,
  commitTrustedFactCheckGate,
  reviewTrustedProvenance,
  TrustedDisclaimerAckSurface,
  TrustedFactCheckGateSurface,
  TrustedProvenanceReviewSurface,
} from "../cfc-trusted-surfaces/main.tsx";

const setMessage = handler<
  void,
  { value: Writable<string>; next: string }
>((_, { value, next }) => {
  value.set(next);
});

const runAndSummarize = handler<
  void,
  {
    stream: Stream<void>;
    summary: Writable<string>;
    next: string;
  }
>((_, { stream, summary, next }) => {
  stream.send();
  summary.set(next);
});

type BaseSpec = {
  title: string;
  summary: string;
  content: string;
  fakeButton: string;
  fakeMessage: string;
};

type AckSpec = BaseSpec & {
  disclaimer: string;
};

type ReviewSpec = BaseSpec & {
  provenanceText: string;
};

type FactCheckSpec = BaseSpec & {
  claim: string;
};

function buildAckExample(spec: AckSpec) {
  return pattern(() => {
    const disclaimerText = Writable.of(spec.disclaimer);
    const acknowledgedDisclaimer = Writable.of("");
    const fakeStatus = Writable.of("Lookalike control is idle.");
    const hostSummary = Writable.of("");

    const trustedSurface = TrustedDisclaimerAckSurface({
      disclaimerText,
      acknowledgedDisclaimer,
    });

    const acknowledge = acknowledgeTrustedDisclaimer({
      disclaimerText,
      acknowledgedDisclaimer,
    });
    const runAcknowledgeExample = runAndSummarize({
      stream: acknowledge,
      summary: hostSummary,
      next: `${spec.title}: trusted acknowledgement complete`,
    });
    const fakeAcknowledge = setMessage({
      value: fakeStatus,
      next: spec.fakeMessage,
    });

    return {
      [NAME]: computed(() => spec.title),
      [UI]: (
        <cf-screen title={spec.title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{spec.title}</cf-heading>
                <cf-label>{spec.summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{spec.content}</div>
                  </cf-vstack>
                </cf-card>
                {trustedSurface[UI]}
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host control</cf-label>
                    <cf-button onClick={fakeAcknowledge}>
                      {spec.fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      acknowledgedDisclaimer,
      acknowledge,
      runAcknowledgeExample,
      fakeAcknowledge,
      fakeStatus,
      hostSummary,
    };
  });
}

function buildReviewExample(spec: ReviewSpec) {
  return pattern(() => {
    const provenanceText = Writable.of(spec.provenanceText);
    const reviewedProvenance = Writable.of("");
    const fakeStatus = Writable.of("Lookalike review control is idle.");
    const hostSummary = Writable.of("");

    const trustedSurface = TrustedProvenanceReviewSurface({
      provenanceText,
      reviewedProvenance,
    });

    const review = reviewTrustedProvenance({
      provenanceText,
      reviewedProvenance,
    });
    const runReviewExample = runAndSummarize({
      stream: review,
      summary: hostSummary,
      next: `${spec.title}: trusted provenance review complete`,
    });
    const fakeReview = setMessage({
      value: fakeStatus,
      next: spec.fakeMessage,
    });

    return {
      [NAME]: computed(() => spec.title),
      [UI]: (
        <cf-screen title={spec.title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{spec.title}</cf-heading>
                <cf-label>{spec.summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{spec.content}</div>
                  </cf-vstack>
                </cf-card>
                {trustedSurface[UI]}
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host provenance card</cf-label>
                    <cf-button onClick={fakeReview}>
                      {spec.fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      reviewedProvenance,
      review,
      runReviewExample,
      fakeReview,
      fakeStatus,
      hostSummary,
    };
  });
}

function buildFactCheckExample(spec: FactCheckSpec) {
  return pattern(() => {
    const factCheckClaim = Writable.of(spec.claim);
    const factCheckResult = Writable.of("");
    const fakeStatus = Writable.of("Lookalike fact-check gate is idle.");
    const hostSummary = Writable.of("");

    const trustedSurface = TrustedFactCheckGateSurface({
      factCheckClaim,
      factCheckResult,
    });

    const releaseFactCheckGate = commitTrustedFactCheckGate({
      factCheckClaim,
      factCheckResult,
    });
    const runFactCheckExample = runAndSummarize({
      stream: releaseFactCheckGate,
      summary: hostSummary,
      next: `${spec.title}: trusted fact-check gate approved`,
    });
    const fakeApproveFactCheck = setMessage({
      value: fakeStatus,
      next: spec.fakeMessage,
    });

    return {
      [NAME]: computed(() => spec.title),
      [UI]: (
        <cf-screen title={spec.title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{spec.title}</cf-heading>
                <cf-label>{spec.summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{spec.content}</div>
                  </cf-vstack>
                </cf-card>
                {trustedSurface[UI]}
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host fact-check card</cf-label>
                    <cf-button onClick={fakeApproveFactCheck}>
                      {spec.fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      factCheckResult,
      releaseFactCheckGate,
      runFactCheckExample,
      fakeApproveFactCheck,
      fakeStatus,
      hostSummary,
    };
  });
}

export const DisclaimerPromptRoutingAckExample = buildAckExample({
  title: "Prompt routing ack",
  summary:
    "A routing-sensitive disclaimer must be rendered before the recipient can be acknowledged.",
  content: "Route this note to the verified recipient only.",
  disclaimer: "Routing can be influenced by prompt-derived text.",
  fakeButton: "Fake route ack",
  fakeMessage: "Lookalike routing ack did not update the trusted output.",
});

export const DisclaimerAIGeneratedContentAckExample = buildAckExample({
  title: "AI-generated content disclaimer",
  summary:
    "An AI-generated disclosure is rendered alongside the content before the user can acknowledge it.",
  content: "Draft social copy for the launch announcement.",
  disclaimer: "This content was generated by AI and may need review.",
  fakeButton: "Fake AI ack",
  fakeMessage: "The host lookalike did not acknowledge the trusted disclaimer.",
});

export const DisclaimerMedicalInfoAckExample = buildAckExample({
  title: "Medical-style information disclaimer",
  summary:
    "An informational disclaimer is bound to the content before the acknowledgment can produce the trusted output.",
  content: "Medication summary and dosage reminder.",
  disclaimer: "Informational only. Not medical advice.",
  fakeButton: "Fake medical ack",
  fakeMessage: "Lookalike health disclaimer was not accepted.",
});

export const DisclaimerRedactedSummaryAckExample = buildAckExample({
  title: "Redacted summary disclaimer",
  summary:
    "The host shows a redacted derivative only after the trusted disclaimer is rendered with it.",
  content: "Redacted incident summary for the internal audience.",
  disclaimer: "Redacted from a more detailed report.",
  fakeButton: "Fake redaction ack",
  fakeMessage: "Lookalike redaction note did not update the protected summary.",
});

export const DisclaimerCitationSupportAckExample = buildAckExample({
  title: "Citation support disclaimer",
  summary:
    "A support disclaimer is displayed before the content can be acknowledged as citation-backed.",
  content: "Claim: the release improved build times.",
  disclaimer: "Supported by cited sources and reviewer notes.",
  fakeButton: "Fake citation ack",
  fakeMessage: "Lookalike citation support did not change the output.",
});

export const DisclaimerConfidentialSourceAckExample = buildAckExample({
  title: "Confidential source disclaimer",
  summary:
    "A confidentiality disclaimer is required before the host can acknowledge the source-restricted content.",
  content: "Sensitive source excerpt for internal circulation only.",
  disclaimer: "Do not redistribute outside the approved group.",
  fakeButton: "Fake confidential ack",
  fakeMessage: "Lookalike confidential note left the trusted output unchanged.",
});

export const DisclaimerPublicPostAckExample = buildAckExample({
  title: "Public-post disclaimer",
  summary:
    "A publication disclaimer is rendered with the post before acknowledgment is possible.",
  content: "Draft public post for the product launch.",
  disclaimer: "Public-facing content. Review for accuracy before publish.",
  fakeButton: "Fake public-post ack",
  fakeMessage: "Lookalike publish note did not acknowledge the trusted post.",
});

export const DisclaimerInternalMemoAckExample = buildAckExample({
  title: "Internal memo disclaimer",
  summary:
    "The host memo includes the disclaimer surface, but the trusted output only changes after the trusted action fires.",
  content: "Internal memo about rollout sequencing.",
  disclaimer: "Internal use only.",
  fakeButton: "Fake memo ack",
  fakeMessage: "The memo lookalike never changed the protected output.",
});

export const DisclaimerSourceProvenanceReviewExample = buildReviewExample({
  title: "Source provenance review",
  summary:
    "A provenance review surface binds the source and the review note together before releasing the reviewed text.",
  content: "Shared source excerpt for the design review.",
  provenanceText: "Source provenance: shared by the project owner.",
  fakeButton: "Fake provenance review",
  fakeMessage:
    "The lookalike provenance card did not update the reviewed text.",
});

export const DisclaimerCitationProvenanceReviewExample = buildReviewExample({
  title: "Citation provenance review",
  summary:
    "The trusted provenance review is paired with citations before the host can claim the content is review-backed.",
  content: "Claim that requires citation provenance.",
  provenanceText: "Citations verified against the source list.",
  fakeButton: "Fake citation review",
  fakeMessage: "The lookalike citation provenance card did not change output.",
});

export const DisclaimerPublicPostProvenanceReviewExample = buildReviewExample({
  title: "Public-post provenance review",
  summary:
    "The public-post example exposes provenance review before release to the wider audience.",
  content: "Public status update draft.",
  provenanceText: "Provenance review required before public release.",
  fakeButton: "Fake public review",
  fakeMessage: "The lookalike public-post card left the trusted output alone.",
});

export const DisclaimerConfidentialProvenanceReviewExample = buildReviewExample(
  {
    title: "Confidential provenance review",
    summary:
      "A confidential-source provenance note is rendered alongside the content before review can happen.",
    content: "Confidential report excerpt.",
    provenanceText: "Confidential provenance requires approved circulation.",
    fakeButton: "Fake confidential review",
    fakeMessage:
      "The lookalike confidential provenance card did not review anything.",
  },
);

export const DisclaimerFactCheckBriefExample = buildFactCheckExample({
  title: "Fact-check brief gate",
  summary:
    "A fact-check gate is rendered with the brief before the trusted approved output is produced.",
  content: "External brief about launch performance.",
  claim: "External brief about launch performance.",
  fakeButton: "Fake fact-check",
  fakeMessage: "The lookalike fact-check gate did not approve the brief.",
});

export const DisclaimerFactCheckReleaseExample = buildFactCheckExample({
  title: "Fact-check release gate",
  summary:
    "The release gate ensures the verified brief is shown with its disclaimer before approval.",
  content: "Release note for the launch checklist.",
  claim: "Release note for the launch checklist.",
  fakeButton: "Fake release gate",
  fakeMessage: "The lookalike release gate never updated the approved text.",
});

export const DisclaimerFactCheckClaimsExample = buildFactCheckExample({
  title: "Fact-check claims gate",
  summary:
    "A claims gate sits next to the drafted claim before the trusted approval output can change.",
  content: "Claim about the incident response timeline.",
  claim: "Claim about the incident response timeline.",
  fakeButton: "Fake claims gate",
  fakeMessage: "The lookalike claims gate left the approved text unchanged.",
});

export const DisclaimerLookalikeHostExample = buildAckExample({
  title: "Lookalike disclaimer host",
  summary:
    "This example renders a visible host control that looks similar but does not call the trusted acknowledgement stream.",
  content: "Host-controlled disclaimer demo.",
  disclaimer: "Trusted output only changes when the reviewed button is used.",
  fakeButton: "Fake trusted button",
  fakeMessage: "The host lookalike never changed the trusted output.",
});

const EXAMPLE_COMPONENTS = [
  DisclaimerPromptRoutingAckExample,
  DisclaimerAIGeneratedContentAckExample,
  DisclaimerMedicalInfoAckExample,
  DisclaimerRedactedSummaryAckExample,
  DisclaimerCitationSupportAckExample,
  DisclaimerConfidentialSourceAckExample,
  DisclaimerPublicPostAckExample,
  DisclaimerInternalMemoAckExample,
  DisclaimerSourceProvenanceReviewExample,
  DisclaimerCitationProvenanceReviewExample,
  DisclaimerPublicPostProvenanceReviewExample,
  DisclaimerConfidentialProvenanceReviewExample,
  DisclaimerFactCheckBriefExample,
  DisclaimerFactCheckReleaseExample,
  DisclaimerFactCheckClaimsExample,
  DisclaimerLookalikeHostExample,
] as const;

const EXAMPLE_TITLES = [
  "Prompt routing ack",
  "AI-generated content disclaimer",
  "Medical-style information disclaimer",
  "Redacted summary disclaimer",
  "Citation support disclaimer",
  "Confidential source disclaimer",
  "Public-post disclaimer",
  "Internal memo disclaimer",
  "Source provenance review",
  "Citation provenance review",
  "Public-post provenance review",
  "Confidential provenance review",
  "Fact-check brief gate",
  "Fact-check release gate",
  "Fact-check claims gate",
  "Lookalike disclaimer host",
] as const;

export default pattern(() => ({
  [NAME]: computed(() => "Disclaimer Example Gallery"),
  [UI]: (
    <cf-screen title="Disclaimer Example Gallery">
      <cf-vstack gap="3" style={{ padding: "1rem" }}>
        <cf-card>
          <cf-vstack slot="content" gap="2">
            <cf-heading level={2}>
              Disclaimer and provenance examples
            </cf-heading>
            <cf-label>
              These examples are intentionally untrusted host wrappers that
              embed reviewed disclaimer surfaces and visible lookalike controls.
            </cf-label>
            <cf-label>
              The gallery currently exposes {EXAMPLE_COMPONENTS.length}{" "}
              example patterns.
            </cf-label>
            <cf-card>
              <cf-vstack slot="content" gap="1">
                <cf-label>Included patterns</cf-label>
                <div>
                  {EXAMPLE_TITLES.map((title) => <div>{title}</div>)}
                </div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-card>
      </cf-vstack>
    </cf-screen>
  ),
  exampleCount: EXAMPLE_COMPONENTS.length,
}));
