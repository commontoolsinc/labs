import { action, computed, pattern } from "commonfabric";
import ScopedGroupChat from "./main.tsx";

export default pattern(() => {
  const chat = ScopedGroupChat({});

  const action_set_name = action(() => {
    chat.setName.send({ name: "Ada" });
  });

  const action_write_lobby_draft = action(() => {
    chat.setDraft.send({ draft: "Hello from the lobby" });
  });

  const action_send_first_message = action(() => {
    chat.sendMessage.send({ submit: true });
  });

  const action_switch_to_workshop = action(() => {
    chat.selectRoom.send({ room: "workshop" });
  });

  const action_write_workshop_draft = action(() => {
    chat.setDraft.send({ draft: "Workshop notes stay in this room" });
  });

  const action_send_workshop_message = action(() => {
    chat.sendMessage.send({ submit: true });
  });

  const assert_initial_scoped_fields = computed(() =>
    chat.lobbyCount === 0 &&
    chat.workshopCount === 0 &&
    chat.afterpartyCount === 0
  );

  const assert_first_message_sent_and_draft_cleared = computed(() =>
    chat.lobbyCount === 1 &&
    chat.lastLobbyAuthor === "Ada" &&
    chat.lastLobbyBody === "Hello from the lobby" &&
    chat.currentDraft === ""
  );

  const assert_room_switch_is_session_local = computed(() =>
    chat.lobbyCount === 1 &&
    chat.workshopCount === 1 &&
    chat.lastWorkshopBody ===
      "Workshop notes stay in this room" &&
    chat.afterpartyCount === 0
  );

  return {
    tests: [
      { assertion: assert_initial_scoped_fields },
      { action: action_set_name },
      { action: action_write_lobby_draft },
      { action: action_send_first_message },
      { assertion: assert_first_message_sent_and_draft_cleared },
      { action: action_switch_to_workshop },
      { action: action_write_workshop_draft },
      { action: action_send_workshop_message },
      { assertion: assert_room_switch_is_session_local },
    ],
    chat,
  };
});
