/// <cts-enable />
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";

import Adventure, { type AdventureOutput } from "./main.tsx";

interface Setup {
  adventure: AdventureOutput;
}

export const setup = pattern(() => ({
  adventure: Adventure({}),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const adventure = setup.adventure;

  const action_create_alara = action(() => {
    adventure.createCharacter.send({ name: "Alara", archetype: "Ranger" });
  });

  const action_enlist_alara = action(() => {
    const alara = adventure.characters?.[0];
    if (alara) adventure.enlistCharacter.send({ character: alara });
  });

  const action_report_party = action(() => {
    const alara = adventure.characters?.[0];
    const bram = adventure.characters?.[1];
    if (alara && bram) {
      adventure.recordQuestEvidence.send({
        kind: "party.assembled",
        actors: [alara, bram],
      });
    }
  });

  const assert_alara_created = assert(() =>
    adventure.characters?.[0]?.name === "Alara" &&
    adventure.quest.participants?.[0]?.name === "Alara"
  );

  const assert_sees_bram = assert(() =>
    adventure.characters?.[1]?.name === "Bram" &&
    adventure.quest.participants?.[1]?.name === "Bram"
  );

  const assert_concurrent_evidence_landed = assert(() =>
    adventure.quest.progress?.[0]?.status === "completed" &&
    adventure.quest.progress?.[1]?.status === "completed" &&
    adventure.quest.progress?.[0]?.contributors?.length === 2 &&
    adventure.quest.completedObjectiveCount === 2
  );

  return {
    [TESTS]: [
      { action: action_create_alara },
      { action: action_enlist_alara },
      { assertion: assert_alara_created },
      { label: "alara-ready" },
      { await: "bram-ready" },
      { assertion: assert_sees_bram },
      { action: action_report_party },
      { label: "party-reported" },
      { await: "door-reported" },
      { assertion: assert_concurrent_evidence_landed },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const adventure = setup.adventure;

  const action_create_bram = action(() => {
    adventure.createCharacter.send({ name: "Bram", archetype: "Guardian" });
  });

  const action_enlist_bram = action(() => {
    const bram = adventure.characters?.[1];
    if (bram) adventure.enlistCharacter.send({ character: bram });
  });

  const action_report_door = action(() => {
    const alara = adventure.characters?.[0];
    const bram = adventure.characters?.[1];
    if (alara && bram) {
      adventure.recordQuestEvidence.send({
        kind: "door.opened",
        actors: [alara, bram],
      });
    }
  });

  const assert_sees_alara = assert(() =>
    adventure.characters?.[0]?.name === "Alara" &&
    adventure.quest.participants?.[0]?.name === "Alara"
  );

  const assert_bram_created = assert(() =>
    adventure.characters?.[1]?.name === "Bram" &&
    adventure.quest.participants?.[1]?.name === "Bram"
  );

  const assert_concurrent_evidence_landed = assert(() =>
    adventure.quest.progress?.[0]?.status === "completed" &&
    adventure.quest.progress?.[1]?.status === "completed" &&
    adventure.quest.completedObjectiveCount === 2
  );

  return {
    [TESTS]: [
      { await: "alara-ready" },
      { assertion: assert_sees_alara },
      { action: action_create_bram },
      { action: action_enlist_bram },
      { assertion: assert_bram_created },
      { label: "bram-ready" },
      { action: action_report_door },
      { label: "door-reported" },
      { await: "party-reported" },
      { assertion: assert_concurrent_evidence_landed },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
