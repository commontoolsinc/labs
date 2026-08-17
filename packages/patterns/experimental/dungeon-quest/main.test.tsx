import { action, assert, pattern, TESTS, UI } from "commonfabric";

import { findNodeByProp, hasText, propsOf } from "../../test/vnode-helpers.ts";
import Adventure from "./main.tsx";

export default pattern(() => {
  const adventure = Adventure({});

  const action_try_door_too_early = action(() => {
    adventure.attemptAdventureAction.send({ action: "open-sealed-door" });
  });

  const action_create_party = action(() => {
    adventure.createCharacter.send({ name: "Alara", archetype: "Ranger" });
    adventure.createCharacter.send({ name: "Bram", archetype: "Guardian" });
  });

  const action_try_assembly_without_enlisting = action(() => {
    adventure.attemptAdventureAction.send({ action: "assemble-party" });
  });

  const action_enlist_party = action(() => {
    const alara = adventure.characters?.[0];
    const bram = adventure.characters?.[1];
    if (alara) adventure.enlistCharacter.send({ character: alara });
    if (bram) adventure.enlistCharacter.send({ character: bram });
  });

  const action_assemble_from_ui = action(() => {
    const button = findNodeByProp(
      adventure[UI],
      "aria-label",
      "Attempt assemble party",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_repeat_assembly = action(() => {
    adventure.attemptAdventureAction.send({ action: "assemble-party" });
  });

  const action_try_door_from_wrong_room = action(() => {
    adventure.attemptAdventureAction.send({ action: "open-sealed-door" });
  });

  const action_move_alara_to_hall = action(() => {
    adventure.characters?.[0]?.moveTo.send({ location: "Moonlit Hall" });
  });

  const action_open_door_from_ui = action(() => {
    const button = findNodeByProp(
      adventure[UI],
      "aria-label",
      "Attempt open sealed door",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_move_party_to_gatehouse = action(() => {
    adventure.characters?.[0]?.moveTo.send({ location: "Gatehouse" });
    adventure.characters?.[1]?.moveTo.send({ location: "Gatehouse" });
  });

  const action_defeat_sentinel_from_ui = action(() => {
    const button = findNodeByProp(
      adventure[UI],
      "aria-label",
      "Attempt defeat sentinel",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_move_party_to_sunken_gate = action(() => {
    adventure.characters?.[0]?.moveTo.send({ location: "Sunken Gate" });
    adventure.characters?.[1]?.moveTo.send({ location: "Sunken Gate" });
  });

  const action_open_gate_from_ui = action(() => {
    const button = findNodeByProp(
      adventure[UI],
      "aria-label",
      "Attempt open Sunken Gate",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_restart_from_ui = action(() => {
    const button = findNodeByProp(
      adventure[UI],
      "aria-label",
      "Restart expedition",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_create_character_from_form = action(() => {
    const nameInput = findNodeByProp(
      adventure[UI],
      "aria-label",
      "Character name",
    );
    const nameCell = propsOf(nameInput)?.["$value"];
    if (
      typeof nameCell === "object" && nameCell !== null && "set" in nameCell
    ) {
      (nameCell as { set: (value: string) => void }).set("Nyx");
    }
    const archetypeInput = findNodeByProp(
      adventure[UI],
      "aria-label",
      "Character archetype",
    );
    const archetypeCell = propsOf(archetypeInput)?.["$value"];
    if (
      typeof archetypeCell === "object" && archetypeCell !== null &&
      "set" in archetypeCell
    ) {
      (archetypeCell as { set: (value: string) => void }).set("Mystic");
    }
    const createButton = findNodeByProp(
      adventure[UI],
      "aria-label",
      "Create named adventurer",
    );
    const onClick = propsOf(createButton)?.onClick;
    if (
      typeof onClick === "object" && onClick !== null &&
      "send" in onClick
    ) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_create_default_character = action(() => {
    adventure.createCharacter.send({ name: " ", archetype: " " });
  });

  const assert_initial_model = assert(() =>
    (adventure.characters ?? []).length === 0 &&
    adventure.quest.status === "available" &&
    adventure.quest.progress?.[0]?.status === "active" &&
    adventure.quest.progress?.[1]?.status === "locked" &&
    adventure.quest.completedObjectiveCount === 0
  );

  const assert_initial_ui = assert(() =>
    hasText(adventure[UI], "The Sunken Gate") &&
    hasText(adventure[UI], "Adventure") &&
    hasText(adventure[UI], "Party & characters") &&
    hasText(adventure[UI], "Recruit an adventurer") &&
    hasText(adventure[UI], "Expedition controls")
  );

  const assert_early_actions_rejected = assert(() =>
    (adventure.quest.evidence ?? []).length === 0 &&
    adventure.quest.completedObjectiveCount === 0
  );

  const assert_party_created = assert(() =>
    (adventure.characters ?? []).length === 2 &&
    adventure.characters?.[0]?.name === "Alara" &&
    adventure.characters?.[1]?.name === "Bram" &&
    adventure.characters?.[1]?.archetype === "Guardian"
  );

  const assert_party_enlisted = assert(() =>
    adventure.quest.status === "active" &&
    (adventure.quest.participants ?? []).length === 2
  );

  const assert_party_objective_completed = assert(() =>
    adventure.quest.progress?.[0]?.status === "completed" &&
    adventure.quest.progress?.[1]?.status === "active" &&
    adventure.quest.completedObjectiveCount === 1 &&
    adventure.quest.evidence?.length === 1 &&
    adventure.quest.evidence?.[0]?.actors?.length === 2
  );

  const assert_duplicate_and_wrong_room_rejected = assert(() =>
    adventure.quest.completedObjectiveCount === 1 &&
    adventure.quest.evidence?.length === 1
  );

  const assert_door_opened = assert(() =>
    adventure.quest.progress?.[1]?.status === "completed" &&
    adventure.quest.progress?.[2]?.status === "active" &&
    adventure.quest.completedObjectiveCount === 2 &&
    adventure.quest.evidence?.[1]?.actors?.length === 1
  );

  const assert_sentinel_defeated = assert(() =>
    adventure.quest.progress?.[2]?.status === "completed" &&
    adventure.quest.progress?.[3]?.status === "active" &&
    adventure.quest.completedObjectiveCount === 3
  );

  const assert_quest_completed = assert(() =>
    adventure.quest.status === "completed" &&
    adventure.quest.completedObjectiveCount === 4 &&
    adventure.quest.evidence?.length === 4
  );

  const assert_quest_restarted = assert(() =>
    adventure.quest.status === "available" &&
    adventure.quest.completedObjectiveCount === 0 &&
    adventure.quest.evidence?.length === 0 &&
    adventure.quest.participants?.length === 0 &&
    adventure.characters?.length === 2
  );

  const assert_form_character_created = assert(() =>
    adventure.characters?.[2]?.name === "Nyx" &&
    adventure.characters?.[2]?.archetype === "Mystic"
  );

  const assert_default_character_created = assert(() =>
    adventure.characters?.[3]?.name === "Unnamed adventurer" &&
    adventure.characters?.[3]?.archetype === "Adventurer"
  );

  return {
    [TESTS]: [
      { render: adventure[UI] },
      { assertion: assert_initial_model },
      { assertion: assert_initial_ui },
      { action: action_try_door_too_early },
      { assertion: assert_early_actions_rejected },
      { action: action_create_party },
      { assertion: assert_party_created },
      { action: action_try_assembly_without_enlisting },
      { assertion: assert_early_actions_rejected },
      { action: action_enlist_party },
      { assertion: assert_party_enlisted },
      { action: action_assemble_from_ui },
      { assertion: assert_party_objective_completed },
      { action: action_repeat_assembly },
      { action: action_try_door_from_wrong_room },
      { assertion: assert_duplicate_and_wrong_room_rejected },
      { action: action_move_alara_to_hall },
      { action: action_open_door_from_ui },
      { assertion: assert_door_opened },
      { action: action_move_party_to_gatehouse },
      { action: action_defeat_sentinel_from_ui },
      { assertion: assert_sentinel_defeated },
      { action: action_move_party_to_sunken_gate },
      { action: action_open_gate_from_ui },
      { assertion: assert_quest_completed },
      { action: action_restart_from_ui },
      { assertion: assert_quest_restarted },
      { action: action_create_character_from_form },
      { assertion: assert_form_character_created },
      { action: action_create_default_character },
      { assertion: assert_default_character_created },
      { render: adventure[UI] },
    ],
    subject: adventure,
  };
});
