import { action, computed, Default, pattern, Writable } from "commonfabric";
import {
  applyTrustedMessageSend,
  applyTrustedProfileSave,
  createRandomInvalidClaimedMessages,
  type DisplayChatMessage,
  type InvalidClaimedChatMessage,
  sortDisplayMessages,
  type TrustedChatMessage,
  type TrustedParticipant,
} from "./logic.ts";

export default pattern(() => {
  const participants = Writable.of<TrustedParticipant[] | Default<[]>>(
    [] as Default<[]>,
  );
  const messages = Writable.of<TrustedChatMessage[] | Default<[]>>(
    [] as Default<[]>,
  );
  const invalidMessages = Writable.of<
    InvalidClaimedChatMessage[] | Default<[]>
  >(
    [] as Default<[]>,
  );
  const profileDraftOne = Writable.of("");
  const profileDraftTwo = Writable.of("");
  const messageDraftOne = Writable.of("");
  const messageDraftTwo = Writable.of("");

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
      messages.get() as TrustedChatMessage[],
      participants.get() as TrustedParticipant[],
      "participant-1",
      messageDraftOne.get(),
    );
    messages.set(nextMessages as TrustedChatMessage[] | Default<[]>);
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
      messages.get() as TrustedChatMessage[],
      participants.get() as TrustedParticipant[],
      "participant-2",
      messageDraftTwo.get(),
    );
    messages.set(nextMessages as TrustedChatMessage[] | Default<[]>);
    if (trimmedBody) {
      messageDraftTwo.set("");
    }
  });
  const action_add_random_invalid = action(() => {
    const trustedMessages = Array.from(
      messages.get() as TrustedChatMessage[],
    );
    const existingInvalidMessages = Array.from(
      invalidMessages.get() as InvalidClaimedChatMessage[],
    );
    const nextInvalidMessages = createRandomInvalidClaimedMessages(
      [
        ...trustedMessages.map((message) => message as DisplayChatMessage),
        ...existingInvalidMessages.map((message) =>
          message as DisplayChatMessage
        ),
      ],
      participants.get() as TrustedParticipant[],
    );
    invalidMessages.set(
      [
        ...existingInvalidMessages,
        ...nextInvalidMessages,
      ] as InvalidClaimedChatMessage[] | Default<[]>,
    );
  });

  const assert_initially_empty = computed(() =>
    (participants.get()?.length ?? 0) === 0 &&
    (messages.get()?.length ?? 0) === 0 &&
    (invalidMessages.get()?.length ?? 0) === 0
  );
  const assert_profile_one_upserted = computed(() =>
    participants.get().length === 1 &&
    participants.get()[0]?.id === "participant-1" &&
    participants.get()[0]?.name === "Alice"
  );
  const assert_message_one_sent = computed(() =>
    messages.get().length === 1 &&
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
    messages.get()[0]?.body === "Hello from Alice" &&
    messages.get()[1]?.body === "Hello from Bob" &&
    messages.get()[1]?.author.name === "Bob"
  );
  const assert_invalid_messages_injected = computed(() =>
    invalidMessages.get().length === 2 &&
    invalidMessages.get().every((message) =>
      ["participant-1", "participant-2"].includes(message.author.id) &&
      ["Alice Renamed", "Bob"].includes(message.author.name) &&
      message.body.length > 0
    )
  );
  const assert_thread_order_sortable = computed(() => {
    const trustedMessages = Array.from(
      messages.get() as TrustedChatMessage[],
    );
    const claimedMessages = Array.from(
      invalidMessages.get() as InvalidClaimedChatMessage[],
    );
    const ordered = sortDisplayMessages([
      ...trustedMessages.map((message) => message as DisplayChatMessage),
      ...claimedMessages.map((message) => message as DisplayChatMessage),
    ]);
    return ordered.length === 4 &&
      ordered.every((message, index) =>
        index === 0 || ordered[index - 1]!.timestamp <= message.timestamp
      );
  });

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
      { action: action_add_random_invalid },
      { assertion: assert_invalid_messages_injected },
      { assertion: assert_thread_order_sortable },
    ],
  };
});
