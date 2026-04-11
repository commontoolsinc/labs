import {
  Cell,
  type Classified,
  computed,
  handler,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";

type TrustedHealthDisclosureInput = {
  content: Writable<Classified<string, readonly ["confidential"]>>;
  revealSensitive: Writable<boolean>;
};

type DirectHealthRenderInput = {
  content: Writable<Classified<string, readonly ["confidential"]>>;
};

type LabelledContentArgument = {
  id: string;
  content: string;
};

type TrustedHealthDisclosureOutput = {
  [NAME]: string;
  [UI]: unknown;
  revealed: boolean;
  reveal: Stream<void>;
  conceal: Stream<void>;
};

type RenderPolicyDemoOutput = {
  [NAME]: string;
  [UI]: unknown;
  revealSensitive: boolean;
};

const setRevealSensitive = handler<
  void,
  { revealSensitive: Writable<boolean>; next: boolean }
>((_, { revealSensitive, next }) => {
  revealSensitive.set(next);
});

const makeConfidentialHealthText = lift<
  LabelledContentArgument,
  Writable<Classified<string, readonly ["confidential"]>>
>((input) =>
  Cell.for<Classified<string, readonly ["confidential"]>>(input.id).set(
    input.content as Classified<string, readonly ["confidential"]>,
  )
);

export const UntrustedDirectHealthRender = pattern<
  DirectHealthRenderInput,
  { [NAME]: string; [UI]: unknown }
>(({ content }) => ({
  [NAME]: "Untrusted direct health render",
  [UI]: (
    <cf-card id="raw-health-attempt">
      <cf-vstack slot="content" gap="2">
        <cf-heading level={3}>Untrusted direct render attempt</cf-heading>
        <cf-label>
          This section intentionally has no trusted declassification surface, so
          the content below should stay hidden.
        </cf-label>
        <cf-cfc-render-boundary
          maxConfidentiality="unclassified"
          $value={content}
        >
          <div id="raw-health-direct">{content}</div>
        </cf-cfc-render-boundary>
      </cf-vstack>
    </cf-card>
  ),
}));

export const TrustedHealthDisclosureSurface = pattern<
  TrustedHealthDisclosureInput,
  TrustedHealthDisclosureOutput
>(({ content, revealSensitive }) => {
  const reveal = setRevealSensitive({ revealSensitive, next: true });
  const conceal = setRevealSensitive({ revealSensitive, next: false });
  const buttonLabel = computed(() =>
    revealSensitive.get()
      ? "Hide sensitive health data"
      : "Show sensitive health data"
  );

  return {
    [NAME]: "Trusted health disclosure surface",
    [UI]: (
      <cf-card
        id="trusted-health-surface"
        data-ui-surface="TrustedHealthDisclosureSurface"
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted shoulder-surfing control</cf-heading>
          <cf-label>
            This trusted surface explains that confidential health data is about
            to be rendered. The render boundary only declassifies the matching
            label after this control is switched on.
          </cf-label>
          <cf-hstack gap="2">
            <cf-button
              data-ui-action="TrustedRevealHealthData"
              onClick={reveal}
            >
              {buttonLabel}
            </cf-button>
            <cf-button
              data-ui-action="TrustedConcealHealthData"
              onClick={conceal}
            >
              Reset to private
            </cf-button>
          </cf-hstack>
          <cf-label id="reveal-state">
            {revealSensitive ? "Reveal enabled" : "Reveal disabled"}
          </cf-label>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Trusted render region</cf-label>
              {revealSensitive
                ? (
                  <cf-cfc-render-boundary
                    maxConfidentiality="unclassified"
                    declassifyClassification="confidential"
                    $value={content}
                  >
                    <div id="trusted-health-visible">
                      {content}
                    </div>
                  </cf-cfc-render-boundary>
                )
                : (
                  <cf-cfc-render-boundary
                    maxConfidentiality="unclassified"
                    $value={content}
                  >
                    <div id="trusted-health-blocked">
                      {content}
                    </div>
                  </cf-cfc-render-boundary>
                )}
            </cf-vstack>
          </cf-card>
          <cf-card>
            <cf-vstack slot="content" gap="1">
              <cf-label>Label attached to the protected value</cf-label>
              <cf-cfc-label
                data-cfc-label-surface="trusted-health-disclosure"
                $value={content}
              />
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    revealed: revealSensitive,
    reveal,
    conceal,
  };
});

export default pattern<unknown, RenderPolicyDemoOutput>(() => {
  const healthContent = makeConfidentialHealthText({
    id: "cfc-render-policy-demo-health-content",
    content:
      "Sensitive health data: migraine treatment plan includes medication review.",
  });
  const healthContentRender: Writable<
    Classified<string, readonly ["confidential"]>
  > = healthContent as never;
  const revealSensitive = Writable.of(false);
  const trustedDisclosure = TrustedHealthDisclosureSurface({
    content: healthContentRender,
    revealSensitive,
  });
  const rawAttempt = UntrustedDirectHealthRender({
    content: healthContentRender,
  });

  return {
    [NAME]: "CFC render policy demo",
    [UI]: (
      <cf-screen title="CFC render policy demo">
        <cf-vstack gap="4" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="3">
              <cf-heading level={2}>Render-time confidentiality</cf-heading>
              <cf-label>
                The page below tries to render the same confidential health cell
                twice. The raw host attempt stays blocked by the default-low
                render boundary; the trusted surface can reveal it only inside
                its own disclosure region.
              </cf-label>
            </cf-vstack>
          </cf-card>

          {rawAttempt}
          {trustedDisclosure}
        </cf-vstack>
      </cf-screen>
    ),
    revealSensitive,
  };
});
