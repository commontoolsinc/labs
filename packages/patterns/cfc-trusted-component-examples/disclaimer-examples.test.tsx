import { computed, handler, pattern, Writable } from "commonfabric";
import {
  DISCLAIMER_EXAMPLE_COUNT,
  DISCLAIMER_RENDERED_EXAMPLE_COUNT,
  TrustedDisclaimerAckHost,
  TrustedFactCheckGateHost,
  TrustedProvenanceReviewHost,
} from "./disclaimer-examples.tsx";

type AckSuite = ReturnType<typeof TrustedDisclaimerAckHost>;
type ProvenanceSuite = ReturnType<typeof TrustedProvenanceReviewHost>;
type FactCheckSuite = ReturnType<typeof TrustedFactCheckGateHost>;

const runAck = handler<void, { suite: AckSuite }>((_, { suite }) => {
  suite.triggerLookalike.send();
});

const runProvenance = handler<void, { suite: ProvenanceSuite }>((
  _,
  { suite },
) => {
  suite.triggerLookalike.send();
});

const runFactCheck = handler<void, { suite: FactCheckSuite }>((
  _,
  { suite },
) => {
  suite.triggerLookalike.send();
});

const runLookalikeOnly = handler<void, { suite: AckSuite }>((
  _,
  { suite },
) => {
  suite.triggerLookalike.send();
});

export default pattern(() => {
  const influenceAcknowledged = Writable.of("");
  const influenceFakeStatus = Writable.of("Lookalike control is idle.");
  const influence = TrustedDisclaimerAckHost({
    title: Writable.of("Influence disclosure ack"),
    summary: Writable.of("Influence disclosure demo"),
    content: Writable.of("Recommendation copy"),
    disclaimerText: Writable.of(
      "This recommendation may be influenced by campaign goals.",
    ),
    acknowledgedDisclaimer: influenceAcknowledged,
    fakeButton: Writable.of("Fake influence ack"),
    fakeMessage: Writable.of(
      "The lookalike influence notice did not update trusted state.",
    ),
    fakeStatus: influenceFakeStatus,
  });

  const reviewedProvenance = Writable.of("");
  const provenanceFakeStatus = Writable.of(
    "Lookalike provenance control is idle.",
  );
  const provenance = TrustedProvenanceReviewHost({
    title: Writable.of("Source provenance review"),
    summary: Writable.of("Provenance disclosure demo"),
    content: Writable.of("Shared source excerpt"),
    provenanceText: Writable.of(
      "Source provenance: shared by the project owner.",
    ),
    reviewedProvenance,
    fakeButton: Writable.of("Fake provenance review"),
    fakeMessage: Writable.of(
      "The lookalike provenance card did not update the reviewed text.",
    ),
    fakeStatus: provenanceFakeStatus,
  });

  const factCheckResult = Writable.of("");
  const factCheckFakeStatus = Writable.of("Lookalike fact-check gate is idle.");
  const factCheck = TrustedFactCheckGateHost({
    title: Writable.of("Fact-check brief gate"),
    summary: Writable.of("Fact-check gate demo"),
    content: Writable.of("External brief about launch performance."),
    factCheckClaim: Writable.of("External brief about launch performance."),
    factCheckResult,
    fakeButton: Writable.of("Fake fact-check"),
    fakeMessage: Writable.of(
      "The lookalike fact-check gate did not approve the brief.",
    ),
    fakeStatus: factCheckFakeStatus,
  });

  const lookalikeAcknowledged = Writable.of("");
  const lookalikeFakeStatus = Writable.of("Lookalike control is idle.");
  const lookalike = TrustedDisclaimerAckHost({
    title: Writable.of("Lookalike disclaimer host"),
    summary: Writable.of("Lookalike-only negative path"),
    content: Writable.of("Host-controlled disclaimer demo."),
    disclaimerText: Writable.of(
      "Trusted output only changes when the reviewed button is used.",
    ),
    acknowledgedDisclaimer: lookalikeAcknowledged,
    fakeButton: Writable.of("Fake trusted button"),
    fakeMessage: Writable.of(
      "The host lookalike never changed the trusted output.",
    ),
    fakeStatus: lookalikeFakeStatus,
  });

  const assert_influence_disclosure_is_render_only = computed(() =>
    influenceFakeStatus.get() ===
      "The lookalike influence notice did not update trusted state." &&
    influenceAcknowledged.get() === ""
  );

  const assert_provenance_disclosure_is_render_only = computed(() =>
    provenanceFakeStatus.get() ===
      "The lookalike provenance card did not update the reviewed text." &&
    reviewedProvenance.get() === ""
  );

  const assert_fact_check_disclosure_is_render_only = computed(() =>
    factCheckFakeStatus.get() ===
      "The lookalike fact-check gate did not approve the brief." &&
    factCheckResult.get() === ""
  );

  const assert_lookalike_stays_untrusted = computed(() =>
    lookalikeFakeStatus.get() ===
      "The host lookalike never changed the trusted output." &&
    lookalikeAcknowledged.get() === ""
  );
  const assert_gallery_renders_catalog = computed(() =>
    DISCLAIMER_EXAMPLE_COUNT === 14 &&
    DISCLAIMER_RENDERED_EXAMPLE_COUNT === DISCLAIMER_EXAMPLE_COUNT
  );

  return {
    tests: [
      { action: runAck({ suite: influence }) },
      { assertion: assert_influence_disclosure_is_render_only },
      { action: runProvenance({ suite: provenance }) },
      { assertion: assert_provenance_disclosure_is_render_only },
      { action: runFactCheck({ suite: factCheck }) },
      { assertion: assert_fact_check_disclosure_is_render_only },
      { action: runLookalikeOnly({ suite: lookalike }) },
      { assertion: assert_lookalike_stays_untrusted },
      { assertion: assert_gallery_renders_catalog },
    ],
    influence,
    provenance,
    factCheck,
    lookalike,
  };
});
