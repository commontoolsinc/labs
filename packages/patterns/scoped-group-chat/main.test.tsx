import { action, computed, pattern, Writable } from "commonfabric";
import ScopedGroupChat, {
  type Conversation,
  type SelectedRoom,
} from "./main-with-writable-inputs.tsx";

export default pattern(() => {
  const selectedRoom = Writable.of<SelectedRoom>({});
  const conversation = Writable.of<Conversation>({
    rooms: [],
  });
  const draft = Writable.of("Hello Library");
  const chat = ScopedGroupChat({
    name: Writable.of(""),
    selectedRoom,
    conversation,
    draft,
    newRoomName: Writable.of(""),
  });

  const action_add_new_room = action(() => {
    chat.addRoom.send({ name: "Garden" });
  });

  const action_add_second_room = action(() => {
    chat.addRoom.send({ name: "Library" });
  });

  const action_select_first_room = action(() => {
    chat.selectRoom.send({
      room: conversation.key("rooms", 0),
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
      { action: action_select_first_room },
      { assertion: assert_selected_room_reference_changed },
    ],
    chat,
  };
});
