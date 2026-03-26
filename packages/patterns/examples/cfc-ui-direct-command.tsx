/// <cts-enable />
import {
  computed,
  Default,
  handler,
  JSONSchema,
  NAME,
  pattern,
  requireEventIntegrity,
  Stream,
  UI,
  VNode,
  Writable,
} from "commontools";

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

export interface DirectCommandInput {
  draft: Writable<Default<string, "Summarize the latest inbox triage notes.">>;
  submittedCount: Writable<Default<number, 0>>;
}

export interface DirectCommandOutput {
  draft: string;
  submittedCount: number;
  submit: Stream<void>;
  [UI]: VNode;
}

export const DIRECT_COMMAND_INPUT_SCHEMA = {
  type: "object",
  properties: {
    draft: { type: "string" },
    submittedCount: { type: "number" },
  },
  required: ["draft", "submittedCount"],
} as const satisfies JSONSchema;

export const DIRECT_COMMAND_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    draft: { type: "string" },
    submittedCount: { type: "number" },
    [UI]: {
      type: "object",
      properties: {
        children: {
          type: "array",
          prefixItems: [
            { type: "object" },
            {
              type: "object",
              ifc: {
                addIntegrity: [disclosureContractAtom],
              },
              properties: {
                props: {
                  type: "object",
                  properties: {
                    "data-ui-disclosure": { type: "string" },
                    "data-ui-disclosure-kind": { type: "string" },
                  },
                },
              },
            },
            {
              type: "object",
              ifc: {
                addIntegrity: [promptSlotContractAtom],
              },
              properties: {
                props: {
                  type: "object",
                  properties: {
                    "data-ui-role": { type: "string" },
                    "data-ui-surface": { type: "string" },
                  },
                },
              },
            },
            {
              type: "object",
              ifc: {
                addIntegrity: [submitActionContractAtom],
              },
              properties: {
                props: {
                  type: "object",
                  properties: {
                    "data-ui-action": { type: "string" },
                  },
                },
              },
            },
            {
              type: "object",
              properties: {
                props: {
                  type: "object",
                  properties: {
                    "data-ui-action": { type: "string" },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  required: ["draft", "submittedCount", UI],
} as const satisfies JSONSchema;

const submitDirectCommand = requireEventIntegrity(
  handler(
    (
      _: void,
      {
        draft,
        submittedCount,
      }: {
        draft: Writable<string>;
        submittedCount: Writable<number>;
      },
    ) => {
      if (!draft.get().trim()) {
        return;
      }
      submittedCount.set(submittedCount.get() + 1);
      draft.set("");
    },
  ),
  [submitActionContractAtom],
  { label: "SubmitDirectCommand" },
);

export default pattern<DirectCommandInput, DirectCommandOutput>(
  ({ draft, submittedCount }) => {
    const submit = submitDirectCommand({ draft, submittedCount });

    return {
      [NAME]: computed(
        () => `Direct command surface (${submittedCount.get()} sent)`,
      ),
      [UI]: (
        <ct-vstack
          gap="3"
          style={{
            padding: "1.25rem",
            maxWidth: "42rem",
            margin: "0 auto",
          }}
        >
          <h2>Trusted direct-command surface</h2>
          <ct-card
            data-ui-disclosure="tool-activation-warning"
            data-ui-disclosure-kind="DirectCommandMayTriggerTools"
            style={{
              padding: "0.75rem",
              background: "#fff4d6",
              border: "1px solid #f1cf71",
            }}
          >
            Commands entered here may trigger tools, send messages, or mutate
            downstream state.
          </ct-card>
          <ct-textarea
            $value={draft}
            rows={4}
            placeholder="Ask the assistant to take a direct action..."
            data-ui-role="direct-command"
            data-ui-surface="AssistantComposer"
          />
          <ct-button data-ui-action="SubmitDirectCommand" onClick={submit}>
            Submit direct command
          </ct-button>
          <ct-button
            data-ui-action="SubmitDirectCommandUntrusted"
            onClick={submit}
          >
            Submit without trusted contract
          </ct-button>
          <p style={{ color: "#5f5f5f" }}>
            Submitted commands: {submittedCount}
          </p>
        </ct-vstack>
      ),
      draft,
      submittedCount,
      submit,
    };
  },
  DIRECT_COMMAND_INPUT_SCHEMA,
  DIRECT_COMMAND_OUTPUT_SCHEMA,
);
