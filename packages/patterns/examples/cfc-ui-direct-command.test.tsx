/// <cts-enable />
import { computed, pattern, UI } from "commontools";
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
    submittedActions: [],
  });

  const assert_initial_draft = computed(() =>
    subject.draft === "Summarize the latest inbox triage notes."
  );
  const assert_initial_submit_count = computed(() =>
    subject.submittedActions.length === 0
  );
  const assert_submit_count_after_rejected_send = computed(() =>
    subject.submittedActions.length === 0
  );
  const assert_draft_preserved_after_rejected_send = computed(() =>
    subject.draft === "Summarize the latest inbox triage notes."
  );

  return {
    allowRuntimeErrors: true,
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
      {
        uiEvent: {
          target: "subject",
          schema: DIRECT_COMMAND_OUTPUT_SCHEMA,
          attr: {
            name: "data-ui-action",
            value: "SubmitDirectCommandUntrusted",
          },
          expectedNodePath: `/${UI}/children/4`,
          sourceGestureId: "gesture-direct-command-untrusted-pattern-test",
        },
      },
      { assertion: assert_submit_count_after_rejected_send },
      { assertion: assert_draft_preserved_after_rejected_send },
      {
        runtimeErrorAssertion: {
          includes: [
            "CfcEventIntegrityViolationError",
            "SubmitDirectCommand",
          ],
        },
      },
    ],
    subject,
  };
});
