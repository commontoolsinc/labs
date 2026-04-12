import {
  Cell,
  computed,
  type Confidential,
  handler,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import {
  captureTrustedDirectCommand,
  commitTrustedForward,
  commitTrustedResearchSend,
  commitTrustedSafeLink,
  prepareTrustedForward,
  prepareTrustedResearchBrief,
  prepareTrustedSafeLink,
  TRUSTED_DIRECT_COMMAND_SURFACE,
  TRUSTED_FORWARD_SURFACE,
  TRUSTED_SAFE_LINK_SURFACE,
  TrustedActionWrite,
  TrustedDirectCommandSurface,
  TrustedForwardSurface,
  TrustedSafeLinkSurface,
} from "../cfc-trusted-surfaces/main.tsx";

type ExampleCardProps = {
  title: string;
  subtitle: string;
  value: Writable<string>;
  valueId: string;
  action: Stream<void>;
  actionLabel: string;
};

function ExampleCard(
  { title, subtitle, value, valueId, action, actionLabel }: ExampleCardProps,
) {
  return (
    <cf-card>
      <cf-vstack slot="content" gap="2">
        <cf-heading level={3}>{title}</cf-heading>
        <cf-label>{subtitle}</cf-label>
        <div id={valueId}>{value}</div>
        <cf-button onClick={action}>{actionLabel}</cf-button>
      </cf-vstack>
    </cf-card>
  );
}

type LabelDisclosureCardProps = {
  title: string;
  subtitle: string;
  value: Writable<string>;
  displayValue: string;
  valueId: string;
};

function LabelDisclosureCard(
  { title, subtitle, value, displayValue, valueId }: LabelDisclosureCardProps,
) {
  return (
    <cf-card>
      <cf-vstack slot="content" gap="2">
        <cf-heading level={3}>{title}</cf-heading>
        <cf-label>{subtitle}</cf-label>
        <div id={valueId}>{displayValue}</div>
        <cf-cfc-label
          className="gallery-disclaimer-label"
          data-cfc-label-surface={valueId}
          $value={value}
        />
      </cf-vstack>
    </cf-card>
  );
}

type DisclosureContentArgument = {
  id: string;
  content: string;
};

const makePromptInfluenceDisclosure = lift<
  DisclosureContentArgument,
  Writable<Confidential<string, readonly ["prompt-influence"]>>
>((input) =>
  Cell.for<Confidential<string, readonly ["prompt-influence"]>>(input.id).set(
    input.content as Confidential<string, readonly ["prompt-influence"]>,
  )
);

const makeSourceProvenanceDisclosure = lift<
  DisclosureContentArgument,
  Writable<Confidential<string, readonly ["source-provenance"]>>
>((input) =>
  Cell.for<Confidential<string, readonly ["source-provenance"]>>(input.id).set(
    input.content as Confidential<string, readonly ["source-provenance"]>,
  )
);

const makeFactCheckDisclosure = lift<
  DisclosureContentArgument,
  Writable<Confidential<string, readonly ["fact-check-required"]>>
>((input) =>
  Cell.for<Confidential<string, readonly ["fact-check-required"]>>(input.id)
    .set(
      input.content as Confidential<string, readonly ["fact-check-required"]>,
    )
);

interface GalleryOutput {
  [NAME]: string;
  [UI]: unknown;
  totalExamples: number;
  completedCount: number;
  lastCompleted: string;
  hotelMembershipReturn: WriteAuthorizedBy<
    string,
    typeof returnHotelMembership
  >;
  forwardHotelNote: TrustedActionWrite<
    string,
    typeof commitTrustedForward,
    "TrustedForwardNote",
    typeof TRUSTED_FORWARD_SURFACE
  >;
  forwardSourceNote: string;
  forwardRecipientInput: string;
  forwardPreparedPreview: TrustedActionWrite<
    string,
    typeof prepareTrustedForward,
    "TrustedPrepareForward",
    typeof TRUSTED_FORWARD_SURFACE
  >;
  forwardStage: string;
  forwardRecipientInputCell: Writable<string>;
  forwardPreparedPreviewCell: Writable<string>;
  forwardHotelNoteCell: Writable<string>;
  selectSearchResult: WriteAuthorizedBy<string, typeof selectSearchResult>;
  acknowledgeDisclosure: WriteAuthorizedBy<
    string,
    typeof acknowledgeDisclosure
  >;
  acknowledgeAlert: WriteAuthorizedBy<string, typeof acknowledgeAlert>;
  acceptInvite: WriteAuthorizedBy<string, typeof acceptInvite>;
  releaseRedactedSummary: WriteAuthorizedBy<
    string,
    typeof releaseRedactedSummary
  >;
  escalateSupportCase: WriteAuthorizedBy<string, typeof escalateSupportCase>;
  previewResearchBrief: TrustedActionWrite<
    string,
    typeof prepareTrustedResearchBrief,
    "TrustedPrepareResearchBrief",
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  researchCommandInput: string;
  capturedCommand: TrustedActionWrite<
    string,
    typeof captureTrustedDirectCommand,
    "TrustedCaptureDirectCommand",
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  researchPreparedBrief: TrustedActionWrite<
    string,
    typeof prepareTrustedResearchBrief,
    "TrustedPrepareResearchBrief",
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  researchStage: string;
  researchCommandInputCell: Writable<string>;
  capturedCommandCell: Writable<string>;
  researchPreparedBriefCell: Writable<string>;
  authorizeResearchSendCell: Writable<string>;
  finalizeChecklist: WriteAuthorizedBy<string, typeof finalizeChecklist>;
  confirmReceipt: WriteAuthorizedBy<string, typeof confirmReceipt>;
  authorizeResearchSend: TrustedActionWrite<
    string,
    typeof commitTrustedResearchSend,
    "TrustedAuthorizeResearchSend",
    typeof TRUSTED_DIRECT_COMMAND_SURFACE
  >;
  releaseSafeLink: TrustedActionWrite<
    string,
    typeof commitTrustedSafeLink,
    "TrustedReleaseSafeLink",
    typeof TRUSTED_SAFE_LINK_SURFACE
  >;
  safeLinkSource: string;
  safeLinkPrepared: TrustedActionWrite<
    string,
    typeof prepareTrustedSafeLink,
    "TrustedPrepareSafeLink",
    typeof TRUSTED_SAFE_LINK_SURFACE
  >;
  safeLinkStage: string;
  safeLinkSourceCell: Writable<string>;
  safeLinkPreparedCell: Writable<string>;
  releaseSafeLinkCell: Writable<string>;
  hotelMembershipReturnCell: Writable<string>;
  selectSearchResultCell: Writable<string>;
  runHotelMembershipReturn: Stream<void>;
  setForwardRecipient: Stream<string>;
  prepareForwardHotelNote: Stream<void>;
  runForwardHotelNote: Stream<void>;
  runSelectSearchResult: Stream<void>;
  runAcknowledgeDisclosure: Stream<void>;
  runAcknowledgeAlert: Stream<void>;
  runAcceptInvite: Stream<void>;
  runReleaseRedactedSummary: Stream<void>;
  runEscalateSupportCase: Stream<void>;
  setResearchCommand: Stream<string>;
  runCaptureDirectCommand: Stream<void>;
  runPreviewResearchBrief: Stream<void>;
  runFinalizeChecklist: Stream<void>;
  runConfirmReceipt: Stream<void>;
  runAuthorizeResearchSend: Stream<void>;
  setSafeLinkSource: Stream<string>;
  prepareSafeLinkRelease: Stream<void>;
  runReleaseSafeLink: Stream<void>;
}

const returnHotelMembership = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("Returned loyalty number to hotel@example.com");
});

