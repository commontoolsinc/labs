import { action, assert, pattern, TESTS, UI } from "commonfabric";

import {
  findElementByText,
  hasText,
  propsOf,
} from "../../test/vnode-helpers.ts";
import Adventure from "./main.tsx";

export default pattern(() => {
  const adventure = Adventure({});

  const action_create_party = action(() => {
    adventure.createCharacter.send({ name: "Alara", archetype: "Ranger" });
    adventure.createCharacter.send({ name: "Bram", archetype: "Guardian" });
  });

  const action_ignore_blank_move = action(() => {
    const alara = adventure.characters?.[0];
    if (alara) {
      alara.moveTo.send({ location: " " });
    }
  });

  const action_move_alara = action(() => {
    const alara = adventure.characters?.[0];
    if (alara) {
      alara.moveTo.send({ location: "Plate One" });
    }
  });

  const action_enlist_party = action(() => {
    const alara = adventure.characters?.[0];
    const bram = adventure.characters?.[1];
    if (alara) adventure.enlistCharacter.send({ character: alara });
    if (bram) adventure.enlistCharacter.send({ character: bram });
  });

  const action_repeat_and_ignore_enlistment = action(() => {
    const alara = adventure.characters?.[0];
    if (alara) adventure.enlistCharacter.send({ character: alara });
    adventure.enlistCharacter.send({
      character: { name: "", archetype: "", location: "" },
    });
  });

  const action_create_unlisted_character = action(() => {
    adventure.createCharacter.send({ name: " ", archetype: " " });
  });

  const action_ignore_empty_evidence_kind = action(() => {
    const alara = adventure.characters?.[0];
    if (alara) {
      adventure.recordQuestEvidence.send({ kind: " ", actors: [alara] });
    }
  });

  const action_ignore_actorless_evidence = action(() => {
    adventure.recordQuestEvidence.send({
      kind: "party.assembled",
      actors: [],
    });
  });

  const action_ignore_unlisted_actor = action(() => {
    const stranger = adventure.characters?.[2];
    if (stranger) {
      adventure.recordQuestEvidence.send({
        kind: "party.assembled",
        actors: [stranger],
      });
    }
  });

  const action_ignore_unknown_evidence = action(() => {
    const alara = adventure.characters?.[0];
    if (alara) {
      adventure.recordQuestEvidence.send({
        kind: "treasure.counted",
        actors: [alara],
      });
    }
  });

  const action_assemble_party = action(() => {
    const alara = adventure.characters?.[0];
    const bram = adventure.characters?.[1];
    if (alara && bram) {
      adventure.recordQuestEvidence.send({
        kind: "party.assembled",
        actors: [alara, alara, bram],
        note: "The companions enter the antechamber together.",
      });
    }
  });

  const action_open_door = action(() => {
    const alara = adventure.characters?.[0];
    const bram = adventure.characters?.[1];
    if (alara && bram) {
      adventure.recordQuestEvidence.send({
        kind: "door.opened",
        actors: [alara, bram],
      });
    }
  });

  const action_win_encounter = action(() => {
    const alara = adventure.characters?.[0];
    if (alara) {
      adventure.recordQuestEvidence.send({
        kind: "encounter.won",
        actors: [alara],
      });
    }
  });

  const action_open_gate = action(() => {
    const bram = adventure.characters?.[1];
    if (bram) {
      adventure.recordQuestEvidence.send({
        kind: "gate.opened",
        actors: [bram],
      });
    }
  });

  const action_create_character_from_ui = action(() => {
    const button = findElementByText(
      adventure[UI],
      "cf-button",
      "Create character",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
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
    hasText(adventure[UI], "Quest ledger") &&
    hasText(adventure[UI], "Create an adventurer")
  );

  const assert_party_created = assert(() =>
    (adventure.characters ?? []).length === 2 &&
    adventure.characters?.[0]?.name === "Alara" &&
    adventure.characters?.[0]?.archetype === "Ranger" &&
    adventure.characters?.[0]?.location === "Antechamber" &&
    adventure.characters?.[1]?.name === "Bram"
  );

  const assert_blank_move_ignored = assert(() =>
    adventure.characters?.[0]?.location === "Antechamber"
  );

  const assert_alara_moved = assert(() =>
    adventure.characters?.[0]?.location === "Plate One"
  );

  const assert_party_enlisted = assert(() =>
    adventure.quest.status === "active" &&
    (adventure.quest.participants ?? []).length === 2 &&
    adventure.quest.participants?.[0]?.name === "Alara" &&
    adventure.quest.participants?.[1]?.name === "Bram"
  );

  const assert_repeated_and_blank_enlistments_ignored = assert(() =>
    (adventure.quest.participants ?? []).length === 2
  );

  const assert_unlisted_character_uses_defaults = assert(() =>
    adventure.characters?.[2]?.name === "Unnamed adventurer" &&
    adventure.characters?.[2]?.archetype === "Adventurer" &&
    adventure.characters?.[2]?.location === "Antechamber"
  );

  const assert_unknown_evidence_ignored = assert(() =>
    (adventure.quest.evidence ?? []).length === 0
  );

  const assert_party_objective_completed = assert(() =>
    (adventure.quest.evidence ?? []).length === 1 &&
    adventure.quest.evidence?.[0]?.note ===
      "The companions enter the antechamber together." &&
    adventure.quest.progress?.[0]?.status === "completed" &&
    adventure.quest.progress?.[0]?.contributors?.length === 2 &&
    adventure.quest.progress?.[1]?.status === "active" &&
    adventure.quest.completedObjectiveCount === 1
  );

  const assert_door_objective_completed = assert(() =>
    adventure.quest.progress?.[1]?.status === "completed" &&
    adventure.quest.progress?.[2]?.status === "active" &&
    adventure.quest.completedObjectiveCount === 2
  );

  const assert_encounter_objective_completed = assert(() =>
    adventure.quest.progress?.[2]?.status === "completed" &&
    adventure.quest.progress?.[3]?.status === "active" &&
    adventure.quest.completedObjectiveCount === 3
  );

  const assert_quest_completed = assert(() =>
    adventure.quest.status === "completed" &&
    adventure.quest.progress?.[3]?.status === "completed" &&
    adventure.quest.completedObjectiveCount === 4 &&
    (adventure.quest.evidence ?? []).length === 4
  );

  const assert_ui_character_uses_defaults = assert(() =>
    adventure.characters?.[3]?.name === "Unnamed adventurer" &&
    adventure.characters?.[3]?.archetype === "Adventurer" &&
    adventure.characters?.[3]?.location === "Antechamber"
  );

  return {
    [TESTS]: [
      { render: adventure[UI] },
      { assertion: assert_initial_model },
      { assertion: assert_initial_ui },
      { action: action_create_party },
      { assertion: assert_party_created },
      { action: action_ignore_blank_move },
      { assertion: assert_blank_move_ignored },
      { action: action_move_alara },
      { assertion: assert_alara_moved },
      { action: action_enlist_party },
      { assertion: assert_party_enlisted },
      { action: action_repeat_and_ignore_enlistment },
      { assertion: assert_repeated_and_blank_enlistments_ignored },
      { action: action_create_unlisted_character },
      { assertion: assert_unlisted_character_uses_defaults },
      { action: action_ignore_empty_evidence_kind },
      { assertion: assert_unknown_evidence_ignored },
      { action: action_ignore_actorless_evidence },
      { assertion: assert_unknown_evidence_ignored },
      { action: action_ignore_unlisted_actor },
      { assertion: assert_unknown_evidence_ignored },
      { action: action_ignore_unknown_evidence },
      { assertion: assert_unknown_evidence_ignored },
      { action: action_assemble_party },
      { assertion: assert_party_objective_completed },
      { action: action_open_door },
      { assertion: assert_door_objective_completed },
      { action: action_win_encounter },
      { assertion: assert_encounter_objective_completed },
      { action: action_open_gate },
      { assertion: assert_quest_completed },
      { action: action_create_character_from_ui },
      { assertion: assert_ui_character_uses_defaults },
      { render: adventure[UI] },
    ],
    subject: adventure,
  };
});
