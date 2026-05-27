import { action, computed, Default, pattern, UI, Writable } from "commonfabric";
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
  TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
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
  const adminDraft = Writable.of(true);
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
    adminDraft,
    messageDraft,
    hostMessageDraft,
    roomDraft,
  } as GroupChatDemoInputArg);
  const bobProfile = Writable.of<MyProfileCellValue>(
    {} as Default<EmptyMyProfileValue>,
  );
  const bobProfileDraft = Writable.of("");
  const bobAdminDraft = Writable.of(true);
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
    adminDraft: bobAdminDraft,
    messageDraft: bobMessageDraft,
    hostMessageDraft: bobHostMessageDraft,
    roomDraft: bobRoomDraft,
  } as GroupChatDemoInputArg);

  const action_set_profile_alice = action(() => {
    chat.setProfileDraft.send("Alice");
  });
  const action_save_profile = action(() => {
    chat.saveProfile.send();
  });
  const action_set_profile_bob = action(() => {
    bobChat.setProfileDraft.send("Bob");
  });
  const action_save_profile_bob = action(() => {
    bobChat.saveProfile.send();
  });
  const action_set_room_ops = action(() => {
    chat.setRoomDraft.send("Ops");
  });
  const action_try_add_room_without_admin = action(() => {
    chat.addTrustedRoom.send();
  });
  const action_enable_admin_draft = action(() => {
    chat.setAdminDraft.send(true);
  });
  const action_toggle_alice_admin = action(() => {
    chat.toggleCurrentUserAdmin.send();
  });
  const action_add_room = action(() => {
    chat.addTrustedRoom.send();
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
  const action_add_deterministic_imported = action(() => {
    const random = seededRandom(0xdecafbad);
    const nextMessages = createRandomImportedClaimedMessages(
      sortDisplayMessages(messages.get() as SharedChatMessage[]),
      participantClaimsValue(profiles, myProfile, messages),
      random,
    );
    messages.set([
      ...(messages.get() as SharedChatMessage[]),
      ...nextMessages,
    ]);
  });
  const action_add_same_name_unverified_imports = action(() => {
    messages.set([
      ...(messages.get() as SharedChatMessage[]),
      {
        origin: "imported",
        authorName: "Sam",
        body: "first Sam",
        timestamp: 10_000,
      },
      {
        origin: "imported",
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
  const assert_admin_view_initially_locked = computed(() => {
    const managerChip = findNodeById(chat[UI], "group-chat-manager-chip");
    const panelStatus = findNodeById(
      chat[UI],
      "trusted-admin-manager-panel-status",
    );
    return propValue(managerChip, "label") === "Manager off" &&
      propValue(panelStatus, "label") ===
        "Save profile with admin-manager enabled to edit";
  });
  const assert_profile_created = computed(() =>
    chat.currentProfileName === "Alice"
  );
  const assert_profile_starts_non_admin = computed(() =>
    chat.currentUserIsAdmin !== true
  );
  const assert_profile_can_manage_admins = computed(() =>
    chat.currentUserCanManageAdmins === true
  );
  const assert_alice_sees_bob_without_bob_message = computed(() => {
    const participants = participantClaimsValue(profiles, myProfile, messages);
    return participants.some((participant) => participant.name === "Alice") &&
      participants.some((participant) => participant.name === "Bob");
  });
  const assert_admin_view_manager_enabled = computed(() => {
    const toggleButton = findNodeByProp(
      chat[UI],
      "data-ui-action",
      TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
    );
    const managerChip = findNodeById(chat[UI], "group-chat-manager-chip");
    const panelStatus = findNodeById(
      chat[UI],
      "trusted-admin-manager-panel-status",
    );
    return propValue(managerChip, "label") === "Can manage admins" &&
      propValue(panelStatus, "label") === "Admin registry editing enabled" &&
      propValue(toggleButton, "disabled") === false &&
      nodeIncludesText(toggleButton, "Make admin");
  });
  const assert_non_admin_cannot_add_room = computed(() =>
    roomsValue(rooms).length === 0
  );
  const assert_admin_enabled = computed(() =>
    chat.currentUserIsAdmin === true &&
    chatAdminRolesValue(adminRegistry).length === 1
  );
  const assert_admin_view_current_user_admin = computed(() => {
    const toggleButton = findNodeByProp(
      chat[UI],
      "data-ui-action",
      TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
    );
    return propValue(toggleButton, "disabled") === false &&
      nodeIncludesText(toggleButton, "Remove admin") &&
      nodeIncludesText(
        findNodeById(chat[UI], "trusted-admin-user-list"),
        "Admin",
      );
  });
  const assert_admin_can_add_room = computed(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 1 &&
      roomList[0]?.name === "Ops" &&
      roomDraft.get() === "";
  });
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
        message.authorProfile !== undefined
      );
  });
  const assert_thread_order_sortable = computed(() => {
    const ordered = sortDisplayMessages(messages.get() as SharedChatMessage[]);
    return ordered.length === 4 &&
      ordered.every((message, index) =>
        index === 0 || ordered[index - 1]!.timestamp <= message.timestamp
      );
  });
  const assert_verified_imports_do_not_duplicate_participants = computed(() =>
    participantClaimsValue(profiles, myProfile, messages).filter((
      participant,
    ) => participant.name === "Alice Renamed").length === 1
  );
  const assert_same_name_unverified_imports_are_distinct = computed(() => {
    const participants = participantClaimsValue(profiles, myProfile, messages);
    return participants.filter((participant) =>
      participant.name === "Sam" && participant.profile === undefined
    ).length === 2;
  });
  const assert_messages_and_rooms_do_not_store_ids = computed(() =>
    (messages.get() as SharedChatMessage[]).every((message) =>
      !("id" in message)
    ) &&
    roomsValue(rooms).every((room) => !("id" in room))
  );

  return {
    tests: [
      { assertion: assert_initially_empty },
      { assertion: assert_admin_view_initially_locked },
      { action: action_set_profile_alice },
      { action: action_save_profile },
      { assertion: assert_profile_created },
      { assertion: assert_profile_starts_non_admin },
      { assertion: assert_profile_can_manage_admins },
      { action: action_set_profile_bob },
      { action: action_save_profile_bob },
      { assertion: assert_alice_sees_bob_without_bob_message },
      { assertion: assert_admin_view_manager_enabled },
      { action: action_set_room_ops },
      { action: action_try_add_room_without_admin },
      { assertion: assert_non_admin_cannot_add_room },
      { action: action_enable_admin_draft },
      { action: action_save_profile },
      { assertion: assert_profile_can_manage_admins },
      { action: action_toggle_alice_admin },
      { assertion: assert_admin_enabled },
      { assertion: assert_admin_view_current_user_admin },
      { action: action_add_room },
      { assertion: assert_admin_can_add_room },
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
      { action: action_add_deterministic_imported },
      { assertion: assert_imported_messages_injected },
      { assertion: assert_thread_order_sortable },
      { assertion: assert_verified_imports_do_not_duplicate_participants },
      { action: action_add_same_name_unverified_imports },
      { assertion: assert_same_name_unverified_imports_are_distinct },
      { assertion: assert_messages_and_rooms_do_not_store_ids },
    ],
  };
});
