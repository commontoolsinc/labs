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
  TrustedDisclaimerAckSurface,
  type TrustedDisclaimerAckSurfaceOutput,
  TrustedFactCheckGateSurface,
  type TrustedFactCheckGateSurfaceOutput,
  TrustedProvenanceReviewSurface,
  type TrustedProvenanceReviewSurfaceOutput,
} from "../cfc-trusted-surfaces/main.tsx";

type DisclaimerHostInput = {
  title: Writable<string>;
  summary: Writable<string>;
  content: Writable<string>;
  disclaimerText: Writable<string>;
  acknowledgedDisclaimer: Writable<string>;
  fakeButton: Writable<string>;
  fakeMessage: Writable<string>;
  fakeStatus: Writable<string>;
};

type ProvenanceHostInput = {
  title: Writable<string>;
  summary: Writable<string>;
  content: Writable<string>;
  provenanceText: Writable<string>;
  reviewedProvenance: Writable<string>;
  fakeButton: Writable<string>;
  fakeMessage: Writable<string>;
  fakeStatus: Writable<string>;
};

type FactCheckHostInput = {
  title: Writable<string>;
  summary: Writable<string>;
  content: Writable<string>;
  factCheckClaim: Writable<string>;
  factCheckResult: Writable<string>;
  fakeButton: Writable<string>;
  fakeMessage: Writable<string>;
  fakeStatus: Writable<string>;
};

type DisclosureExampleOutput = {
  [NAME]: string;
  [UI]: unknown;
  content: string;
  disclaimerText?: string;
  acknowledgedDisclaimer?: TrustedDisclaimerAckSurfaceOutput[
    "acknowledgedDisclaimer"
  ];
  provenanceText?: string;
  reviewedProvenance?: TrustedProvenanceReviewSurfaceOutput[
    "reviewedProvenance"
  ];
  factCheckClaim?: string;
  factCheckResult?: TrustedFactCheckGateSurfaceOutput["factCheckResult"];
  fakeStatus: string;
  acknowledgeDisclaimer?: Stream<void>;
  reviewProvenance?: Stream<void>;
  releaseFactCheckGate?: Stream<void>;
  triggerLookalike: Stream<void>;
};

const setLookalikeStatus = handler<
  void,
  { fakeStatus: Writable<string>; fakeMessage: Writable<string> }
>((_, { fakeStatus, fakeMessage }) => {
  fakeStatus.set(fakeMessage.get());
});

export const TrustedDisclaimerAckHost = pattern<
  DisclaimerHostInput,
  DisclosureExampleOutput
