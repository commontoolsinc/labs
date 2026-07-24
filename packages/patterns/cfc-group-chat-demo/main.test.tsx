import { action, assert, Default, pattern, UI, Writable } from "commonfabric";
import {
  findNodeById,
  findNodeByProp,
  nodeIncludesText,
  propValue,
} from "../test-ui-helpers.ts";
import {
  createRandomImportedClaimedMessages,
  seededRandom,
  sortDisplayMessages,
} from "./logic.ts";
import {
  type ChatAdminRegistryValue,
  chatAdminRolesValue,
  type EmptyMyProfileValue,
  type MyProfileCellValue,
  type MyProfileValue,
  participantClaimsValue,
  roomsValue,
  type SharedChatMessage,
  type SharedMessagesValue,
  type SharedProfilesValue,
  type SharedRoomsValue,
  TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION,
  TRUSTED_GROUP_CHAT_ADMIN_SURFACE,
  TRUSTED_GROUP_CHAT_PROFILE_SURFACE,
  TRUSTED_GROUP_CHAT_ROOM_SURFACE,
  TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
  TRUSTED_GROUP_CHAT_SEND_ACTION,
  TRUSTED_GROUP_CHAT_SEND_SURFACE,
  TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
} from "./trusted.tsx";
import { GroupChatDemo } from "./main.tsx";

// Renderer-trusted gestures for the protected writes (profile save, message
// send, room add, admin policy). Under CFC enforcement these steps must be
// sent with trusted DOM provenance for the reviewed surface — the headless
// equivalent of clicking the surface's button.
const profileGesture = {
  surface: TRUSTED_GROUP_CHAT_PROFILE_SURFACE,
  action: TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
};
const sendGesture = {
  surface: TRUSTED_GROUP_CHAT_SEND_SURFACE,
  action: TRUSTED_GROUP_CHAT_SEND_ACTION,
};
const roomGesture = {
  surface: TRUSTED_GROUP_CHAT_ROOM_SURFACE,
  action: TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION,
};
const adminGesture = {
  surface: TRUSTED_GROUP_CHAT_ADMIN_SURFACE,
  action: TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
};

type GroupChatDemoInputArg = Parameters<typeof GroupChatDemo>[0];

