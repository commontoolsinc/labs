import { assert, handler, pattern, Stream, TESTS } from "commonfabric";
import {
  AUTHORIZE_SEND_ACTION,
  CAPTURE_COMMAND_ACTION,
  PREPARE_BRIEF_ACTION,
  TRUSTED_DIRECT_COMMAND_SURFACE,
} from "../cfc/trusted-surfaces/direct-command.tsx";
import {
  FORWARD_NOTE_ACTION,
  PREPARE_FORWARD_ACTION,
  TRUSTED_FORWARD_SURFACE,
} from "../cfc/trusted-surfaces/forward.tsx";
import {
  PREPARE_SAFE_LINK_ACTION,
  RELEASE_SAFE_LINK_ACTION,
  TRUSTED_SAFE_LINK_SURFACE,
} from "../cfc/trusted-surfaces/safe-link.tsx";
import Gallery from "./main.tsx";

const sendString = handler<void, { stream: Stream<string>; next: string }>((
  _,
  { stream, next },
) => {
  stream.send(next);
});

export default pattern(() => {
  const instance = Gallery({});

  const action_prepare_forward = instance.prepareForwardHotelNote;
  const action_forward_note = instance.runForwardHotelNote;
  const action_capture_command = instance.runCaptureDirectCommand;
  const action_prepare_brief = instance.runPreviewResearchBrief;
  const action_authorize_send = instance.runAuthorizeResearchSend;
  const action_prepare_safe_link = instance.prepareSafeLinkRelease;
  const action_release_safe_link = instance.runReleaseSafeLink;
  const action_membership = instance.runHotelMembershipReturn;
  const action_select_search_result = instance.runSelectSearchResult;
  const action_finalize_checklist = instance.runFinalizeChecklist;
  const action_confirm_receipt = instance.runConfirmReceipt;

  const action_change_forward_recipient = sendString({
    stream: instance.setForwardRecipient,
    next: "night-audit@hotel.example",
  });
  const action_change_command = sendString({
    stream: instance.setResearchCommand,
    next:
      "Research the product launch and email a short briefing to launch@example.com",
  });
  const action_replace_command = sendString({
    stream: instance.setResearchCommand,
    next: "Research the replacement launch plan",
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
  const assert_stale_research_brief_not_sent = assert(() =>
    instance.completedCount === 1 &&
    instance.lastCompleted === "forward-hotel-note"
  );
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
    [TESTS]: [
      { assertion: assert_count },
      { action: action_change_forward_recipient },
      {
        action: action_prepare_forward,
        trustedUi: {
          surface: TRUSTED_FORWARD_SURFACE,
          action: PREPARE_FORWARD_ACTION,
        },
      },
      { assertion: assert_forward_prepared },
      {
        action: action_forward_note,
        trustedUi: {
          surface: TRUSTED_FORWARD_SURFACE,
          action: FORWARD_NOTE_ACTION,
        },
      },
      { assertion: assert_forward_committed },
      { action: action_change_command },
      {
        action: action_capture_command,
        trustedUi: {
          surface: TRUSTED_DIRECT_COMMAND_SURFACE,
          action: CAPTURE_COMMAND_ACTION,
        },
      },
      { assertion: assert_research_captured },
      {
        action: action_prepare_brief,
        trustedUi: {
          surface: TRUSTED_DIRECT_COMMAND_SURFACE,
          action: PREPARE_BRIEF_ACTION,
        },
      },
      { assertion: assert_research_prepared },
      { action: action_replace_command },
      {
        action: action_capture_command,
        trustedUi: {
          surface: TRUSTED_DIRECT_COMMAND_SURFACE,
          action: CAPTURE_COMMAND_ACTION,
        },
      },
      {
        action: action_authorize_send,
        trustedUi: {
          surface: TRUSTED_DIRECT_COMMAND_SURFACE,
          action: AUTHORIZE_SEND_ACTION,
        },
      },
      { assertion: assert_stale_research_brief_not_sent },
      {
        action: action_prepare_brief,
        trustedUi: {
          surface: TRUSTED_DIRECT_COMMAND_SURFACE,
          action: PREPARE_BRIEF_ACTION,
        },
      },
      {
        action: action_authorize_send,
        trustedUi: {
          surface: TRUSTED_DIRECT_COMMAND_SURFACE,
          action: AUTHORIZE_SEND_ACTION,
        },
      },
      { assertion: assert_research_sent },
      { action: action_change_source_url },
      {
        action: action_prepare_safe_link,
        trustedUi: {
          surface: TRUSTED_SAFE_LINK_SURFACE,
          action: PREPARE_SAFE_LINK_ACTION,
        },
      },
      { assertion: assert_safe_link_prepared },
      {
        action: action_release_safe_link,
        trustedUi: {
          surface: TRUSTED_SAFE_LINK_SURFACE,
          action: RELEASE_SAFE_LINK_ACTION,
        },
      },
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
