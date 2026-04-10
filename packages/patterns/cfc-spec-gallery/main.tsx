import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

type ExampleCardProps = {
  title: string;
  subtitle: string;
  value: unknown;
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
  forwardHotelNote: WriteAuthorizedBy<string, typeof commitForwardHotelNote>;
  forwardSourceNote: string;
  forwardRecipientInput: string;
  forwardPreparedPreview: string;
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
  previewResearchBrief: string;
  researchCommandInput: string;
  capturedCommand: WriteAuthorizedBy<string, typeof captureDirectCommandIntent>;
  researchPreparedBrief: string;
  researchStage: string;
  researchCommandInputCell: Writable<string>;
  capturedCommandCell: Writable<string>;
  researchPreparedBriefCell: Writable<string>;
  authorizeResearchSendCell: Writable<string>;
  finalizeChecklist: WriteAuthorizedBy<string, typeof finalizeChecklist>;
  confirmReceipt: WriteAuthorizedBy<string, typeof confirmReceipt>;
  authorizeResearchSend: WriteAuthorizedBy<
    string,
    typeof commitResearchSend
  >;
  releaseSafeLink: WriteAuthorizedBy<string, typeof commitSafeLinkRelease>;
  safeLinkSource: string;
  safeLinkPrepared: string;
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
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Returned loyalty number to hotel@example.com");
  log.push("hotel-membership-return");
});

const setWritableString = handler<string, { value: Writable<string> }>((
  next,
  { value },
) => {
  value.set(next);
});

const prepareForwardHotelNote = handler<
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

const commitForwardHotelNote = handler<
  void,
  {
    preparedPreview: Writable<string>;
    releasedValue: Writable<string>;
    log: Writable<string[]>;
  }
>((_, { preparedPreview, releasedValue, log }) => {
  releasedValue.set(
    preparedPreview.get().trim() ||
      "Forwarded itinerary note through the trusted forwarder",
  );
  log.push("forward-hotel-note");
});

const selectSearchResult = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Selected one vetted search result for follow-up");
  log.push("select-search-result");
});

const acknowledgeDisclosure = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("User acknowledged the disclosure before release");
  log.push("acknowledge-disclosure");
});

const acknowledgeAlert = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Critical alert acknowledged with explicit UI intent");
  log.push("acknowledge-alert");
});

const acceptInvite = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Accepted the shared-space invite with trusted provenance");
  log.push("accept-invite");
});

const releaseRedactedSummary = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Released the redacted summary instead of the raw note");
  log.push("release-redacted-summary");
});

const escalateSupportCase = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Escalated the support case with the approved excerpt");
  log.push("escalate-support-case");
});

const captureDirectCommandIntent = handler<
  void,
  {
    commandInput: Writable<string>;
    capturedCommand: Writable<string>;
    previewBrief: Writable<string>;
  }
>((_, { commandInput, capturedCommand, previewBrief }) => {
  const normalized = commandInput.get().trim();
  capturedCommand.set(normalized);
  previewBrief.set("");
});

const prepareResearchBrief = handler<
  void,
  {
    capturedCommand: Writable<string>;
    previewBrief: Writable<string>;
  }
>((_, { capturedCommand, previewBrief }) => {
  const prompt = capturedCommand.get().trim();
  previewBrief.set(
    prompt
      ? `Prepared outbound draft: concise summary for "${prompt}". The send action stays separately gated.`
      : "",
  );
});

const commitResearchSend = handler<
  void,
  {
    capturedCommand: Writable<string>;
    previewBrief: Writable<string>;
    releasedValue: Writable<string>;
    log: Writable<string[]>;
  }
>((_, { capturedCommand, previewBrief, releasedValue, log }) => {
  const command = capturedCommand.get().trim();
  const preview = previewBrief.get().trim();
  releasedValue.set(
    preview ? `Authorized outbound message for "${command}": ${preview}` : "",
  );
  log.push("authorize-research-send");
});

const finalizeChecklist = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Finalized the release checklist after the trusted review");
  log.push("finalize-checklist");
});

const confirmReceipt = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Confirmed receipt for the returned sender flow");
  log.push("confirm-receipt");
});

const prepareSafeLink = handler<
  void,
  {
    sourceUrl: Writable<string>;
    preparedSafeLink: Writable<string>;
  }
>((_, { sourceUrl, preparedSafeLink }) => {
  const [base] = sourceUrl.get().split("?");
  preparedSafeLink.set(
    base ? `${base}?view=summary` : "",
  );
});

