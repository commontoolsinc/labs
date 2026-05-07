import { action, computed, pattern, Writable } from "commonfabric";
import ScopedGroupChat from "./main.tsx";

export default pattern(() => {
  const chat = ScopedGroupChat({
    name: Writable.of(""),
    selectedRoom: Writable.of({}),
    conversation: Writable.of({
      rooms: [
        { name: "Lobby", messages: [] },
        { name: "Workshop", messages: [] },
        { name: "Afterparty", messages: [] },
      ],
    }),
    draft: Writable.of(""),
    newRoomName: Writable.of(""),
  });

  const action_write_new_room_name = action(() => {
    chat.setNewRoomName.send({ name: "Garden" });
  });

  const action_add_new_room = action(() => {
    chat.addRoom.send({ submit: true });
  });

  const assert_initial_scoped_fields = computed(() =>
    chat.roomCount === 3 &&
    chat.lastRoomName === "Afterparty"
  );

  const assert_added_room_is_selected = computed(() =>
    chat.roomCount === 4 &&
    chat.lastRoomName === "Garden" &&
    chat.lastRoomMessageCount === 0
  );

  return {
    tests: [
      { assertion: assert_initial_scoped_fields },
      { action: action_write_new_room_name },
      { action: action_add_new_room },
      { assertion: assert_added_room_is_selected },
    ],
    chat,
  };
});
