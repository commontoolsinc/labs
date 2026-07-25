import { assert, handler, pattern, Stream } from "commonfabric";
import Gallery from "./main.tsx";

const trigger = handler<void, { stream: Stream<void> }>((_, { stream }) => {
  stream.send();
});

const sendString = handler<void, { stream: Stream<string>; next: string }>((
  _,
  { stream, next },
) => {
  stream.send(next);
});

export default pattern(() => {
  const instance = Gallery({});

  const action_prepare_forward = trigger({
    stream: instance.prepareForwardHotelNote,
  });
  const action_forward_note = trigger({ stream: instance.runForwardHotelNote });
  const action_capture_command = trigger({
    stream: instance.runCaptureDirectCommand,
  });
  const action_prepare_brief = trigger({
    stream: instance.runPreviewResearchBrief,
  });
  const action_authorize_send = trigger({
    stream: instance.runAuthorizeResearchSend,
  });
  const action_prepare_safe_link = trigger({
    stream: instance.prepareSafeLinkRelease,
  });
  const action_release_safe_link = trigger({
    stream: instance.runReleaseSafeLink,
  });
  const action_membership = trigger({
    stream: instance.runHotelMembershipReturn,
  });
  const action_select_search_result = trigger({
    stream: instance.runSelectSearchResult,
  });
  const action_finalize_checklist = trigger({
    stream: instance.runFinalizeChecklist,
  });
  const action_confirm_receipt = trigger({
    stream: instance.runConfirmReceipt,
  });

  const action_change_forward_recipient = sendString({
    stream: instance.setForwardRecipient,
    next: "night-audit@hotel.example",
  });
  const action_change_command = sendString({
    stream: instance.setResearchCommand,
    next:
      "Research the product launch and email a short briefing to launch@example.com",
  });
  const action_change_source_url = sendString({
    stream: instance.setSafeLinkSource,
    next:
      "https://source.example.com/private/source?token=debug&draft=internal",
  });

  const assert_count = assert(() => instance.totalExamples === 16);
  const assert_forward_prepared = assert(() => instance.completedCount === 0);
  const assert_forward_committed = assert(() =>
    instance.completedCount === 1 &&
    instance.lastCompleted === "forward-hotel-note"
  );
  const assert_research_captured = assert(() =>
    instance.completedCount === 1 &&
    instance.lastCompleted === "forward-hotel-note"
  );
  const assert_research_prepared = assert(() => instance.completedCount === 1);
  const assert_research_sent = assert(() =>
    instance.completedCount === 2 &&
    instance.lastCompleted === "authorize-research-send"
  );
  const assert_safe_link_prepared = assert(() =>
    instance.completedCount === 2 &&
    instance.lastCompleted === "authorize-research-send"
  );
  const assert_safe_link_released = assert(() =>
    instance.completedCount === 3 &&
    instance.lastCompleted === "release-safe-link"
  );
  const assert_remaining_actions_do_not_regress_completed_flow = assert(() =>
    instance.completedCount >= 3 &&
    instance.lastCompleted !== ""
  );

  return {
    tests: [
      { assertion: assert_count },
      { action: action_change_forward_recipient },
      { action: action_prepare_forward },
      { assertion: assert_forward_prepared },
      { action: action_forward_note },
      { assertion: assert_forward_committed },
      { action: action_change_command },
      { action: action_capture_command },
      { assertion: assert_research_captured },
      { action: action_prepare_brief },
      { assertion: assert_research_prepared },
      { action: action_authorize_send },
      { assertion: assert_research_sent },
      { action: action_change_source_url },
      { action: action_prepare_safe_link },
      { assertion: assert_safe_link_prepared },
      { action: action_release_safe_link },
      { assertion: assert_safe_link_released },
      { action: action_membership },
      { action: action_select_search_result },
      { action: action_finalize_checklist },
      { action: action_confirm_receipt },
      { assertion: assert_remaining_actions_do_not_regress_completed_flow },
    ],
    instance,
  };
});
