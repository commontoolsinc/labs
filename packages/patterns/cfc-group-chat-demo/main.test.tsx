import { action, computed, Default, pattern, Writable } from "commonfabric";
import { sortDisplayMessages } from "./logic.ts";
import {
  type EmptyMyProfileValue,
  type MyProfileCellValue,
  type MyProfileValue,
  participantClaimsValue,
  type SharedChatMessage,
  type SharedMessagesValue,
} from "./trusted.tsx";
import { GroupChatDemo } from "./main.tsx";

type GroupChatDemoInputArg = Parameters<typeof GroupChatDemo>[0];

export default pattern(() => {
  const myProfile = Writable.of<MyProfileCellValue>(
    {} as Default<EmptyMyProfileValue>,
  );
  const messages = Writable.of<SharedMessagesValue>(
    [] as SharedMessagesValue,
  );
  const profileDraft = Writable.of("");
  const messageDraft = Writable.of("");
  const hostMessageDraft = Writable.of("");
  const chat = GroupChatDemo({
    myProfile,
    messages,
    profileDraft,
    messageDraft,
    hostMessageDraft,
  } as GroupChatDemoInputArg);

  const action_set_profile_alice = action(() => {
    chat.setProfileDraft.send("Alice");
  });
  const action_save_profile = action(() => {
    chat.saveProfile.send();
  });
  const action_set_message_alice = action(() => {
    chat.setMessageDraft.send("Hello from Alice");
  });
  const action_send_message = action(() => {
    chat.sendTrustedMessage.send();
  });
  const action_set_profile_rename = action(() => {
    chat.setProfileDraft.send("Alice Renamed");
  });
  const action_set_message_after_rename = action(() => {
    chat.setMessageDraft.send("After rename");
  });
  const action_save_profile_rename = action(() => {
    chat.saveProfile.send();
  });
  const action_add_random_imported = action(() => {
    chat.addRandomMessages.send();
  });
  const action_add_same_name_unverified_imports = action(() => {
    messages.set([
      ...(messages.get() as SharedChatMessage[]),
      {
        origin: "imported",
        id: "same-name-imported-1",
        authorName: "Sam",
        body: "first Sam",
        timestamp: 10_000,
      },
      {
        origin: "imported",
        id: "same-name-imported-2",
        authorName: "Sam",
        body: "second Sam",
        timestamp: 10_001,
      },
    ]);
  });

  const assert_initially_empty = computed(() =>
    (myProfile.get() as MyProfileValue | undefined)?.profile === undefined &&
    (messages.get()?.length ?? 0) === 0
  );
  const assert_profile_created = computed(() =>
    chat.currentProfileName === "Alice"
  );
  const assert_message_sent_and_draft_cleared = computed(() =>
    messages.get().length === 1 &&
    messages.get()[0]?.origin === "sent" &&
    messages.get()[0]?.authorName === "Alice" &&
    messages.get()[0]?.body === "Hello from Alice" &&
    messageDraft.get() === ""
  );
  const assert_profile_renamed = computed(() =>
    chat.currentProfileName === "Alice Renamed"
  );
  const assert_message_snapshot_stable = computed(() =>
    messages.get().length >= 1 &&
    messages.get()[0]?.authorName === "Alice"
  );
  const assert_second_message_uses_current_name = computed(() =>
    messages.get().length === 2 &&
    messages.get()[1]?.origin === "sent" &&
    messages.get()[1]?.authorName === "Alice Renamed" &&
    messages.get()[1]?.body === "After rename"
  );
  const assert_imported_messages_injected = computed(() => {
    const messageList = Array.from(messages.get() as SharedChatMessage[]);
    const importedMessages = messageList.filter((message) =>
      message.origin === "imported"
    );
    return messageList.length === 4 &&
      importedMessages.length === 2 &&
      importedMessages.every((message) =>
        message.authorName.length > 0 &&
        message.body.length > 0 &&
        message.authorProfile === undefined
      );
  });
  const assert_thread_order_sortable = computed(() => {
    const ordered = sortDisplayMessages(messages.get() as SharedChatMessage[]);
    return ordered.length === 4 &&
      ordered.every((message, index) =>
        index === 0 || ordered[index - 1]!.timestamp <= message.timestamp
      );
  });
  const assert_same_name_unverified_imports_are_distinct = computed(() => {
    const participants = participantClaimsValue(myProfile, messages);
    return participants.filter((participant) =>
      participant.name === "Sam" && participant.profile === undefined
    ).length === 2;
  });

  return {
    tests: [
      { assertion: assert_initially_empty },
      { action: action_set_profile_alice },
      { action: action_save_profile },
      { assertion: assert_profile_created },
      { action: action_set_message_alice },
      { action: action_send_message },
      { assertion: assert_message_sent_and_draft_cleared },
      { action: action_set_profile_rename },
      { action: action_save_profile_rename },
      { assertion: assert_profile_renamed },
      { assertion: assert_message_snapshot_stable },
      { action: action_set_message_after_rename },
      { action: action_send_message },
      { assertion: assert_second_message_uses_current_name },
      { action: action_add_random_imported },
      { assertion: assert_imported_messages_injected },
      { assertion: assert_thread_order_sortable },
      { action: action_add_same_name_unverified_imports },
      { assertion: assert_same_name_unverified_imports_are_distinct },
    ],
  };
});
