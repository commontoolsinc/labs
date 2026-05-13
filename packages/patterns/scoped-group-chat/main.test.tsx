import { action, computed, pattern } from "commonfabric";
import ScopedGroupChat from "./main-plain-inputs.tsx";

export default pattern(() => {
  const chat = ScopedGroupChat({
    name: "",
    selectedRoom: {},
    conversation: { rooms: [] },
    draft: "Hello Library",
    newRoomName: "",
  });

  const action_add_new_room = action(() => {
    chat.addRoom.send({ name: "Garden" });
  });

  const action_add_second_room = action(() => {
    chat.addRoom.send({ name: "Library" });
  });

  const action_send_message = action(() => {
    chat.sendMessage.send({});
  });

  const action_select_first_room = action(() => {
    chat.selectRoom.send({
      room: chat.conversation.rooms[0],
    });
  });

  const assert_initial_scoped_fields = computed(() => chat.roomCount === 0);

  const assert_added_room_is_selected = computed(() =>
    chat.roomCount === 1 &&
    chat.selectedRoom.room?.name === "Garden" &&
    chat.messageCount === 0
  );

  const assert_second_room_is_selected = computed(() =>
    chat.roomCount === 2 &&
    chat.selectedRoom.room?.name === "Library" &&
    chat.messageCount === 0
  );

  const assert_message_was_sent = computed(() =>
    chat.conversation.rooms[0]?.messages?.length === 0 &&
    chat.conversation.rooms[1]?.messages?.length === 1 &&
    chat.conversation.rooms[1]?.messages?.[0]?.body ===
      "Hello Library" &&
    chat.messageCount === 1 &&
    chat.selectedRoom.room?.messages?.[0]?.body === "Hello Library"
  );

  const assert_room_counts_do_not_follow_selection = computed(() =>
    chat.messageCount === 0 &&
    chat.conversation.rooms[0]?.messages?.length === 0 &&
    chat.conversation.rooms[1]?.messages?.length === 1
  );

  const assert_selected_room_reference_changed = computed(() =>
    chat.selectedRoom.room?.name === "Garden"
  );

  return {
    tests: [
      { assertion: assert_initial_scoped_fields },
      { action: action_add_new_room },
      { assertion: assert_added_room_is_selected },
      { action: action_add_second_room },
      { assertion: assert_second_room_is_selected },
      { action: action_send_message },
      { assertion: assert_message_was_sent },
      { action: action_select_first_room },
      { assertion: assert_room_counts_do_not_follow_selection },
      { assertion: assert_selected_room_reference_changed },
    ],
    chat,
  };
});
