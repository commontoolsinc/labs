import { action, computed, pattern, Writable } from "commonfabric";
import ScopedGroupChat from "./main.tsx";

export default pattern(() => {
  const chat = ScopedGroupChat({
    name: Writable.of(""),
    selectedRoom: Writable.of({}),
    conversation: Writable.of({
      rooms: [],
    }),
    draft: Writable.of(""),
    newRoomName: Writable.of(""),
  });

  const action_add_new_room = action(() => {
    chat.addRoom.send({ name: "Garden" });
  });

  const action_add_second_room = action(() => {
    chat.addRoom.send({ name: "Library" });
  });

  const action_send_message = action(() => {
    chat.sendMessage.send({
      message: "Hello Library",
    });
  });

  const assert_initial_scoped_fields = computed(() =>
    chat.roomCount === 0 &&
    chat.lastRoomName === ""
  );

  const assert_added_room_is_selected = computed(() =>
    chat.roomCount === 1 &&
    chat.lastRoomName === "Garden" &&
    chat.lastRoomMessageCount === 0
  );

  const assert_second_room_is_selected = computed(() =>
    chat.roomCount === 2 &&
    chat.lastRoomName === "Library" &&
    chat.lastRoomMessageCount === 0
  );

  const assert_message_was_sent = computed(() =>
    chat.conversationSnapshot.rooms[0]?.messages?.length === 0 &&
    chat.conversationSnapshot.rooms[1]?.messages?.length === 1 &&
    chat.conversationSnapshot.rooms[1]?.messages?.[0]?.body ===
      "Hello Library" &&
    chat.messageCount === 1 &&
    chat.lastCurrentRoomBody === "Hello Library" &&
    chat.roomSummaryText === "Garden: 0\nLibrary: 1"
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
    ],
    chat,
  };
});
