import { computed, handler, pattern, Stream } from "commonfabric";
import Gallery from "./main.tsx";

const trigger = handler<void, { stream: Stream<void> }>((_, { stream }) => {
  stream.send();
});

export default pattern(() => {
  const instance = Gallery({});

  const action_hotel_membership = trigger({
    stream: instance.runHotelMembershipReturn,
  });
  const action_forward_note = trigger({ stream: instance.runForwardHotelNote });
  const action_select_result = trigger({
    stream: instance.runSelectSearchResult,
  });
  const action_ack_disclosure = trigger({
    stream: instance.runAcknowledgeDisclosure,
  });
  const action_ack_alert = trigger({ stream: instance.runAcknowledgeAlert });
  const action_accept_invite = trigger({ stream: instance.runAcceptInvite });
  const action_release_redacted = trigger({
    stream: instance.runReleaseRedactedSummary,
  });
  const action_escalate = trigger({ stream: instance.runEscalateSupportCase });
  const action_preview = trigger({ stream: instance.runPreviewResearchBrief });
  const action_finalize = trigger({ stream: instance.runFinalizeChecklist });
  const action_confirm = trigger({ stream: instance.runConfirmReceipt });
  const action_capture = trigger({ stream: instance.runCaptureDirectCommand });
  const action_authorize = trigger({
    stream: instance.runAuthorizeResearchSend,
  });
  const action_safe_link = trigger({ stream: instance.runReleaseSafeLink });

  const assert_count = computed(() => instance.totalExamples === 16);
  const assert_hotel = computed(() =>
    instance.completedCount === 1 &&
    instance.lastCompleted === "hotel-membership-return"
  );
  const assert_forward = computed(() =>
    instance.completedCount === 2 &&
    instance.lastCompleted === "forward-hotel-note"
  );
  const assert_select = computed(() =>
    instance.completedCount === 3 &&
    instance.lastCompleted === "select-search-result"
  );
  const assert_disclosure = computed(() =>
    instance.completedCount === 4 &&
    instance.lastCompleted === "acknowledge-disclosure"
  );
  const assert_alert = computed(() =>
    instance.completedCount === 5 &&
    instance.lastCompleted === "acknowledge-alert"
  );
  const assert_invite = computed(() =>
    instance.completedCount === 6 &&
    instance.lastCompleted === "accept-invite"
  );
  const assert_redacted = computed(() =>
    instance.completedCount === 7 &&
    instance.lastCompleted === "release-redacted-summary"
  );
  const assert_escalate = computed(() =>
    instance.completedCount === 8 &&
    instance.lastCompleted === "escalate-support-case"
  );
  const assert_preview = computed(() =>
    instance.completedCount === 9 &&
    instance.lastCompleted === "preview-research-brief"
  );
  const assert_finalize = computed(() =>
    instance.completedCount === 10 &&
    instance.lastCompleted === "finalize-checklist"
  );
  const assert_confirm = computed(() =>
    instance.completedCount === 11 &&
    instance.lastCompleted === "confirm-receipt"
  );
  const assert_capture = computed(() =>
    instance.completedCount === 12 &&
    instance.lastCompleted === "capture-direct-command"
  );
  const assert_authorize = computed(() =>
    instance.completedCount === 13 &&
    instance.lastCompleted === "authorize-research-send"
  );
  const assert_safe_link = computed(() =>
    instance.completedCount === 14 &&
    instance.lastCompleted === "release-safe-link"
  );

  return {
    tests: [
      { assertion: assert_count },
      { action: action_hotel_membership },
      { assertion: assert_hotel },
      { action: action_forward_note },
      { assertion: assert_forward },
      { action: action_select_result },
      { assertion: assert_select },
      { action: action_ack_disclosure },
      { assertion: assert_disclosure },
      { action: action_ack_alert },
      { assertion: assert_alert },
      { action: action_accept_invite },
      { assertion: assert_invite },
      { action: action_release_redacted },
      { assertion: assert_redacted },
      { action: action_escalate },
      { assertion: assert_escalate },
      { action: action_preview },
      { assertion: assert_preview },
      { action: action_finalize },
      { assertion: assert_finalize },
      { action: action_confirm },
      { assertion: assert_confirm },
      { action: action_capture },
      { assertion: assert_capture },
      { action: action_authorize },
      { assertion: assert_authorize },
      { action: action_safe_link },
      { assertion: assert_safe_link },
    ],
    instance,
  };
});
