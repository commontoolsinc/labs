/// <cts-enable />
import {
  computed,
  Default,
  handler,
  implementationIdentityAtom,
  JSONSchema,
  NAME,
  pattern,
  requireEventIntegrity,
  Stream,
  UI,
  VNode,
  Writable,
} from "commontools";
import { TRUSTED_DIRECT_COMMAND_UI_CONCEPT } from "./cfc-ui-direct-command.tsx";

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

const promptSlotBoundAtom = {
  type: "https://commonfabric.org/cfc/atom/PromptSlotBound",
  surface: "AssistantComposer",
  role: "direct-command",
} as const;

const disclosureRenderedAtom = {
  type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
  kind: "DirectCommandMayTriggerTools",
} as const;

const renderLeafSchema = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "undefined" },
    { type: "object", properties: {} },
    { type: "array" },
  ],
} as const satisfies JSONSchema;

const vdomPropsSchema = {
  type: "object",
  properties: {
    style: { anyOf: [{ type: "object" }, { type: "string" }] },
  },
  additionalProperties: {
    anyOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
      { type: "undefined" },
      {
        type: "object",
        properties: {},
      },
      {
        type: "array",
        items: { type: "null" },
      },
      {
        asStream: true,
        type: "unknown",
      },
    ],
  },
  asCell: true,
} as const satisfies JSONSchema;

const baseVNodeSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    name: { type: "string" },
    props: vdomPropsSchema,
    children: {
      type: "array",
      items: renderLeafSchema,
    },
  },
  required: ["type", "name", "props", "children"],
} as const satisfies JSONSchema;

const directCommandUiSchema = {
  ...baseVNodeSchema,
  properties: {
    ...baseVNodeSchema.properties,
    children: {
      type: "array",
      prefixItems: [
        baseVNodeSchema,
        {
          ...baseVNodeSchema,
          ifc: {
            addIntegrity: [disclosureContractAtom],
          },
        },
        {
          ...baseVNodeSchema,
          ifc: {
            addIntegrity: [promptSlotContractAtom],
          },
        },
        {
          ...baseVNodeSchema,
          ifc: {
            addIntegrity: [submitActionContractAtom],
          },
        },
        baseVNodeSchema,
      ],
      items: renderLeafSchema,
    },
  },
} as const satisfies JSONSchema;

const submittedActionSchema = {
  type: "object",
  properties: {
    command: { type: "string" },
    submittedBy: { type: "string" },
  },
  required: ["command", "submittedBy"],
} as const satisfies JSONSchema;

export interface DirectCommandUntrustedInput {
  draft: Writable<Default<string, "Summarize the latest inbox triage notes.">>;
  submittedActions: Writable<
    Default<
      Array<{
        command: string;
        submittedBy: string;
      }>,
      []
    >
  >;
}

export interface DirectCommandUntrustedOutput {
  draft: string;
  submittedActions: Array<{
    command: string;
    submittedBy: string;
  }>;
  submit: Stream<void>;
  [UI]: VNode;
}

export const DIRECT_COMMAND_UNTRUSTED_INPUT_SCHEMA = {
  type: "object",
  properties: {
    draft: {
      type: "string",
      default: "Summarize the latest inbox triage notes.",
    },
    submittedActions: { type: "array", default: [], items: submittedActionSchema },
  },
  required: ["draft", "submittedActions"],
} as const satisfies JSONSchema;

const submitDirectCommand = requireEventIntegrity(
  handler(
    (
      _: void,
      {
        draft,
        submittedActions,
      }: {
        draft: Writable<string>;
        submittedActions: Writable<Array<{
          command: string;
          submittedBy: string;
        }>>;
      },
    ) => {
      const command = draft.get().trim();
      if (!command) {
        return;
      }
      const currentActions = submittedActions.get() ?? [];
      submittedActions.set([
        ...currentActions,
        {
          command,
          submittedBy: "untrusted-lookalike-surface",
        },
      ]);
      draft.set("");
    },
  ),
  [
    TRUSTED_DIRECT_COMMAND_UI_CONCEPT,
    promptSlotBoundAtom,
    disclosureRenderedAtom,
  ],
  { label: "SubmitDirectCommand" },
);

const submitDirectCommandWriterAtom = implementationIdentityAtom(
  submitDirectCommand,
);

if (!submitDirectCommandWriterAtom) {
  throw new Error(
    "Failed to derive implementation identity for untrusted SubmitDirectCommand",
  );
}

export const DIRECT_COMMAND_UNTRUSTED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    draft: { type: "string" },
    submittedActions: {
      type: "array",
      items: submittedActionSchema,
      ifc: {
        writeAuthorizedBy: [submitDirectCommandWriterAtom],
      },
    },
    [UI]: directCommandUiSchema,
  },
  required: [NAME, "draft", "submittedActions", UI],
} as const satisfies JSONSchema;

export default pattern<DirectCommandUntrustedInput, DirectCommandUntrustedOutput>(
  ({ draft, submittedActions }) => {
    const submit = submitDirectCommand({ draft, submittedActions });
    const submittedCount = computed(() => submittedActions.get()?.length ?? 0);

    return {
      [NAME]: computed(
        () => `Lookalike direct command surface (${submittedCount} sent)`,
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
          <h2>Lookalike direct-command surface</h2>
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
          <p id="direct-command-count" style={{ color: "#5f5f5f" }}>
            Submitted commands: {submittedCount}
          </p>
        </ct-vstack>
      ),
      draft,
      submittedActions,
      submit,
    };
  },
  DIRECT_COMMAND_UNTRUSTED_INPUT_SCHEMA,
  DIRECT_COMMAND_UNTRUSTED_OUTPUT_SCHEMA,
);
