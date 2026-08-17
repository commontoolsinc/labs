import { action, assert, pattern, TESTS, UI } from "commonfabric";

import { hasText } from "../../test/vnode-helpers.ts";
import Quest from "./quest.tsx";

export default pattern(() => {
  const alara = {
    name: "Alara",
    archetype: "Ranger",
    location: "Antechamber",
  };
  const quest = Quest({
    title: "Open the Test Gate",
    summary: "Exercise the quest ledger controls.",
    objectives: [{
      key: "first-gate",
      title: "First gate",
      evidenceKind: "gate.first",
      target: 1,
    }, {
      key: "second-gate",
      title: "Second gate",
      evidenceKind: "gate.second",
      target: 1,
      requires: ["first-gate"],
    }],
    participants: [alara],
    evidence: [],
  });

  const action_record_first = action(() => {
    const participant = quest.participants?.[0];
    if (participant) {
      quest.recordEvidence.send({
        kind: "gate.first",
        actors: [participant],
        note: "The first mechanism yields.",
      });
    }
  });

  const action_record_second = action(() => {
    const participant = quest.participants?.[0];
    if (participant) {
      quest.recordEvidence.send({
        kind: "gate.second",
        actors: [participant],
        note: "The second mechanism yields.",
      });
    }
  });

  const action_reset = action(() => quest.reset.send());

  const assert_initial_ledger = assert(() =>
    quest.status === "active" &&
    quest.progress?.[0]?.status === "active" &&
    quest.progress?.[1]?.status === "locked" &&
    hasText(quest[UI], "Open the Test Gate")
  );

  const assert_second_gate_unlocked = assert(() =>
    quest.progress?.[0]?.status === "completed" &&
    quest.progress?.[1]?.status === "active" &&
    quest.evidence?.length === 1
  );

  const assert_completed_from_ledger = assert(() =>
    quest.status === "completed" &&
    quest.completedObjectiveCount === 2 &&
    quest.evidence?.length === 2
  );

  const assert_reset = assert(() =>
    quest.status === "available" &&
    quest.progress?.[0]?.status === "active" &&
    quest.progress?.[1]?.status === "locked" &&
    quest.completedObjectiveCount === 0 &&
    quest.participants?.length === 0 &&
    quest.evidence?.length === 0
  );

  return {
    [TESTS]: [
      { render: quest[UI] },
      { assertion: assert_initial_ledger },
      { action: action_record_first },
      { assertion: assert_second_gate_unlocked },
      { action: action_record_second },
      { assertion: assert_completed_from_ledger },
      { action: action_reset },
      { assertion: assert_reset },
    ],
  };
});