export default pattern(() => {
  const myProfile = Writable.of<MyProfileCellValue>(
    {} as Default<EmptyMyProfileValue>,
  );
  const messages = Writable.of<SharedMessagesValue>(
    [] as SharedMessagesValue,
  );
  const profiles = Writable.of<SharedProfilesValue>(
    [] as SharedProfilesValue,
  );
  const rooms = Writable.of<SharedRoomsValue>(
    {} as SharedRoomsValue,
  );
  const adminRegistry = Writable.of<ChatAdminRegistryValue>(
    {} as ChatAdminRegistryValue,
  );
  const profileDraft = Writable.of("");
  const messageDraft = Writable.of("");
  const hostMessageDraft = Writable.of("");
  const roomDraft = Writable.of("");
  const chat = GroupChatDemo({
    myProfile,
    profiles,
    messages,
    rooms,
    adminRegistry,
    profileDraft,
    messageDraft,
    hostMessageDraft,
    roomDraft,
  } as GroupChatDemoInputArg);
  const bobProfile = Writable.of<MyProfileCellValue>(
    {} as Default<EmptyMyProfileValue>,
  );
  const bobProfileDraft = Writable.of("");
  const bobMessageDraft = Writable.of("");
  const bobHostMessageDraft = Writable.of("");
  const bobRoomDraft = Writable.of("");
  const bobChat = GroupChatDemo({
    myProfile: bobProfile,
    profiles,
    messages,
    rooms,
    adminRegistry,
    profileDraft: bobProfileDraft,
    messageDraft: bobMessageDraft,
    hostMessageDraft: bobHostMessageDraft,
    roomDraft: bobRoomDraft,
  } as GroupChatDemoInputArg);

  const action_set_profile_alice = action(() => {
    chat.setProfileDraft.send("Alice");
  });
  const action_set_profile_bob = action(() => {
    bobChat.setProfileDraft.send("Bob");
  });
  const action_set_room_ops = action(() => {
    chat.setRoomDraft.send("Ops");
  });
  const action_set_room_bob = action(() => {
    bobChat.setRoomDraft.send("Bob room");
  });
  const action_set_room_ops_again = action(() => {
    chat.setRoomDraft.send("Ops 2");
  });
  const action_set_message_alice = action(() => {
    chat.setMessageDraft.send("Hello from Alice");
  });
  const action_set_profile_rename = action(() => {
    chat.setProfileDraft.send("Alice Renamed");
  });
  const action_set_message_after_rename = action(() => {
    chat.setMessageDraft.send("After rename");
  });
  // Imported rows are appended via push: rewriting the whole list with
  // `messages.set([...])` re-writes the existing TRUSTED rows, which only the
  // reviewed send binding may author under CFC enforcement.
  const action_add_deterministic_imported = action(() => {
    const random = seededRandom(0xdecafbad);
    const nextMessages = createRandomImportedClaimedMessages(
      sortDisplayMessages(messages.get() as SharedChatMessage[]),
      participantClaimsValue(profiles, myProfile, messages),
      random,
    );
    nextMessages.forEach((message) =>
      messages.push(message as SharedChatMessage)
    );
  });
  const action_add_same_name_unverified_imports = action(() => {
    messages.push({
      origin: "imported",
      authorName: "Sam",
      body: "first Sam",
      timestamp: 10_000,
    });
    messages.push({
      origin: "imported",
      authorName: "Sam",
      body: "second Sam",
      timestamp: 10_001,
    });
  });

  const assert_initially_empty = assert(() =>
    (myProfile.get() as MyProfileValue | undefined)?.profile === undefined &&
    (messages.get()?.length ?? 0) === 0
  );
  const assert_admin_view_waits_for_profile = assert(() => {
    const managerChip = findNodeById(chat[UI], "group-chat-manager-chip");
    const panelStatus = findNodeById(
      chat[UI],
      "trusted-admin-manager-panel-status",
    );
    return propValue(managerChip, "label") === "No profile" &&
      propValue(panelStatus, "label") ===
        "Save a profile to manage admins";
  });
  const assert_profile_created = assert(() =>
    chat.currentProfileName === "Alice"
  );
  const assert_profile_bootstraps_admin = assert(() =>
    chat.currentUserIsAdmin === true &&
    chat.currentUserCanManageAdmins === true &&
    chatAdminRolesValue(adminRegistry).length === 0
  );
  const assert_alice_sees_bob_without_bob_message = assert(() => {
    const participants = participantClaimsValue(profiles, myProfile, messages);
    return participants.some((participant) => participant.name === "Alice") &&
      participants.some((participant) => participant.name === "Bob");
  });
  const assert_admin_view_everyone_enabled = assert(() => {
    const toggleButton = findNodeByProp(
      chat[UI],
      "data-ui-control",
      "admin-user-toggle",
    );
    const everyoneCheckbox = findNodeById(
      chat[UI],
      "trusted-everyone-admin-checkbox",
    );
    const managerChip = findNodeById(chat[UI], "group-chat-manager-chip");
    const panelStatus = findNodeById(
      chat[UI],
      "trusted-admin-manager-panel-status",
    );
    return propValue(managerChip, "label") === "Everyone is admin" &&
      propValue(panelStatus, "label") === "Everyone can add rooms" &&
      propValue(everyoneCheckbox, "checked") === true &&
      propValue(everyoneCheckbox, "disabled") === false &&
      propValue(toggleButton, "disabled") === true &&
      nodeIncludesText(toggleButton, "Admin via everyone");
  });
  const assert_bootstrap_admin_can_add_room = assert(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 1 &&
      roomList[0]?.name === "Ops" &&
      roomDraft.get() === "";
  });
  const assert_everyone_disabled_seeds_alice = assert(() =>
    chat.currentUserIsAdmin === true &&
    bobChat.currentUserIsAdmin !== true &&
    chatAdminRolesValue(adminRegistry).length === 1 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_admin_view_explicit_alice = assert(() => {
    const toggleButton = findNodeByProp(
      chat[UI],
      "data-ui-control",
      "admin-user-toggle",
    );
    return propValue(toggleButton, "disabled") === false &&
      nodeIncludesText(toggleButton, "Remove admin") &&
      nodeIncludesText(
        findNodeById(chat[UI], "trusted-admin-user-list"),
        "Admin",
      );
  });
  const assert_admin_view_lists_bob_after_lockdown = assert(() => {
    const userList = findNodeById(chat[UI], "trusted-admin-user-list");
    return nodeIncludesText(userList, "Bob") &&
      nodeIncludesText(userList, "Make admin");
  });
  const assert_last_admin_removal_blocked = assert(() =>
    chat.currentUserIsAdmin === true &&
    bobChat.currentUserIsAdmin !== true &&
    chatAdminRolesValue(adminRegistry).length === 1 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_bob_cannot_add_room_after_lockdown = assert(() =>
    roomsValue(rooms).length === 1
  );
  const assert_bob_admin_enabled = assert(() =>
    bobChat.currentUserIsAdmin === true &&
    bobChat.currentUserCanManageAdmins === true &&
    chatAdminRolesValue(adminRegistry).length === 2 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_bob_can_add_room = assert(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 2 &&
      roomList[1]?.name === "Bob room" &&
      bobRoomDraft.get() === "";
  });
  const assert_alice_can_still_add_room = assert(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 3 &&
      roomList[2]?.name === "Ops 2" &&
      roomDraft.get() === "";
  });
  const assert_message_sent_and_draft_cleared = assert(() =>
    messages.get().length === 1 &&
    messages.get()[0]?.origin === "sent" &&
    messages.get()[0]?.authorName === "Alice" &&
    messages.get()[0]?.body === "Hello from Alice" &&
    messageDraft.get() === ""
  );
  const assert_profile_renamed = assert(() =>
    chat.currentProfileName === "Alice Renamed"
  );
  const assert_message_snapshot_stable = assert(() =>
    messages.get().length >= 1 &&
    messages.get()[0]?.authorName === "Alice"
  );
  const assert_second_message_uses_current_name = assert(() =>
    messages.get().length === 2 &&
    messages.get()[1]?.origin === "sent" &&
    messages.get()[1]?.authorName === "Alice Renamed" &&
    messages.get()[1]?.body === "After rename"
  );
  const assert_imported_messages_injected = assert(() => {
    const messageList = Array.from(messages.get() as SharedChatMessage[]);
    const importedMessages = messageList.filter((message) =>
      message.origin === "imported"
    );
    return messageList.length === 4 &&
      importedMessages.length === 2 &&
      importedMessages.every((message) =>
        message.authorName.length > 0 &&
        message.body.length > 0 &&
        message.authorProfile !== undefined
      );
  });
  const assert_thread_order_sortable = assert(() => {
    const ordered = sortDisplayMessages(messages.get() as SharedChatMessage[]);
    return ordered.length === 4 &&
      ordered.every((message, index) =>
        index === 0 || ordered[index - 1]!.timestamp <= message.timestamp
      );
  });
  const assert_verified_imports_do_not_duplicate_participants = assert(() =>
    participantClaimsValue(profiles, myProfile, messages).filter((
      participant,
    ) => participant.name === "Alice Renamed").length === 1
  );
  const assert_same_name_unverified_imports_are_distinct = assert(() => {
    const participants = participantClaimsValue(profiles, myProfile, messages);
    return participants.filter((participant) =>
      participant.name === "Sam" && participant.profile === undefined
    ).length === 2;
  });
  const assert_messages_and_rooms_do_not_store_ids = assert(() =>
    (messages.get() as SharedChatMessage[]).every((message) =>
      !("id" in message)
    ) &&
    roomsValue(rooms).every((room) => !("id" in room))
  );

  return {
    tests: [
      { assertion: assert_initially_empty },
      { assertion: assert_admin_view_waits_for_profile },
      { action: action_set_profile_alice },
      { action: chat.saveProfile, trustedUi: profileGesture },
      { assertion: assert_profile_created },
      { assertion: assert_profile_bootstraps_admin },
      { action: action_set_profile_bob },
      { action: bobChat.saveProfile, trustedUi: profileGesture },
      { assertion: assert_alice_sees_bob_without_bob_message },
      { assertion: assert_admin_view_everyone_enabled },
      { action: action_set_room_ops },
      { action: chat.addTrustedRoom, trustedUi: roomGesture },
      { assertion: assert_bootstrap_admin_can_add_room },
      {
        action: chat.toggleEveryoneAdmin,
        event: { type: "click", target: { name: "", value: "on" } },
        trustedUi: adminGesture,
      },
      { assertion: assert_everyone_disabled_seeds_alice },
      { assertion: assert_admin_view_explicit_alice },
      { assertion: assert_admin_view_lists_bob_after_lockdown },
      // Skipped under single-runtime wiring (see the grant-Bob block below):
      // the self-match (`equals(role.subject, targetProfile)`) that classifies
      // this as a blocked removal misses when registry and profiles share one
      // doc, so the handler attempts an admins write that CFC rejects. The
      // piece-shaped removal flow is covered by the integration suites.
      {
        action: chat.toggleParticipantAdmin,
        event: { name: "Alice" },
        trustedUi: adminGesture,
        skip: true,
      },
      { assertion: assert_last_admin_removal_blocked },
      { action: action_set_room_bob },
      { action: bobChat.addTrustedRoom, trustedUi: roomGesture },
      { assertion: assert_bob_cannot_add_room_after_lockdown },
      // Granting Bob admin writes the RequiresIntegrity admins list. The CFC
      // requiredIntegrity over-rejection that used to block this (audit S7 —
      // the grant's provenance-only participant-row reads quantified into the
      // gate) is now FIXED (see cfc-required-integrity-provenance.test.ts), so
      // the grant transaction commits. The steps stay skipped only for the same
      // single-doc subject-matching limitation as the removal block above (the
      // self-match misses when registry and profiles share one doc, so the
      // post-grant admin lookups don't reflect the grant); the piece-shaped
      // wiring is covered under enforcement by
      // integration/cfc-group-chat-demo-multi-runtime.test.ts.
      {
        action: chat.toggleParticipantAdmin,
        event: { name: "Bob" },
        trustedUi: adminGesture,
        skip: true,
      },
      { assertion: assert_bob_admin_enabled, skip: true },
      { action: bobChat.addTrustedRoom, trustedUi: roomGesture, skip: true },
      { assertion: assert_bob_can_add_room, skip: true },
      { action: action_set_room_ops_again, skip: true },
      { action: chat.addTrustedRoom, trustedUi: roomGesture, skip: true },
      { assertion: assert_alice_can_still_add_room, skip: true },
      { action: action_set_message_alice },
      { action: chat.sendTrustedMessage, trustedUi: sendGesture },
      { assertion: assert_message_sent_and_draft_cleared },
      { action: action_set_profile_rename },
      { action: chat.saveProfile, trustedUi: profileGesture },
      { assertion: assert_profile_renamed },
      { assertion: assert_message_snapshot_stable },
      { action: action_set_message_after_rename },
      { action: chat.sendTrustedMessage, trustedUi: sendGesture },
      { assertion: assert_second_message_uses_current_name },
      { action: action_add_deterministic_imported },
      { assertion: assert_imported_messages_injected },
      { assertion: assert_thread_order_sortable },
      { assertion: assert_verified_imports_do_not_duplicate_participants },
      { action: action_add_same_name_unverified_imports },
      { assertion: assert_same_name_unverified_imports_are_distinct },
      { assertion: assert_messages_and_rooms_do_not_store_ids },
    ],
    // TODO(cfc-schema-ref): the CFC schema-ref resolver warns about
    // unsupported/unresolved $ref(s) in this pattern's schemas (logger "cfc",
    // fail-closed). Fix the schema(s), then drop this opt-out.
    allowConsoleWarnings: true,
  };
});
