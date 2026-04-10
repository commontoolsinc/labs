import { computed, handler, pattern, Stream, Writable } from "commonfabric";
import {
  TrustedDirectCommandSurface,
  TrustedForwardSurface,
  TrustedSafeLinkSurface,
  TrustedSaveSurface,
} from "./main.tsx";

const setString = handler<void, { value: Writable<string>; next: string }>((
  _,
  { value, next },
) => {
  value.set(next);
});

const trigger = handler<void, { stream: Stream<void> }>((_, { stream }) => {
  stream.send();
});

export default pattern(() => {
  const draftTitle = Writable.of("");
  const savedTitle = Writable.of("");
  const forwardSource = Writable.of(
    "Guest arrives late and needs the bell desk to hold room access after midnight. Raw inbox context stays in the note.",
  );
  const forwardRecipient = Writable.of("ops@hotel.example");
  const forwardPrepared = Writable.of("");
  const forwardedNote = Writable.of("");
  const commandInput = Writable.of(
    "Research Common Fabric launch updates and email a three-bullet brief to team@example.com",
  );
  const capturedCommand = Writable.of("");
  const preparedBrief = Writable.of("");
  const authorizedSend = Writable.of("");
  const sourceUrl = Writable.of(
    "https://source.example.com/private/report?token=secret-token&draft=internal",
  );
  const preparedSafeLink = Writable.of("");
  const releasedSafeLink = Writable.of("");

  const trustedSave = TrustedSaveSurface({ draftTitle, savedTitle });
  const trustedForward = TrustedForwardSurface({
    sourceNote: forwardSource,
    recipientInput: forwardRecipient,
    preparedPreview: forwardPrepared,
    forwardedNote,
  });
  const trustedDirect = TrustedDirectCommandSurface({
    commandInput,
    capturedCommand,
    preparedBrief,
    authorizedSend,
  });
  const trustedSafeLink = TrustedSafeLinkSurface({
    sourceUrl,
    preparedSafeLink,
    releasedSafeLink,
  });

  const action_set_title = setString({
    value: draftTitle,
    next: "Saved from trusted surface",
  });
  const action_save = trigger({ stream: trustedSave.save });
  const action_set_recipient = setString({
    value: forwardRecipient,
    next: "night-audit@hotel.example",
  });
  const action_prepare_forward = trigger({
    stream: trustedForward.prepareForward,
  });
  const action_commit_forward = trigger({ stream: trustedForward.forwardNote });
  const action_capture_command = trigger({
    stream: trustedDirect.captureCommand,
  });
  const action_prepare_brief = trigger({ stream: trustedDirect.prepareBrief });
  const action_authorize_send = trigger({
    stream: trustedDirect.authorizeSend,
  });
  const action_prepare_safe_link = trigger({
    stream: trustedSafeLink.prepareSafeLink,
  });
  const action_release_safe_link = trigger({
    stream: trustedSafeLink.releaseSafeLink,
  });

  const assert_saved = computed(() =>
    savedTitle.get() === "Saved from trusted surface"
  );
  const assert_forward_prepared = computed(() =>
    forwardPrepared.get() ===
      "Prepared for night-audit@hotel.example: Guest arrives late and needs the bell desk to hold room access after midnight. Only the bounded itinerary excerpt will be forwarded."
  );
  const assert_forward_committed = computed(() =>
    forwardedNote.get() === forwardPrepared.get()
  );
  const assert_command_captured = computed(() =>
    capturedCommand.get() ===
      "Research Common Fabric launch updates and email a three-bullet brief to team@example.com"
  );
  const assert_brief_prepared = computed(() =>
    preparedBrief.get() ===
      'Prepared outbound draft: concise summary for "Research Common Fabric launch updates and email a three-bullet brief to team@example.com". The send action stays separately gated.'
  );
  const assert_send_authorized = computed(() =>
    authorizedSend.get() ===
      'Authorized outbound message for "Research Common Fabric launch updates and email a three-bullet brief to team@example.com": Prepared outbound draft: concise summary for "Research Common Fabric launch updates and email a three-bullet brief to team@example.com". The send action stays separately gated.'
  );
  const assert_safe_link_prepared = computed(() =>
    preparedSafeLink.get() ===
      "https://source.example.com/private/report?view=summary"
  );
  const assert_safe_link_released = computed(() =>
    releasedSafeLink.get() ===
      "Released safe link https://source.example.com/private/report?view=summary"
  );

  return {
    tests: [
      { action: action_set_title },
      { action: action_save },
      { assertion: assert_saved },
      { action: action_set_recipient },
      { action: action_prepare_forward },
      { assertion: assert_forward_prepared },
      { action: action_commit_forward },
      { assertion: assert_forward_committed },
      { action: action_capture_command },
      { assertion: assert_command_captured },
      { action: action_prepare_brief },
      { assertion: assert_brief_prepared },
      { action: action_authorize_send },
      { assertion: assert_send_authorized },
      { action: action_prepare_safe_link },
      { assertion: assert_safe_link_prepared },
      { action: action_release_safe_link },
      { assertion: assert_safe_link_released },
    ],
    trustedSave,
    trustedForward,
    trustedDirect,
    trustedSafeLink,
  };
});
