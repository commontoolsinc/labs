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
    <section
      style={{
        border: "1px solid #d7dbe0",
        borderRadius: "16px",
        padding: "16px",
        background: "#fffdf8",
      }}
    >
      <h3>{title}</h3>
      <p>{subtitle}</p>
      <div id={valueId}>{value}</div>
      <cf-button onClick={action}>{actionLabel}</cf-button>
    </section>
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
  forwardHotelNote: WriteAuthorizedBy<string, typeof forwardHotelNote>;
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
  previewResearchBrief: WriteAuthorizedBy<
    string,
    typeof previewResearchBrief
  >;
  finalizeChecklist: WriteAuthorizedBy<string, typeof finalizeChecklist>;
  confirmReceipt: WriteAuthorizedBy<string, typeof confirmReceipt>;
  captureDirectCommand: WriteAuthorizedBy<string, typeof captureDirectCommand>;
  authorizeResearchSend: WriteAuthorizedBy<
    string,
    typeof authorizeResearchSend
  >;
  releaseSafeLink: WriteAuthorizedBy<string, typeof releaseSafeLink>;
  runHotelMembershipReturn: Stream<void>;
  runForwardHotelNote: Stream<void>;
  runSelectSearchResult: Stream<void>;
  runAcknowledgeDisclosure: Stream<void>;
  runAcknowledgeAlert: Stream<void>;
  runAcceptInvite: Stream<void>;
  runReleaseRedactedSummary: Stream<void>;
  runEscalateSupportCase: Stream<void>;
  runPreviewResearchBrief: Stream<void>;
  runFinalizeChecklist: Stream<void>;
  runConfirmReceipt: Stream<void>;
  runCaptureDirectCommand: Stream<void>;
  runAuthorizeResearchSend: Stream<void>;
  runReleaseSafeLink: Stream<void>;
}

const returnHotelMembership = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Returned loyalty number to hotel@example.com");
  log.push("hotel-membership-return");
});

const forwardHotelNote = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Forwarded itinerary note through the trusted forwarder");
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

const previewResearchBrief = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Previewed the research brief without sending it");
  log.push("preview-research-brief");
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

const captureDirectCommand = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Captured the direct command in the trusted slot binder");
  log.push("capture-direct-command");
});

const authorizeResearchSend = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Authorized a bounded research-and-send intent");
  log.push("authorize-research-send");
});

const releaseSafeLink = handler<
  void,
  { value: Writable<string>; log: Writable<string[]> }
>((_, { value, log }) => {
  value.set("Released the safe link rather than the full source document");
  log.push("release-safe-link");
});

