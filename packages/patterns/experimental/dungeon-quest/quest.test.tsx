import { action, assert, pattern, TESTS, UI } from "commonfabric";

import { findNodeByProp, hasText, propsOf } from "../../test/vnode-helpers.ts";
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

  const action_mark_first_from_ui = action(() => {
    const button = findNodeByProp(
      quest[UI],
      "aria-label",
      "Mark First gate complete",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_mark_second_from_ui = action(() => {
    const button = findNodeByProp(
      quest[UI],
      "aria-label",
      "Mark Second gate complete",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

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

  return {
    [TESTS]: [
      { render: quest[UI] },
      { assertion: assert_initial_ledger },
      { action: action_mark_first_from_ui },
      { assertion: assert_second_gate_unlocked },
      { action: action_mark_second_from_ui },
      { assertion: assert_completed_from_ledger },
    ],
  };
});
