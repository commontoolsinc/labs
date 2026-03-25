/// <cts-enable />
import { action, computed, pattern, UI } from "commontools";
import DirectCommand, {
  DIRECT_COMMAND_OUTPUT_SCHEMA,
} from "./cfc-ui-direct-command.tsx";

const disclosureContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiDisclosureContract",
  kind: "DirectCommandMayTriggerTools",
} as const;

const promptSlotContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiPromptSlotContract",
  surface: "AssistantComposer",
  role: "direct-command",
} as const;

const submitActionContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiActionContract",
  action: "SubmitDirectCommand",
} as const;

export default pattern(() => {
  const subject = DirectCommand({
    draft: "Summarize the latest inbox triage notes.",
    submittedCount: 0,
  });

  const action_submit = action(() => {
    subject.submit.send();
  });

  const assert_initial_draft = computed(() =>
    subject.draft === "Summarize the latest inbox triage notes."
  );
  const assert_initial_submit_count = computed(() =>
    subject.submittedCount === 0
  );
  const assert_submit_count_after_send = computed(() =>
    subject.submittedCount === 1
  );
  const assert_draft_cleared_after_send = computed(() => subject.draft === "");

  return {
    tests: [
      { assertion: assert_initial_draft },
      { assertion: assert_initial_submit_count },
      {
        labelAssertion: {
          target: "subject",
          schema: DIRECT_COMMAND_OUTPUT_SCHEMA,
          path: `/${UI}/children/1`,
          op: "shape",
          integrityIncludes: [disclosureContractAtom],
        },
      },
      {
        labelAssertion: {
          target: "subject",
          schema: DIRECT_COMMAND_OUTPUT_SCHEMA,
          path: `/${UI}/children/2`,
          op: "shape",
          integrityIncludes: [promptSlotContractAtom],
        },
      },
      {
        labelAssertion: {
          target: "subject",
          schema: DIRECT_COMMAND_OUTPUT_SCHEMA,
          path: `/${UI}/children/3`,
          op: "shape",
          integrityIncludes: [submitActionContractAtom],
        },
      },
      { action: action_submit },
      { assertion: assert_submit_count_after_send },
      { assertion: assert_draft_cleared_after_send },
    ],
    subject,
  };
});