export default pattern<{}, GalleryOutput>(() => {
  const hotelMembershipReturn = Writable.of("");
  const forwardHotelNoteValue = Writable.of("");
  const selectSearchResultValue = Writable.of("");
  const acknowledgeDisclosureValue = Writable.of("");
  const acknowledgeAlertValue = Writable.of("");
  const acceptInviteValue = Writable.of("");
  const releaseRedactedSummaryValue = Writable.of("");
  const escalateSupportCaseValue = Writable.of("");
  const previewResearchBriefValue = Writable.of("");
  const finalizeChecklistValue = Writable.of("");
  const confirmReceiptValue = Writable.of("");
  const captureDirectCommandValue = Writable.of("");
  const authorizeResearchSendValue = Writable.of("");
  const releaseSafeLinkValue = Writable.of("");
  const eventLog = Writable.of<string[]>([]);

  const runHotelMembershipReturn = returnHotelMembership({
    value: hotelMembershipReturn,
    log: eventLog,
  });
  const runForwardHotelNote = forwardHotelNote({
    value: forwardHotelNoteValue,
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
  const runPreviewResearchBrief = previewResearchBrief({
    value: previewResearchBriefValue,
    log: eventLog,
  });
  const runFinalizeChecklist = finalizeChecklist({
    value: finalizeChecklistValue,
    log: eventLog,
  });
  const runConfirmReceipt = confirmReceipt({
    value: confirmReceiptValue,
    log: eventLog,
  });
  const runCaptureDirectCommand = captureDirectCommand({
    value: captureDirectCommandValue,
    log: eventLog,
  });
  const runAuthorizeResearchSend = authorizeResearchSend({
    value: authorizeResearchSendValue,
    log: eventLog,
  });
  const runReleaseSafeLink = releaseSafeLink({
    value: releaseSafeLinkValue,
    log: eventLog,
  });

  return {
    [NAME]: computed(() => "CFC Worked Example Gallery"),
    [UI]: (
      <div
        style={{
          display: "grid",
          gap: "16px",
          padding: "24px",
          background:
            "linear-gradient(180deg, rgba(255,250,235,1) 0%, rgba(244,247,250,1) 100%)",
        }}
      >
        <header>
          <h2>CFC Worked Example Gallery</h2>
          <p id="gallery-count">
            16 total examples across this branch: 2 standalone demos plus these
            14 spec-inspired cards.
          </p>
        </header>

        {ExampleCard({
          title: "Hotel Membership Return",
          subtitle: "Section 13.5.1 return-to-sender style release.",
          value: hotelMembershipReturn,
          valueId: "hotel-membership-return",
          action: runHotelMembershipReturn,
          actionLabel: "Return Membership Number",
        })}
        {ExampleCard({
          title: "Forward Hotel Note",
          subtitle: "Trusted forwarding path for a bounded excerpt.",
          value: forwardHotelNoteValue,
          valueId: "forward-hotel-note",
          action: runForwardHotelNote,
          actionLabel: "Forward Trusted Note",
        })}
        {ExampleCard({
          title: "Search Result Selection",
          subtitle: "Selection-decision integrity from a vetted result list.",
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
          subtitle: "Trusted UI acknowledgment for an important alert.",
          value: acknowledgeAlertValue,
          valueId: "acknowledge-alert",
          action: runAcknowledgeAlert,
          actionLabel: "Acknowledge Alert",
        })}
        {ExampleCard({
          title: "Invite Acceptance",
          subtitle: "User-approved acceptance of a shared-space invitation.",
          value: acceptInviteValue,
          valueId: "accept-invite",
          action: runAcceptInvite,
          actionLabel: "Accept Invite",
        })}
        {ExampleCard({
          title: "Redacted Summary Release",
          subtitle: "Release the redacted derivative instead of the source.",
          value: releaseRedactedSummaryValue,
          valueId: "release-redacted-summary",
          action: runReleaseRedactedSummary,
          actionLabel: "Release Redacted Summary",
        })}
        {ExampleCard({
          title: "Support Escalation",
          subtitle: "Escalate only the approved excerpt to a support sink.",
          value: escalateSupportCaseValue,
          valueId: "escalate-support-case",
          action: runEscalateSupportCase,
          actionLabel: "Escalate Support Case",
        })}
        {ExampleCard({
          title: "Research Brief Preview",
          subtitle: "Preview a research brief without authorizing the send.",
          value: previewResearchBriefValue,
          valueId: "preview-research-brief",
          action: runPreviewResearchBrief,
          actionLabel: "Preview Brief",
        })}
        {ExampleCard({
          title: "Checklist Finalization",
          subtitle: "Finalize a checklist after the trusted review step.",
          value: finalizeChecklistValue,
          valueId: "finalize-checklist",
          action: runFinalizeChecklist,
          actionLabel: "Finalize Checklist",
        })}
        {ExampleCard({
          title: "Receipt Confirmation",
          subtitle: "Confirm a returned artifact with explicit intent.",
          value: confirmReceiptValue,
          valueId: "confirm-receipt",
          action: runConfirmReceipt,
          actionLabel: "Confirm Receipt",
        })}
        {ExampleCard({
          title: "Direct Command Capture",
          subtitle: "Bind a direct command into the trusted UI slot.",
          value: captureDirectCommandValue,
          valueId: "capture-direct-command",
          action: runCaptureDirectCommand,
          actionLabel: "Capture Direct Command",
        })}
        {ExampleCard({
          title: "Authorize Research Send",
          subtitle: "Bounded intent for a research-to-email style flow.",
          value: authorizeResearchSendValue,
          valueId: "authorize-research-send",
          action: runAuthorizeResearchSend,
          actionLabel: "Authorize Research Send",
        })}
        {ExampleCard({
          title: "Safe Link Release",
          subtitle: "Release a safe link instead of the raw source payload.",
          value: releaseSafeLinkValue,
          valueId: "release-safe-link",
          action: runReleaseSafeLink,
          actionLabel: "Release Safe Link",
        })}
      </div>
    ),
    totalExamples: 16,
    completedCount: computed(() => eventLog.get().length),
    lastCompleted: computed(() => {
      const entries = eventLog.get();
      return entries[entries.length - 1] ?? "";
    }),
    hotelMembershipReturn,
    forwardHotelNote: forwardHotelNoteValue,
    selectSearchResult: selectSearchResultValue,
    acknowledgeDisclosure: acknowledgeDisclosureValue,
    acknowledgeAlert: acknowledgeAlertValue,
    acceptInvite: acceptInviteValue,
    releaseRedactedSummary: releaseRedactedSummaryValue,
    escalateSupportCase: escalateSupportCaseValue,
    previewResearchBrief: previewResearchBriefValue,
    finalizeChecklist: finalizeChecklistValue,
    confirmReceipt: confirmReceiptValue,
    captureDirectCommand: captureDirectCommandValue,
    authorizeResearchSend: authorizeResearchSendValue,
    releaseSafeLink: releaseSafeLinkValue,
    runHotelMembershipReturn,
    runForwardHotelNote,
    runSelectSearchResult,
    runAcknowledgeDisclosure,
    runAcknowledgeAlert,
    runAcceptInvite,
    runReleaseRedactedSummary,
    runEscalateSupportCase,
    runPreviewResearchBrief,
    runFinalizeChecklist,
    runConfirmReceipt,
    runCaptureDirectCommand,
    runAuthorizeResearchSend,
    runReleaseSafeLink,
  };
});