>(
  ({
    title,
    summary,
    content,
    disclaimerText,
    acknowledgedDisclaimer,
    fakeButton,
    fakeMessage,
    fakeStatus,
  }) => {
    const trustedSurface = TrustedDisclaimerAckSurface({
      disclaimerText,
      acknowledgedDisclaimer,
    });
    const triggerLookalike = setLookalikeStatus({
      fakeStatus,
      fakeMessage,
    });

    return {
      [NAME]: computed(() => title.get()),
      [UI]: (
        <cf-screen title={title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{title}</cf-heading>
                <cf-label>{summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{content}</div>
                  </cf-vstack>
                </cf-card>
                {trustedSurface}
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host control</cf-label>
                    <cf-button onClick={triggerLookalike}>
                      {fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      content,
      disclaimerText,
      acknowledgedDisclaimer: trustedSurface.acknowledgedDisclaimer,
      fakeStatus,
      acknowledgeDisclaimer: trustedSurface.acknowledgeDisclaimer,
      triggerLookalike,
    };
  },
);

export const TrustedProvenanceReviewHost = pattern<
  ProvenanceHostInput,
  DisclosureExampleOutput
>(
  ({
    title,
    summary,
    content,
    provenanceText,
    reviewedProvenance,
    fakeButton,
    fakeMessage,
    fakeStatus,
  }) => {
    const trustedSurface = TrustedProvenanceReviewSurface({
      provenanceText,
      reviewedProvenance,
    });
    const triggerLookalike = setLookalikeStatus({
      fakeStatus,
      fakeMessage,
    });

    return {
      [NAME]: computed(() => title.get()),
      [UI]: (
        <cf-screen title={title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{title}</cf-heading>
                <cf-label>{summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{content}</div>
                  </cf-vstack>
                </cf-card>
                {trustedSurface}
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host provenance card</cf-label>
                    <cf-button onClick={triggerLookalike}>
                      {fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      content,
      provenanceText,
      reviewedProvenance: trustedSurface.reviewedProvenance,
      fakeStatus,
      reviewProvenance: trustedSurface.reviewProvenance,
      triggerLookalike,
    };
  },
);

export const TrustedFactCheckGateHost = pattern<
  FactCheckHostInput,
  DisclosureExampleOutput
>(
  ({
    title,
    summary,
    content,
    factCheckClaim,
    factCheckResult,
    fakeButton,
    fakeMessage,
    fakeStatus,
  }) => {
    const trustedSurface = TrustedFactCheckGateSurface({
      factCheckClaim,
      factCheckResult,
    });
    const triggerLookalike = setLookalikeStatus({
      fakeStatus,
      fakeMessage,
    });

    return {
      [NAME]: computed(() => title.get()),
      [UI]: (
        <cf-screen title={title}>
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>{title}</cf-heading>
                <cf-label>{summary}</cf-label>
                <cf-card>
                  <cf-vstack slot="content" gap="1">
                    <cf-label>Associated content</cf-label>
                    <div>{content}</div>
                  </cf-vstack>
                </cf-card>
                {trustedSurface}
                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Lookalike host fact-check card</cf-label>
                    <cf-button onClick={triggerLookalike}>
                      {fakeButton}
                    </cf-button>
                    <div>{fakeStatus}</div>
                  </cf-vstack>
                </cf-card>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      content,
      factCheckClaim,
      factCheckResult: trustedSurface.factCheckResult,
      fakeStatus,
      releaseFactCheckGate: trustedSurface.releaseFactCheckGate,
      triggerLookalike,
    };
  },
);

export const DisclaimerPromptRoutingAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: Writable.of("Prompt routing ack"),
    summary: Writable.of(
      "A routing-sensitive disclaimer must be rendered before the recipient can be acknowledged.",
    ),
    content: Writable.of("Route this note to the verified recipient only."),
    disclaimerText: Writable.of(
      "Routing can be influenced by prompt-derived text.",
    ),
    acknowledgedDisclaimer: Writable.of(""),
    fakeButton: Writable.of("Fake route ack"),
    fakeMessage: Writable.of(
      "Lookalike routing ack did not update the trusted output.",
    ),
    fakeStatus: Writable.of("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Prompt routing ack"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    acknowledgeDisclaimer: host.acknowledgeDisclaimer,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerAIGeneratedContentAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: Writable.of("AI-generated content disclaimer"),
    summary: Writable.of(
      "An AI-generated disclosure is rendered alongside the content before the user can acknowledge it.",
    ),
    content: Writable.of("Draft social copy for the launch announcement."),
    disclaimerText: Writable.of(
      "This content was generated by AI and may need review.",
    ),
    acknowledgedDisclaimer: Writable.of(""),
    fakeButton: Writable.of("Fake AI ack"),
    fakeMessage: Writable.of(
      "The host lookalike did not acknowledge the trusted disclaimer.",
    ),
    fakeStatus: Writable.of("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "AI-generated content disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    acknowledgeDisclaimer: host.acknowledgeDisclaimer,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerMedicalInfoAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: Writable.of("Medical-style information disclaimer"),
    summary: Writable.of(
      "An informational disclaimer is bound to the content before the acknowledgment can produce the trusted output.",
    ),
    content: Writable.of("Medication summary and dosage reminder."),
    disclaimerText: Writable.of("Informational only. Not medical advice."),
    acknowledgedDisclaimer: Writable.of(""),
    fakeButton: Writable.of("Fake medical ack"),
    fakeMessage: Writable.of("Lookalike health disclaimer was not accepted."),
    fakeStatus: Writable.of("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Medical-style information disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    acknowledgeDisclaimer: host.acknowledgeDisclaimer,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerInfluenceDisclosureAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: Writable.of("Influence disclosure ack"),
    summary: Writable.of(
      "A persuasion/influence disclosure is rendered before the associated recommendation can be acknowledged.",
    ),
    content: Writable.of(
      "Recommendation copy generated by a campaign-tuned assistant.",
    ),
    disclaimerText: Writable.of(
      "This recommendation may be influenced by campaign goals.",
    ),
    acknowledgedDisclaimer: Writable.of(""),
    fakeButton: Writable.of("Fake influence ack"),
    fakeMessage: Writable.of(
      "The lookalike influence notice did not update trusted state.",
    ),
    fakeStatus: Writable.of("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Influence disclosure ack"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    acknowledgeDisclaimer: host.acknowledgeDisclaimer,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerRedactedSummaryAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: Writable.of("Redacted summary disclaimer"),
    summary: Writable.of(
      "The host shows a redacted derivative only after the trusted disclaimer is rendered with it.",
    ),
    content: Writable.of(
      "Redacted incident summary for the internal audience.",
    ),
    disclaimerText: Writable.of("Redacted from a more detailed report."),
    acknowledgedDisclaimer: Writable.of(""),
    fakeButton: Writable.of("Fake redaction ack"),
    fakeMessage: Writable.of(
      "Lookalike redaction note did not update the protected summary.",
    ),
    fakeStatus: Writable.of("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Redacted summary disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    acknowledgeDisclaimer: host.acknowledgeDisclaimer,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerConfidentialSourceAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: Writable.of("Confidential source disclaimer"),
    summary: Writable.of(
      "A confidentiality disclaimer is required before the host can acknowledge the source-restricted content.",
    ),
    content: Writable.of(
      "Sensitive source excerpt for internal circulation only.",
    ),
    disclaimerText: Writable.of(
      "Do not redistribute outside the approved group.",
    ),
    acknowledgedDisclaimer: Writable.of(""),
    fakeButton: Writable.of("Fake confidential ack"),
    fakeMessage: Writable.of(
      "Lookalike confidential note left the trusted output unchanged.",
    ),
    fakeStatus: Writable.of("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Confidential source disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    acknowledgeDisclaimer: host.acknowledgeDisclaimer,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerPublicPostAckExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: Writable.of("Public-post disclaimer"),
    summary: Writable.of(
      "A publication disclaimer is rendered with the post before acknowledgment is possible.",
    ),
    content: Writable.of("Draft public post for the product launch."),
    disclaimerText: Writable.of(
      "Public-facing content. Review for accuracy before publish.",
    ),
    acknowledgedDisclaimer: Writable.of(""),
    fakeButton: Writable.of("Fake public-post ack"),
    fakeMessage: Writable.of(
      "Lookalike publish note did not acknowledge the trusted post.",
    ),
    fakeStatus: Writable.of("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Public-post disclaimer"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    acknowledgeDisclaimer: host.acknowledgeDisclaimer,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerSourceProvenanceReviewExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedProvenanceReviewHost({
    title: Writable.of("Source provenance review"),
    summary: Writable.of(
      "A provenance review surface binds the source and the review note together before releasing the reviewed text.",
    ),
    content: Writable.of("Shared source excerpt for the design review."),
    provenanceText: Writable.of(
      "Source provenance: shared by the project owner.",
    ),
    reviewedProvenance: Writable.of(""),
    fakeButton: Writable.of("Fake provenance review"),
    fakeMessage: Writable.of(
      "The lookalike provenance card did not update the reviewed text.",
    ),
    fakeStatus: Writable.of("Lookalike provenance control is idle."),
  });

  return {
    [NAME]: computed(() => "Source provenance review"),
    [UI]: host[UI],
    content: host.content,
    provenanceText: host.provenanceText,
    reviewedProvenance: host.reviewedProvenance,
    fakeStatus: host.fakeStatus,
    reviewProvenance: host.reviewProvenance,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerCitationProvenanceReviewExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedProvenanceReviewHost({
    title: Writable.of("Citation provenance review"),
    summary: Writable.of(
      "The trusted provenance review is paired with citations before the host can claim the content is review-backed.",
    ),
    content: Writable.of("Claim that requires citation provenance."),
    provenanceText: Writable.of("Citations verified against the source list."),
    reviewedProvenance: Writable.of(""),
    fakeButton: Writable.of("Fake citation review"),
    fakeMessage: Writable.of(
      "The lookalike citation provenance card did not change output.",
    ),
    fakeStatus: Writable.of("Lookalike provenance control is idle."),
  });

  return {
    [NAME]: computed(() => "Citation provenance review"),
    [UI]: host[UI],
    content: host.content,
    provenanceText: host.provenanceText,
    reviewedProvenance: host.reviewedProvenance,
    fakeStatus: host.fakeStatus,
    reviewProvenance: host.reviewProvenance,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerPublicPostProvenanceReviewExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedProvenanceReviewHost({
    title: Writable.of("Public-post provenance review"),
    summary: Writable.of(
      "The public-post example exposes provenance review before release to the wider audience.",
    ),
    content: Writable.of("Public status update draft."),
    provenanceText: Writable.of(
      "Provenance review required before public release.",
    ),
    reviewedProvenance: Writable.of(""),
    fakeButton: Writable.of("Fake public review"),
    fakeMessage: Writable.of(
      "The lookalike public-post card left the trusted output alone.",
    ),
    fakeStatus: Writable.of("Lookalike provenance control is idle."),
  });

  return {
    [NAME]: computed(() => "Public-post provenance review"),
    [UI]: host[UI],
    content: host.content,
    provenanceText: host.provenanceText,
    reviewedProvenance: host.reviewedProvenance,
    fakeStatus: host.fakeStatus,
    reviewProvenance: host.reviewProvenance,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerFactCheckBriefExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedFactCheckGateHost({
    title: Writable.of("Fact-check brief gate"),
    summary: Writable.of(
      "A fact-check gate is rendered with the brief before the trusted approved output is produced.",
    ),
    content: Writable.of("External brief about launch performance."),
    factCheckClaim: Writable.of("External brief about launch performance."),
    factCheckResult: Writable.of(""),
    fakeButton: Writable.of("Fake fact-check"),
    fakeMessage: Writable.of(
      "The lookalike fact-check gate did not approve the brief.",
    ),
    fakeStatus: Writable.of("Lookalike fact-check gate is idle."),
  });

  return {
    [NAME]: computed(() => "Fact-check brief gate"),
    [UI]: host[UI],
    content: host.content,
    factCheckClaim: host.factCheckClaim,
    factCheckResult: host.factCheckResult,
    fakeStatus: host.fakeStatus,
    releaseFactCheckGate: host.releaseFactCheckGate,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerFactCheckReleaseExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedFactCheckGateHost({
    title: Writable.of("Fact-check release gate"),
    summary: Writable.of(
      "The release gate ensures the verified brief is shown with its disclaimer before approval.",
    ),
    content: Writable.of("Release note for the launch checklist."),
    factCheckClaim: Writable.of("Release note for the launch checklist."),
    factCheckResult: Writable.of(""),
    fakeButton: Writable.of("Fake release gate"),
    fakeMessage: Writable.of(
      "The lookalike release gate never updated the approved text.",
    ),
    fakeStatus: Writable.of("Lookalike fact-check gate is idle."),
  });

  return {
    [NAME]: computed(() => "Fact-check release gate"),
    [UI]: host[UI],
    content: host.content,
    factCheckClaim: host.factCheckClaim,
    factCheckResult: host.factCheckResult,
    fakeStatus: host.fakeStatus,
    releaseFactCheckGate: host.releaseFactCheckGate,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerFactCheckClaimsExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedFactCheckGateHost({
    title: Writable.of("Fact-check claims gate"),
    summary: Writable.of(
      "A claims gate sits next to the drafted claim before the trusted approval output can change.",
    ),
    content: Writable.of("Claim about the incident response timeline."),
    factCheckClaim: Writable.of("Claim about the incident response timeline."),
    factCheckResult: Writable.of(""),
    fakeButton: Writable.of("Fake claims gate"),
    fakeMessage: Writable.of(
      "The lookalike claims gate left the approved text unchanged.",
    ),
    fakeStatus: Writable.of("Lookalike fact-check gate is idle."),
  });

  return {
    [NAME]: computed(() => "Fact-check claims gate"),
    [UI]: host[UI],
    content: host.content,
    factCheckClaim: host.factCheckClaim,
    factCheckResult: host.factCheckResult,
    fakeStatus: host.fakeStatus,
    releaseFactCheckGate: host.releaseFactCheckGate,
    triggerLookalike: host.triggerLookalike,
  };
});

export const DisclaimerLookalikeHostExample = pattern<
  Record<PropertyKey, never>,
  DisclosureExampleOutput
>(() => {
  const host = TrustedDisclaimerAckHost({
    title: Writable.of("Lookalike disclaimer host"),
    summary: Writable.of(
      "This example renders a visible host control that looks similar but does not call the trusted acknowledgement stream.",
    ),
    content: Writable.of("Host-controlled disclaimer demo."),
    disclaimerText: Writable.of(
      "Trusted output only changes when the reviewed button is used.",
    ),
    acknowledgedDisclaimer: Writable.of(""),
    fakeButton: Writable.of("Fake trusted button"),
    fakeMessage: Writable.of(
      "The host lookalike never changed the trusted output.",
    ),
    fakeStatus: Writable.of("Lookalike control is idle."),
  });

  return {
    [NAME]: computed(() => "Lookalike disclaimer host"),
    [UI]: host[UI],
    content: host.content,
    disclaimerText: host.disclaimerText,
    acknowledgedDisclaimer: host.acknowledgedDisclaimer,
    fakeStatus: host.fakeStatus,
    acknowledgeDisclaimer: host.acknowledgeDisclaimer,
    triggerLookalike: host.triggerLookalike,
  };
});

const EXAMPLE_TITLES = [
  "Prompt routing ack",
  "AI-generated content disclaimer",
  "Medical-style information disclaimer",
  "Influence disclosure ack",
  "Redacted summary disclaimer",
  "Confidential source disclaimer",
  "Public-post disclaimer",
  "Source provenance review",
  "Citation provenance review",
  "Public-post provenance review",
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
              These examples are untrusted host wrappers embedding trusted
              disclaimer, provenance, influence-disclosure, and fact-check
              surfaces. Lookalike host controls remain visible but cannot update
              the protected outputs.
            </cf-label>
            <cf-label>
              The gallery currently exposes {EXAMPLE_TITLES.length}{" "}
              example patterns.
            </cf-label>
          </cf-vstack>
        </cf-card>
        <cf-card>
          <cf-vstack slot="content" gap="2">
            <cf-heading level={3}>Catalog</cf-heading>
            {EXAMPLE_TITLES.map((title, index) => (
              <div>
                {index + 1}. {title}
              </div>
            ))}
          </cf-vstack>
        </cf-card>
        <div>{DisclaimerPromptRoutingAckExample}</div>
        <div>{DisclaimerInfluenceDisclosureAckExample}</div>
        <div>{DisclaimerSourceProvenanceReviewExample}</div>
        <div>{DisclaimerFactCheckBriefExample}</div>
      </cf-vstack>
    </cf-screen>
  ),
  exampleCount: EXAMPLE_TITLES.length,
}));