const commitSafeLinkRelease = handler<
  void,
  {
    preparedSafeLink: Writable<string>;
    releasedValue: Writable<string>;
    log: Writable<string[]>;
  }
>((_, { preparedSafeLink, releasedValue, log }) => {
  releasedValue.set(
    preparedSafeLink.get().trim()
      ? `Released safe link ${preparedSafeLink.get().trim()}`
      : "",
  );
  log.push("release-safe-link");
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
  const eventLog = Writable.of<string[]>([]);

  const runHotelMembershipReturn = returnHotelMembership({
    value: hotelMembershipReturn,
    log: eventLog,
  });
  const setForwardRecipient = setWritableString({
    value: forwardRecipientInput,
  });
  const prepareForwardHotelNoteStream = prepareForwardHotelNote({
    sourceNote: forwardSourceNote,
    recipientInput: forwardRecipientInput,
    preparedPreview: forwardPreparedPreview,
  });
  const runForwardHotelNote = commitForwardHotelNote({
    preparedPreview: forwardPreparedPreview,
    releasedValue: forwardHotelNoteValue,
    log: eventLog,
  });
  const runSelectSearchResult = selectSearchResult({
    value: selectSearchResultValue,
    log: eventLog,
  });
  const runAcknowledgeDisclosure = acknowledgeDisclosure({
    value: acknowledgeDisclosureValue,
    log: eventLog,
  });
  const runAcknowledgeAlert = acknowledgeAlert({
    value: acknowledgeAlertValue,
    log: eventLog,
  });
  const runAcceptInvite = acceptInvite({
    value: acceptInviteValue,
    log: eventLog,
  });
  const runReleaseRedactedSummary = releaseRedactedSummary({
    value: releaseRedactedSummaryValue,
    log: eventLog,
  });
  const runEscalateSupportCase = escalateSupportCase({
    value: escalateSupportCaseValue,
    log: eventLog,
  });
  const setResearchCommand = setWritableString({ value: researchCommandInput });
  const runCaptureDirectCommand = captureDirectCommandIntent({
    commandInput: researchCommandInput,
    capturedCommand,
    previewBrief: previewResearchBriefValue,
  });
  const runPreviewResearchBrief = prepareResearchBrief({
    capturedCommand,
    previewBrief: previewResearchBriefValue,
  });
  const runFinalizeChecklist = finalizeChecklist({
    value: finalizeChecklistValue,
    log: eventLog,
  });
  const runConfirmReceipt = confirmReceipt({
    value: confirmReceiptValue,
    log: eventLog,
  });
  const runAuthorizeResearchSend = commitResearchSend({
    capturedCommand,
    previewBrief: previewResearchBriefValue,
    releasedValue: authorizeResearchSendValue,
    log: eventLog,
  });
  const setSafeLinkSource = setWritableString({ value: safeLinkSource });
  const prepareSafeLinkReleaseStream = prepareSafeLink({
    sourceUrl: safeLinkSource,
    preparedSafeLink: safeLinkPrepared,
  });
  const runReleaseSafeLink = commitSafeLinkRelease({
    preparedSafeLink: safeLinkPrepared,
    releasedValue: releaseSafeLinkValue,
    log: eventLog,
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

                <cf-card style="background: #fffdf8;">
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Incoming note excerpt</cf-label>
                    <div id="forward-source-note">{forwardSourceNote}</div>
                  </cf-vstack>
                </cf-card>

                <cf-vgroup gap="sm">
                  <cf-label for="forward-recipient">Forward recipient</cf-label>
                  <cf-input
                    id="forward-recipient"
                    $value={forwardRecipientInput}
                    placeholder="ops@hotel.example"
                  />
                </cf-vgroup>

                <cf-hstack gap="2" wrap>
                  <cf-button onClick={prepareForwardHotelNoteStream}>
                    Prepare forward
                  </cf-button>
                  <cf-button onClick={runForwardHotelNote}>
                    Forward trusted note
                  </cf-button>
                </cf-hstack>

                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Prepared outbound request</cf-label>
                    <div id="forward-prepared-preview">
                      {forwardPreparedPreview}
                    </div>
                    <cf-label>Committed release</cf-label>
                    <div id="forward-hotel-note">{forwardHotelNoteValue}</div>
                  </cf-vstack>
                </cf-card>
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

                <cf-vgroup gap="sm">
                  <cf-label for="research-command">Direct command</cf-label>
                  <cf-textarea
                    id="research-command"
                    $value={researchCommandInput}
                    rows={4}
                  />
                </cf-vgroup>

                <cf-hstack gap="2" wrap>
                  <cf-button onClick={runCaptureDirectCommand}>
                    Capture direct command
                  </cf-button>
                  <cf-button onClick={runPreviewResearchBrief}>
                    Prepare brief
                  </cf-button>
                  <cf-button onClick={runAuthorizeResearchSend}>
                    Authorize research send
                  </cf-button>
                </cf-hstack>

                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Captured command</cf-label>
                    <div id="captured-command">{capturedCommand}</div>
                    <cf-label>Prepared brief</cf-label>
                    <div id="preview-research-brief">
                      {previewResearchBriefValue}
                    </div>
                    <cf-label>Committed outbound action</cf-label>
                    <div id="authorize-research-send">
                      {authorizeResearchSendValue}
                    </div>
                  </cf-vstack>
                </cf-card>
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

                <cf-vgroup gap="sm">
                  <cf-label for="safe-link-source">Source URL</cf-label>
                  <cf-input
                    id="safe-link-source"
                    $value={safeLinkSource}
                    placeholder="https://source.example.com/private/report"
                  />
                </cf-vgroup>

                <cf-hstack gap="2" wrap>
                  <cf-button onClick={prepareSafeLinkReleaseStream}>
                    Prepare safe link
                  </cf-button>
                  <cf-button onClick={runReleaseSafeLink}>
                    Release safe link
                  </cf-button>
                </cf-hstack>

                <cf-card>
                  <cf-vstack slot="content" gap="2">
                    <cf-label>Prepared safe derivative</cf-label>
                    <div id="safe-link-prepared">{safeLinkPrepared}</div>
                    <cf-label>Committed release</cf-label>
                    <div id="release-safe-link">{releaseSafeLinkValue}</div>
                  </cf-vstack>
                </cf-card>
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
                  {ExampleCard({
                    title: "Disclosure Acknowledgement",
                    subtitle: "UI acknowledgement before declassification.",
                    value: acknowledgeDisclosureValue,
                    valueId: "acknowledge-disclosure",
                    action: runAcknowledgeDisclosure,
                    actionLabel: "Acknowledge Disclosure",
                  })}
                  {ExampleCard({
                    title: "Alert Acknowledgement",
                    subtitle:
                      "Trusted UI acknowledgment for an important alert.",
                    value: acknowledgeAlertValue,
                    valueId: "acknowledge-alert",
                    action: runAcknowledgeAlert,
                    actionLabel: "Acknowledge Alert",
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
                  {ExampleCard({
                    title: "Redacted Summary Release",
                    subtitle:
                      "Release the redacted derivative instead of the source.",
                    value: releaseRedactedSummaryValue,
                    valueId: "release-redacted-summary",
                    action: runReleaseRedactedSummary,
                    actionLabel: "Release Redacted Summary",
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
    completedCount: computed(() => eventLog.get().length),
    lastCompleted: computed(() => {
      const entries = eventLog.get();
      return entries[entries.length - 1] ?? "";
    }),
    hotelMembershipReturn,
    forwardHotelNote: forwardHotelNoteValue,
    forwardSourceNote: computed(() => forwardSourceNote.get()),
    forwardRecipientInput: computed(() => forwardRecipientInput.get()),
    forwardPreparedPreview: computed(() => forwardPreparedPreview.get()),
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
    previewResearchBrief: computed(() => previewResearchBriefValue.get()),
    researchCommandInput: computed(() => researchCommandInput.get()),
    capturedCommand,
    researchPreparedBrief: computed(() => previewResearchBriefValue.get()),
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
    safeLinkPrepared: computed(() => safeLinkPrepared.get()),
    safeLinkStage,
    safeLinkSourceCell: safeLinkSource,
    safeLinkPreparedCell: safeLinkPrepared,
    releaseSafeLinkCell: releaseSafeLinkValue,
    hotelMembershipReturnCell: hotelMembershipReturn,
    selectSearchResultCell: selectSearchResultValue,
    runHotelMembershipReturn,
    setForwardRecipient,
    prepareForwardHotelNote: prepareForwardHotelNoteStream,
    runForwardHotelNote,
    runSelectSearchResult,
    runAcknowledgeDisclosure,
    runAcknowledgeAlert,
    runAcceptInvite,
    runReleaseRedactedSummary,
    runEscalateSupportCase,
    setResearchCommand,
    runCaptureDirectCommand,
    runPreviewResearchBrief,
    runFinalizeChecklist,
    runConfirmReceipt,
    runAuthorizeResearchSend,
    setSafeLinkSource,
    prepareSafeLinkRelease: prepareSafeLinkReleaseStream,
    runReleaseSafeLink,
  };
});
