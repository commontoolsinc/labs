import { action, computed, Default, pattern, UI, Writable } from "commonfabric";
import {
  findNodeById,
  findNodeByProp,
  nodeIncludesText,
  propValue,
} from "../test-ui-helpers.ts";
import { sortDisplayMessages } from "./logic.ts";
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
  const action_set_room_bob = action(() => {
    bobChat.setRoomDraft.send("Bob room");
  });
  const action_add_room = action(() => {
    chat.addTrustedRoom.send();
  });
  const action_bob_try_add_room = action(() => {
    bobChat.addTrustedRoom.send();
  });
  const action_disable_everyone_admin = action(() => {
    chat.toggleEveryoneAdmin.send({
      type: "click",
      target: { name: "", value: "on" },
    });
  });
  const action_toggle_bob_admin = action(() => {
    chat.toggleParticipantAdmin.send({ name: "Bob" });
  });
  const action_try_remove_last_admin = action(() => {
    chat.toggleCurrentUserAdmin.send({});
  });
  const action_bob_add_room = action(() => {
    bobChat.addTrustedRoom.send();
  });
  const action_set_room_ops_again = action(() => {
    chat.setRoomDraft.send("Ops 2");
  });
  const action_alice_add_second_room = action(() => {
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
  const action_add_random_imported = action(() => {
    chat.addRandomMessages.send();
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
  const assert_admin_view_waits_for_profile = computed(() => {
    const managerChip = findNodeById(chat[UI], "group-chat-manager-chip");
    const panelStatus = findNodeById(
      chat[UI],
      "trusted-admin-manager-panel-status",
    );
    return propValue(managerChip, "label") === "No profile" &&
      propValue(panelStatus, "label") ===
        "Save a profile to manage admins";
  });
  const assert_profile_created = computed(() =>
    chat.currentProfileName === "Alice"
  );
  const assert_profile_bootstraps_admin = computed(() =>
    chat.currentUserIsAdmin === true &&
    chat.currentUserCanManageAdmins === true &&
    chatAdminRolesValue(adminRegistry).length === 0
  );
  const assert_alice_sees_bob_without_bob_message = computed(() => {
    const participants = participantClaimsValue(profiles, myProfile, messages);
    return participants.some((participant) => participant.name === "Alice") &&
      participants.some((participant) => participant.name === "Bob");
  });
  const assert_admin_view_everyone_enabled = computed(() => {
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
  const assert_bootstrap_admin_can_add_room = computed(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 1 &&
      roomList[0]?.name === "Ops" &&
      roomDraft.get() === "";
  });
  const assert_everyone_disabled_seeds_alice = computed(() =>
    chat.currentUserIsAdmin === true &&
    bobChat.currentUserIsAdmin !== true &&
    chatAdminRolesValue(adminRegistry).length === 1 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_admin_view_explicit_alice = computed(() => {
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
  const assert_admin_view_lists_bob_after_lockdown = computed(() => {
    const userList = findNodeById(chat[UI], "trusted-admin-user-list");
    return nodeIncludesText(userList, "Bob") &&
      nodeIncludesText(userList, "Make admin");
  });
  const assert_last_admin_removal_blocked = computed(() =>
    chat.currentUserIsAdmin === true &&
    bobChat.currentUserIsAdmin !== true &&
    chatAdminRolesValue(adminRegistry).length === 1 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_bob_cannot_add_room_after_lockdown = computed(() =>
    roomsValue(rooms).length === 1
  );
  const assert_bob_admin_enabled = computed(() =>
    bobChat.currentUserIsAdmin === true &&
    bobChat.currentUserCanManageAdmins === true &&
    chatAdminRolesValue(adminRegistry).length === 2 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_bob_can_add_room = computed(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 2 &&
      roomList[1]?.name === "Bob room" &&
      bobRoomDraft.get() === "";
  });
  const assert_alice_can_still_add_room = computed(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 3 &&
      roomList[2]?.name === "Ops 2" &&
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
      { assertion: assert_admin_view_waits_for_profile },
      { action: action_set_profile_alice },
      { action: action_save_profile },
      { assertion: assert_profile_created },
      { assertion: assert_profile_bootstraps_admin },
      { action: action_set_profile_bob },
      { action: action_save_profile_bob },
      { assertion: assert_alice_sees_bob_without_bob_message },
      { assertion: assert_admin_view_everyone_enabled },
      { action: action_set_room_ops },
      { action: action_add_room },
      { assertion: assert_bootstrap_admin_can_add_room },
      { action: action_disable_everyone_admin },
      { assertion: assert_everyone_disabled_seeds_alice },
      { assertion: assert_admin_view_explicit_alice },
      { assertion: assert_admin_view_lists_bob_after_lockdown },
      { action: action_try_remove_last_admin },
      { assertion: assert_last_admin_removal_blocked },
      { action: action_set_room_bob },
      { action: action_bob_try_add_room },
      { assertion: assert_bob_cannot_add_room_after_lockdown },
      { action: action_toggle_bob_admin },
      { assertion: assert_bob_admin_enabled },
      { action: action_bob_add_room },
      { assertion: assert_bob_can_add_room },
      { action: action_set_room_ops_again },
      { action: action_alice_add_second_room },
      { assertion: assert_alice_can_still_add_room },
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
      { assertion: assert_verified_imports_do_not_duplicate_participants },
      { action: action_add_same_name_unverified_imports },
      { assertion: assert_same_name_unverified_imports_are_distinct },
      { assertion: assert_messages_and_rooms_do_not_store_ids },
    ],
  };
});