const setWritableString = handler<string, { value: Writable<string> }>((
  next,
  { value },
) => {
  value.set(next);
});

const selectSearchResult = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("Selected one vetted search result for follow-up");
});

const acknowledgeDisclosure = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("User acknowledged the disclosure before release");
});

const acknowledgeAlert = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("Critical alert acknowledged with explicit UI intent");
});

const acceptInvite = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("Accepted the shared-space invite with trusted provenance");
});

const releaseRedactedSummary = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("Released the redacted summary instead of the raw note");
});

const escalateSupportCase = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("Escalated the support case with the approved excerpt");
});

const finalizeChecklist = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("Finalized the release checklist after the trusted review");
});

const confirmReceipt = handler<
  void,
  { value: Writable<string> }
>((_, { value }) => {
  value.set("Confirmed receipt for the returned sender flow");
});

export default pattern<Record<PropertyKey, never>, GalleryOutput>(() => {
  const hotelMembershipReturn = Writable.of("");
  const forwardSourceNote = Writable.of(
    "Guest arrives late and needs the bell desk to hold room access after midnight. Raw inbox context stays in the note.",
  );
  const forwardRecipientInput = Writable.of("ops@hotel.example");
  const forwardPreparedPreview = Writable.of("");
  const forwardHotelNoteValue = Writable.of("");
  const selectSearchResultValue = Writable.of("");
  const acknowledgeDisclosureValue = Writable.of("");
  const acknowledgeAlertValue = Writable.of("");
  const acceptInviteValue = Writable.of("");
  const releaseRedactedSummaryValue = Writable.of("");
  const escalateSupportCaseValue = Writable.of("");
  const promptInfluenceDisclosureText =
    "Recommendation copy generated by a campaign-tuned assistant.";
  const sourceProvenanceDisclosureText =
    "Source excerpt shared by the project owner for the design review.";
  const factCheckDisclosureText = "External brief about launch performance.";
  const promptInfluenceDisclosure = makePromptInfluenceDisclosure({
    id: "cfc-gallery-prompt-influence-disclosure",
    content: promptInfluenceDisclosureText,
  });
  const sourceProvenanceDisclosure = makeSourceProvenanceDisclosure({
    id: "cfc-gallery-source-provenance-disclosure",
    content: sourceProvenanceDisclosureText,
  });
  const factCheckDisclosure = makeFactCheckDisclosure({
    id: "cfc-gallery-fact-check-disclosure",
    content: factCheckDisclosureText,
  });
  // lift() strips cell wrappers in its public type, but these module outputs
  // are runtime cells and must stay bound as cells for cf-cfc-label.
  const promptInfluenceDisclosureRender: Writable<string> =
    promptInfluenceDisclosure as never;
  const sourceProvenanceDisclosureRender: Writable<string> =
    sourceProvenanceDisclosure as never;
  const factCheckDisclosureRender: Writable<string> =
    factCheckDisclosure as never;
  const researchCommandInput = Writable.of(
    "Research Common Fabric launch updates and email a three-bullet brief to team@example.com",
  );
  const capturedCommand = Writable.of("");
  const previewResearchBriefValue = Writable.of("");
  const authorizeResearchSendValue = Writable.of("");
  const finalizeChecklistValue = Writable.of("");
  const confirmReceiptValue = Writable.of("");
  const safeLinkSource = Writable.of(
    "https://source.example.com/private/report?token=secret-token&draft=internal",
  );
  const safeLinkPrepared = Writable.of("");
  const releaseSafeLinkValue = Writable.of("");

  const runHotelMembershipReturn = returnHotelMembership({
    value: hotelMembershipReturn,
  });
  const setForwardRecipient = setWritableString({
    value: forwardRecipientInput,
  });
  const forwardSurface = TrustedForwardSurface({
    sourceNote: forwardSourceNote,
    recipientInput: forwardRecipientInput,
    preparedPreview: forwardPreparedPreview,
    forwardedNote: forwardHotelNoteValue,
  });
  const runSelectSearchResult = selectSearchResult({
    value: selectSearchResultValue,
  });
  const runAcknowledgeDisclosure = acknowledgeDisclosure({
    value: acknowledgeDisclosureValue,
  });
  const runAcknowledgeAlert = acknowledgeAlert({
    value: acknowledgeAlertValue,
  });
  const runAcceptInvite = acceptInvite({
    value: acceptInviteValue,
  });
  const runReleaseRedactedSummary = releaseRedactedSummary({
    value: releaseRedactedSummaryValue,
  });
  const runEscalateSupportCase = escalateSupportCase({
    value: escalateSupportCaseValue,
  });
  const setResearchCommand = setWritableString({ value: researchCommandInput });
  const directCommandSurface = TrustedDirectCommandSurface({
    commandInput: researchCommandInput,
    capturedCommand,
    preparedBrief: previewResearchBriefValue,
    authorizedSend: authorizeResearchSendValue,
  });
  const runFinalizeChecklist = finalizeChecklist({
    value: finalizeChecklistValue,
  });
  const runConfirmReceipt = confirmReceipt({
    value: confirmReceiptValue,
  });
  const setSafeLinkSource = setWritableString({ value: safeLinkSource });
  const safeLinkSurface = TrustedSafeLinkSurface({
    sourceUrl: safeLinkSource,
    preparedSafeLink: safeLinkPrepared,
    releasedSafeLink: releaseSafeLinkValue,
  });

  const forwardStage = computed(() =>
    forwardHotelNoteValue.get()
      ? "forwarded"
      : forwardPreparedPreview.get()
      ? "prepared"
      : "drafting"
  );
  const researchStage = computed(() =>
    authorizeResearchSendValue.get()
      ? "sent"
      : previewResearchBriefValue.get()
      ? "prepared"
      : capturedCommand.get()
      ? "captured"
      : "drafting"
  );
  const safeLinkStage = computed(() =>
    releaseSafeLinkValue.get()
      ? "released"
      : safeLinkPrepared.get()
      ? "prepared"
      : "screening"
  );
  const completedEntries = computed(() => {
    const entries = [] as string[];
    if (hotelMembershipReturn.get()) entries.push("hotel-membership-return");
    if (forwardHotelNoteValue.get()) entries.push("forward-hotel-note");
    if (selectSearchResultValue.get()) entries.push("select-search-result");
    if (acknowledgeDisclosureValue.get()) {
      entries.push("acknowledge-disclosure");
    }
    if (acknowledgeAlertValue.get()) entries.push("acknowledge-alert");
    if (acceptInviteValue.get()) entries.push("accept-invite");
    if (releaseRedactedSummaryValue.get()) {
      entries.push("release-redacted-summary");
    }
    if (escalateSupportCaseValue.get()) entries.push("escalate-support-case");
    if (authorizeResearchSendValue.get()) {
      entries.push("authorize-research-send");
    }
    if (finalizeChecklistValue.get()) entries.push("finalize-checklist");
    if (confirmReceiptValue.get()) entries.push("confirm-receipt");
    if (releaseSafeLinkValue.get()) entries.push("release-safe-link");
    return entries;
  });

  return {
    [NAME]: computed(() => "CFC Worked Example Gallery"),
    [UI]: (
      <cf-screen title="CFC Worked Example Gallery">
        <cf-vscroll style="flex: 1;">
          <cf-vstack gap="4" style="padding: 1rem 1.25rem 2rem;">
            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-heading level={2}>
                  Worked examples with real UI paths
                </cf-heading>
                <cf-label id="gallery-count">
                  16 total examples across this branch: 2 standalone demos plus
                  this gallery. The first three cards below are now full demo
                  flows with separate prepare and authorize steps.
                </cf-label>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-hstack justify="between" align="center" wrap>
                  <cf-vstack gap="1">
                    <cf-heading level={3}>Forward Trusted Note</cf-heading>
                    <cf-label>
                      Review a bounded note excerpt, prepare the forward, then
                      release it through the trusted action.
                    </cf-label>
                  </cf-vstack>
                  <cf-badge id="forward-stage">{forwardStage}</cf-badge>
                </cf-hstack>
                {forwardSurface}
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-hstack justify="between" align="center" wrap>
                  <cf-vstack gap="1">
                    <cf-heading level={3}>Research To Email</cf-heading>
                    <cf-label>
                      Capture the direct command, prepare a bounded draft, and
                      authorize the outbound send separately.
                    </cf-label>
                  </cf-vstack>
                  <cf-badge id="research-stage">{researchStage}</cf-badge>
                </cf-hstack>
                {directCommandSurface}
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-hstack justify="between" align="center" wrap>
                  <cf-vstack gap="1">
                    <cf-heading level={3}>Release Safe Link</cf-heading>
                    <cf-label>
                      Screen a risky source URL, prepare a safe derivative, and
                      release only the approved link.
                    </cf-label>
                  </cf-vstack>
                  <cf-badge id="safe-link-stage">{safeLinkStage}</cf-badge>
                </cf-hstack>
                {safeLinkSurface}
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>
                  Other examples still represented
                </cf-heading>
                <cf-label>
                  The remaining scenarios are still available as lighter demo
                  cards while the richer flows above carry the deeper UX.
                </cf-label>
                <cf-vstack gap="2">
                  {ExampleCard({
                    title: "Hotel Membership Return",
                    subtitle: "Section 13.5.1 return-to-sender release.",
                    value: hotelMembershipReturn,
                    valueId: "hotel-membership-return",
                    action: runHotelMembershipReturn,
                    actionLabel: "Return Membership Number",
                  })}
                  {ExampleCard({
                    title: "Search Result Selection",
                    subtitle:
                      "Selection-decision integrity from a vetted result list.",
                    value: selectSearchResultValue,
                    valueId: "select-search-result",
                    action: runSelectSearchResult,
                    actionLabel: "Select Result",
                  })}
                  {LabelDisclosureCard({
                    title: "Prompt Influence Disclosure",
                    subtitle:
                      "The influenced content is rendered with its label and disclosure text instead of a click acknowledgement.",
                    value: promptInfluenceDisclosureRender,
                    displayValue: promptInfluenceDisclosureText,
                    valueId: "prompt-influence-disclosure",
                  })}
                  {LabelDisclosureCard({
                    title: "Source Provenance Disclosure",
                    subtitle:
                      "The source-provenance label is visible with the excerpt before any reuse path.",
                    value: sourceProvenanceDisclosureRender,
                    displayValue: sourceProvenanceDisclosureText,
                    valueId: "source-provenance-disclosure",
                  })}
                  {ExampleCard({
                    title: "Invite Acceptance",
                    subtitle:
                      "User-approved acceptance of a shared-space invitation.",
                    value: acceptInviteValue,
                    valueId: "accept-invite",
                    action: runAcceptInvite,
                    actionLabel: "Accept Invite",
                  })}
                  {LabelDisclosureCard({
                    title: "Fact-check Disclosure",
                    subtitle:
                      "The claim carries a fact-check-required label rendered directly in the trusted UI.",
                    value: factCheckDisclosureRender,
                    displayValue: factCheckDisclosureText,
                    valueId: "fact-check-disclosure",
                  })}
                  {ExampleCard({
                    title: "Support Escalation",
                    subtitle:
                      "Escalate only the approved excerpt to a support sink.",
                    value: escalateSupportCaseValue,
                    valueId: "escalate-support-case",
                    action: runEscalateSupportCase,
                    actionLabel: "Escalate Support Case",
                  })}
                  {ExampleCard({
                    title: "Checklist Finalization",
                    subtitle:
                      "Finalize a checklist after the trusted review step.",
                    value: finalizeChecklistValue,
                    valueId: "finalize-checklist",
                    action: runFinalizeChecklist,
                    actionLabel: "Finalize Checklist",
                  })}
                  {ExampleCard({
                    title: "Receipt Confirmation",
                    subtitle:
                      "Confirm a returned artifact with explicit intent.",
                    value: confirmReceiptValue,
                    valueId: "confirm-receipt",
                    action: runConfirmReceipt,
                    actionLabel: "Confirm Receipt",
                  })}
                </cf-vstack>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-vscroll>
      </cf-screen>
    ),
    totalExamples: 16,
    completedCount: computed(() => completedEntries.length),
    lastCompleted: computed(() => {
      const entries = completedEntries;
      return entries[entries.length - 1] ?? "";
    }),
    hotelMembershipReturn,
    forwardHotelNote: forwardHotelNoteValue,
    forwardSourceNote: computed(() => forwardSourceNote.get()),
    forwardRecipientInput: computed(() => forwardRecipientInput.get()),
    forwardPreparedPreview: forwardPreparedPreview,
    forwardStage,
    forwardRecipientInputCell: forwardRecipientInput,
    forwardPreparedPreviewCell: forwardPreparedPreview,
    forwardHotelNoteCell: forwardHotelNoteValue,
    selectSearchResult: selectSearchResultValue,
    acknowledgeDisclosure: acknowledgeDisclosureValue,
    acknowledgeAlert: acknowledgeAlertValue,
    acceptInvite: acceptInviteValue,
    releaseRedactedSummary: releaseRedactedSummaryValue,
    escalateSupportCase: escalateSupportCaseValue,
    previewResearchBrief: previewResearchBriefValue,
    researchCommandInput: computed(() => researchCommandInput.get()),
    capturedCommand,
    researchPreparedBrief: previewResearchBriefValue,
    researchStage,
    researchCommandInputCell: researchCommandInput,
    capturedCommandCell: capturedCommand,
    researchPreparedBriefCell: previewResearchBriefValue,
    authorizeResearchSendCell: authorizeResearchSendValue,
    finalizeChecklist: finalizeChecklistValue,
    confirmReceipt: confirmReceiptValue,
    authorizeResearchSend: authorizeResearchSendValue,
    releaseSafeLink: releaseSafeLinkValue,
    safeLinkSource: computed(() => safeLinkSource.get()),
    safeLinkPrepared: safeLinkPrepared,
    safeLinkStage,
    safeLinkSourceCell: safeLinkSource,
    safeLinkPreparedCell: safeLinkPrepared,
    releaseSafeLinkCell: releaseSafeLinkValue,
    hotelMembershipReturnCell: hotelMembershipReturn,
    selectSearchResultCell: selectSearchResultValue,
    runHotelMembershipReturn,
    setForwardRecipient,
    prepareForwardHotelNote: forwardSurface.prepareForward,
    runForwardHotelNote: forwardSurface.forwardNote,
    runSelectSearchResult,
    runAcknowledgeDisclosure,
    runAcknowledgeAlert,
    runAcceptInvite,
    runReleaseRedactedSummary,
    runEscalateSupportCase,
    setResearchCommand,
    runCaptureDirectCommand: directCommandSurface.captureCommand,
    runPreviewResearchBrief: directCommandSurface.prepareBrief,
    runFinalizeChecklist,
    runConfirmReceipt,
    runAuthorizeResearchSend: directCommandSurface.authorizeSend,
    setSafeLinkSource,
    prepareSafeLinkRelease: safeLinkSurface.prepareSafeLink,
    runReleaseSafeLink: safeLinkSurface.releaseSafeLink,
  };
});
