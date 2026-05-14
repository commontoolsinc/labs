import { action, computed, Default, pattern, Writable } from "commonfabric";
import {
  createRandomImportedClaimedMessages,
  sortDisplayMessages,
} from "./logic.ts";
import {
  applyTrustedMessageSend,
  applyTrustedProfileSave,
  type SharedChatMessage,
  type SharedMessagesValue,
  type SharedParticipantsValue,
  type SlotSelectionValue,
  type TrustedParticipant,
} from "./trusted.tsx";
import { GroupChatDemo } from "./main.tsx";

export default pattern(() => {
  const participants = Writable.of<TrustedParticipant[] | Default<[]>>(
    [] as Default<[]>,
  );
  const messages = Writable.of<SharedChatMessage[] | Default<[]>>(
    [] as Default<[]>,
  );
  const profileDraftOne = Writable.of("");
  const profileDraftTwo = Writable.of("");
  const messageDraftOne = Writable.of("");
  const messageDraftTwo = Writable.of("");
  const scopedParticipants = Writable.of<SharedParticipantsValue>(
    [] as SharedParticipantsValue,
  );
  const scopedMessages = Writable.of<SharedMessagesValue>(
    [] as SharedMessagesValue,
  );
  const scopedActiveSlot = Writable.of<SlotSelectionValue>("participant-1");
  const scopedProfileDraft = Writable.of("");
  const scopedMessageDraft = Writable.of("");
  const scopedHostMessageDraft = Writable.of("");
  const scopedChat = GroupChatDemo({
    participants: scopedParticipants,
    messages: scopedMessages,
    activeSlot: scopedActiveSlot,
    profileDraft: scopedProfileDraft,
    messageDraft: scopedMessageDraft,
    hostMessageDraft: scopedHostMessageDraft,
  });

  const action_set_profile_one = action(() => {
    profileDraftOne.set("Alice");
  });
  const action_save_profile_one = action(() => {
    const { trimmedName, nextParticipants } = applyTrustedProfileSave(
      participants.get() as TrustedParticipant[],
      "participant-1",
      profileDraftOne.get(),
    );
    participants.set(nextParticipants as TrustedParticipant[] | Default<[]>);
    if (trimmedName) {
      profileDraftOne.set(trimmedName);
    }
  });
  const action_set_message_one = action(() => {
    messageDraftOne.set("Hello from Alice");
  });
  const action_send_message_one = action(() => {
    const { trimmedBody, nextMessages } = applyTrustedMessageSend(
      messages.get() as SharedChatMessage[],
      participants.get() as TrustedParticipant[],
      "participant-1",
      messageDraftOne.get(),
    );
    messages.set(nextMessages as SharedChatMessage[] | Default<[]>);
    if (trimmedBody) {
      messageDraftOne.set("");
    }
  });
  const action_rename_profile_one = action(() => {
    profileDraftOne.set("Alice Renamed");
  });
  const action_save_rename_profile_one = action(() => {
    const { trimmedName, nextParticipants } = applyTrustedProfileSave(
      participants.get() as TrustedParticipant[],
      "participant-1",
      profileDraftOne.get(),
    );
    participants.set(nextParticipants as TrustedParticipant[] | Default<[]>);
    if (trimmedName) {
      profileDraftOne.set(trimmedName);
    }
  });
  const action_set_profile_two = action(() => {
    profileDraftTwo.set("Bob");
  });
  const action_save_profile_two = action(() => {
    const { trimmedName, nextParticipants } = applyTrustedProfileSave(
      participants.get() as TrustedParticipant[],
      "participant-2",
      profileDraftTwo.get(),
    );
    participants.set(nextParticipants as TrustedParticipant[] | Default<[]>);
    if (trimmedName) {
      profileDraftTwo.set(trimmedName);
    }
  });
  const action_set_message_two = action(() => {
    messageDraftTwo.set("Hello from Bob");
  });
  const action_send_message_two = action(() => {
    const { trimmedBody, nextMessages } = applyTrustedMessageSend(
      messages.get() as SharedChatMessage[],
      participants.get() as TrustedParticipant[],
      "participant-2",
      messageDraftTwo.get(),
    );
    messages.set(nextMessages as SharedChatMessage[] | Default<[]>);
    if (trimmedBody) {
      messageDraftTwo.set("");
    }
  });
  const action_add_random_imported = action(() => {
    const nextImportedMessages = createRandomImportedClaimedMessages(
      messages.get() as SharedChatMessage[],
      participants.get() as TrustedParticipant[],
    );
    messages.set(
      [
        ...(messages.get() as SharedChatMessage[]),
        ...nextImportedMessages,
      ] as SharedChatMessage[] | Default<[]>,
    );
  });
  const action_scoped_set_profile_one = action(() => {
    scopedChat.setProfileDraft.send("Scoped Alice");
  });
  const action_scoped_save_profile_one = action(() => {
    scopedChat.saveProfile.send();
  });
  const action_scoped_set_message_one = action(() => {
    scopedChat.setMessageDraft.send("Scoped hello");
  });
  const action_scoped_send_message_one = action(() => {
    scopedChat.sendTrustedMessage.send();
  });
  const action_scoped_select_slot_two = action(() => {
    scopedChat.setActiveSlot.send("participant-2");
  });
  const action_scoped_set_profile_two = action(() => {
    scopedChat.setProfileDraft.send("Scoped Bob");
  });
  const action_scoped_save_profile_two = action(() => {
    scopedChat.saveProfile.send();
  });
  const action_scoped_set_message_two = action(() => {
    scopedChat.setMessageDraft.send("Scoped Bob hello");
  });
  const action_scoped_send_message_two = action(() => {
    scopedChat.sendTrustedMessage.send();
  });

  const assert_initially_empty = computed(() =>
    (participants.get()?.length ?? 0) === 0 &&
    (messages.get()?.length ?? 0) === 0
  );
  const assert_profile_one_upserted = computed(() =>
    participants.get().length === 1 &&
    participants.get()[0]?.id === "participant-1" &&
    participants.get()[0]?.name === "Alice"
  );
  const assert_message_one_sent = computed(() =>
    messages.get().length === 1 &&
    messages.get()[0]?.origin === "sent" &&
    messages.get()[0]?.author.id === "participant-1" &&
    messages.get()[0]?.author.name === "Alice" &&
    messages.get()[0]?.body === "Hello from Alice"
  );
  const assert_profile_one_renamed = computed(() =>
    participants.get().length === 1 &&
    participants.get()[0]?.name === "Alice Renamed"
  );
  const assert_message_one_snapshot_stable = computed(() =>
    messages.get().length >= 1 &&
    messages.get()[0]?.author.name === "Alice"
  );
  const assert_profile_two_added = computed(() =>
    participants.get().length === 2 &&
    participants.get()[1]?.id === "participant-2" &&
    participants.get()[1]?.name === "Bob"
  );
  const assert_message_order_deterministic = computed(() =>
    messages.get().length === 2 &&
    messages.get()[0]?.origin === "sent" &&
    messages.get()[1]?.origin === "sent" &&
    messages.get()[0]?.body === "Hello from Alice" &&
    messages.get()[1]?.body === "Hello from Bob" &&
    messages.get()[1]?.author.name === "Bob"
  );
  const assert_imported_messages_injected = computed(() => {
    const messageList = Array.from(messages.get() as SharedChatMessage[]);
    const importedMessages = messageList.filter((message) =>
      message.origin === "imported"
    );
    return messageList.length === 4 &&
      importedMessages.length === 2 &&
      importedMessages.every((message) =>
        ["participant-1", "participant-2"].includes(message.author.id) &&
        ["Alice Renamed", "Bob"].includes(message.author.name) &&
        message.body.length > 0
      );
  });
  const assert_thread_order_sortable = computed(() => {
    const ordered = sortDisplayMessages(messages.get() as SharedChatMessage[]);
    return ordered.length === 4 &&
      ordered.every((message, index) =>
        index === 0 || ordered[index - 1]!.timestamp <= message.timestamp
      );
  });
  const assert_scoped_profile_one_saved = computed(() =>
    scopedChat.participants.length === 1 &&
    scopedChat.participants[0]?.id === "participant-1" &&
    scopedChat.participants[0]?.name === "Scoped Alice"
  );
  const assert_scoped_message_one_sent = computed(() =>
    scopedChat.messages.length === 1 &&
    scopedChat.messages[0]?.body === "Scoped hello" &&
    scopedChat.messages[0]?.author.id === "participant-1" &&
    scopedChat.messages[0]?.author.name === "Scoped Alice"
  );
  const assert_scoped_profile_two_saved = computed(() =>
    scopedChat.participants.length === 2 &&
    scopedChat.participants[1]?.id === "participant-2" &&
    scopedChat.participants[1]?.name === "Scoped Bob"
  );
  const assert_scoped_message_two_sent = computed(() =>
    scopedChat.messages.length === 2 &&
    scopedChat.messages[1]?.body === "Scoped Bob hello" &&
    scopedChat.messages[1]?.author.id === "participant-2" &&
    scopedChat.messages[1]?.author.name === "Scoped Bob"
  );

  return {
    tests: [
      { assertion: assert_initially_empty },
      { action: action_set_profile_one },
      { action: action_save_profile_one },
      { assertion: assert_profile_one_upserted },
      { action: action_set_message_one },
      { action: action_send_message_one },
      { assertion: assert_message_one_sent },
      { action: action_rename_profile_one },
      { action: action_save_rename_profile_one },
      { assertion: assert_profile_one_renamed },
      { assertion: assert_message_one_snapshot_stable },
      { action: action_set_profile_two },
      { action: action_save_profile_two },
      { assertion: assert_profile_two_added },
      { action: action_set_message_two },
      { action: action_send_message_two },
      { assertion: assert_message_order_deterministic },
      { action: action_add_random_imported },
      { assertion: assert_imported_messages_injected },
      { assertion: assert_thread_order_sortable },
      { action: action_scoped_set_profile_one },
      { action: action_scoped_save_profile_one },
      { assertion: assert_scoped_profile_one_saved },
      { action: action_scoped_set_message_one },
      { action: action_scoped_send_message_one },
      { assertion: assert_scoped_message_one_sent },
      { action: action_scoped_select_slot_two },
      { action: action_scoped_set_profile_two },
      { action: action_scoped_save_profile_two },
      { assertion: assert_scoped_profile_two_saved },
      { action: action_scoped_set_message_two },
      { action: action_scoped_send_message_two },
      { assertion: assert_scoped_message_two_sent },
    ],
  };
});
