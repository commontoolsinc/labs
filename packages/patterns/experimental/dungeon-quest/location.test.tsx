import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";

import { findNodeByProp, hasText, propsOf } from "../../test/vnode-helpers.ts";
import Character from "./character.tsx";
import Location from "./location.tsx";
import type {
  CharacterPiece,
  QuestCharacter,
  QuestEvidence,
} from "./schemas.tsx";

export default pattern(() => {
  const alara = Character({ name: "Alara", archetype: "Ranger" });
  const bram = Character({ name: "Bram", archetype: "Guardian" });
  const characters = new Writable<CharacterPiece[]>([]);
  const participants = new Writable<QuestCharacter[]>([]);
  const evidence = new Writable<QuestEvidence[]>([]);
  const antechamber = Location({
    locationKey: "antechamber",
    characters,
    questParticipants: participants,
    questEvidence: evidence,
  });
  const moonlitHall = Location({
    locationKey: "moonlit-hall",
    characters,
    questParticipants: participants,
    questEvidence: evidence,
  });

  const action_arrive_in_antechamber = action(() => {
    characters.push(alara);
    characters.push(bram);
  });

  const action_form_expedition_from_ui = action(() => {
    const button = findNodeByProp(
      antechamber[UI],
      "aria-label",
      "Perform assemble-party in Antechamber",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_move_alara_to_hall = action(() => {
    alara.moveTo.send({ location: "Moonlit Hall" });
  });

  const action_open_door = action(() => moonlitHall.performAction.send());

  const assert_initially_empty = assert(() =>
    antechamber.occupantCount === 0 &&
    moonlitHall.occupantCount === 0 &&
    hasText(antechamber[UI], "Present in this room")
  );

  const assert_live_initial_presence = assert(() =>
    antechamber.occupantCount === 2 &&
    antechamber.occupants?.[0]?.name === "Alara" &&
    antechamber.occupants?.[1]?.name === "Bram" &&
    moonlitHall.occupantCount === 0 &&
    antechamber.objectiveStatus === "active" &&
    hasText(antechamber[UI], "Present in this room") &&
    hasText(antechamber[UI], "Alara") &&
    hasText(antechamber[UI], "Form an expedition")
  );

  const assert_expedition_formed = assert(() =>
    participants.get().length === 2 &&
    evidence.get().length === 1 &&
    evidence.get()[0]?.kind === "party.assembled" &&
    antechamber.objectiveStatus === "completed" &&
    moonlitHall.objectiveStatus === "active"
  );

  const assert_presence_follows_character = assert(() =>
    antechamber.occupantCount === 1 &&
    antechamber.occupants?.[0]?.name === "Bram" &&
    moonlitHall.occupantCount === 1 &&
    moonlitHall.occupants?.[0]?.name === "Alara" &&
    hasText(moonlitHall[UI], "Alara")
  );

  const assert_door_opened_in_room = assert(() =>
    evidence.get().length === 2 &&
    evidence.get()[1]?.kind === "door.opened" &&
    moonlitHall.objectiveStatus === "completed"
  );

  return {
    [TESTS]: [
      { render: antechamber[UI] },
      { assertion: assert_initially_empty },
      { action: action_arrive_in_antechamber },
      { assertion: assert_live_initial_presence },
      { action: action_form_expedition_from_ui },
      { assertion: assert_expedition_formed },
      { action: action_move_alara_to_hall },
      { render: moonlitHall[UI] },
      { assertion: assert_presence_follows_character },
      { action: action_open_door },
      { assertion: assert_door_opened_in_room },
    ],
    subject: antechamber,
  };
});
