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

const messageRowPlacementAtom = {
  type: "https://commonfabric.org/cfc/atom/UiPlacement",
  surface: "InboxList",
  slot: "message-row",
} as const;

const shareActionContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiActionContract",
  action: "ShareReviewedMessage",
} as const;

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

const shareButtonPropsSchema = {
  ...vdomPropsSchema,
  properties: {
    ...(vdomPropsSchema.properties ?? {}),
    "data-ui-action": { type: "string" },
    "data-share-target": { type: "string" },
    "data-message-id": { type: "string" },
  },
} as const satisfies JSONSchema;

const trustedShareButtonSchema = {
  ...baseVNodeSchema,
  ifc: {
    addIntegrity: [shareActionContractAtom],
  },
  properties: {
    ...baseVNodeSchema.properties,
    props: shareButtonPropsSchema,
  },
} as const satisfies JSONSchema;

const untrustedShareButtonSchema = {
  ...baseVNodeSchema,
  properties: {
    ...baseVNodeSchema.properties,
    props: shareButtonPropsSchema,
  },
} as const satisfies JSONSchema;

const rowPlacementChildSchema = {
  type: "object",
  ifc: {
    addIntegrity: [messageRowPlacementAtom],
  },
  properties: {
    [UI]: {
      ...baseVNodeSchema,
      properties: {
        ...baseVNodeSchema.properties,
        children: {
          type: "array",
          prefixItems: [
            baseVNodeSchema,
            baseVNodeSchema,
            trustedShareButtonSchema,
            untrustedShareButtonSchema,
          ],
          items: renderLeafSchema,
        },
      },
    },
  },
  required: [UI],
} as const satisfies JSONSchema;

const messageRowUiSchema = {
  ...baseVNodeSchema,
  properties: {
    ...baseVNodeSchema.properties,
    children: {
      type: "array",
      prefixItems: [
        baseVNodeSchema,
        baseVNodeSchema,
        trustedShareButtonSchema,
        untrustedShareButtonSchema,
      ],
      items: renderLeafSchema,
    },
  },
} as const satisfies JSONSchema;

const shareCountNodeSchema = {
  ...baseVNodeSchema,
  properties: {
    ...baseVNodeSchema.properties,
    props: {
      ...vdomPropsSchema,
      properties: {
        ...(vdomPropsSchema.properties ?? {}),
        id: { type: "string" },
      },
    },
  },
} as const satisfies JSONSchema;

const shareListUiSchema = {
  ...baseVNodeSchema,
  properties: {
    ...baseVNodeSchema.properties,
    children: {
      type: "array",
      prefixItems: [
        baseVNodeSchema,
        baseVNodeSchema,
        {
          ...baseVNodeSchema,
          properties: {
            ...baseVNodeSchema.properties,
            children: {
              type: "array",
              items: rowPlacementChildSchema,
            },
          },
        },
        shareCountNodeSchema,
      ],
      items: renderLeafSchema,
    },
  },
} as const satisfies JSONSchema;

export interface ReviewMessage {
  id: string;
  sender: string;
  subject: string;
  shared: Default<boolean, false>;
}

export interface MessageShareRowInput {
  messageId: string;
  subject: string;
  sender: string;
  shareTarget: string;
  shared: Writable<Default<boolean, false>>;
}

export interface MessageShareRowOutput {
  shared: boolean;
  toggleShared: Stream<void>;
  [UI]: VNode;
}

export const MESSAGE_SHARE_ROW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    messageId: { type: "string" },
    subject: { type: "string" },
    sender: { type: "string" },
    shareTarget: { type: "string" },
    shared: { type: "boolean" },
  },
  required: ["messageId", "subject", "sender", "shareTarget", "shared"],
} as const satisfies JSONSchema;

export const MESSAGE_SHARE_ROW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    shared: { type: "boolean" },
    [UI]: messageRowUiSchema,
  },
  required: [NAME, "shared", UI],
} as const satisfies JSONSchema;

const toggleReviewedMessageShared = requireEventIntegrity(
  handler(
    (
      _: void,
      {
        shared,
      }: {
        shared: Writable<Default<boolean, false>>;
      },
    ) => {
      shared.set(!shared.get());
    },
  ),
  [shareActionContractAtom],
  { label: "ShareReviewedMessage" },
);

export const MessageShareRow = pattern<
  MessageShareRowInput,
  MessageShareRowOutput
>(
  ({ messageId, subject, sender, shareTarget, shared }) => {
    const toggleShared = toggleReviewedMessageShared({ shared });

    return {
      [NAME]: computed(() => `Message row: ${subject}`),
      [UI]: (
        <ct-card
          style={{
            padding: "0.875rem",
            display: "grid",
            gap: "0.5rem",
            border: "1px solid #d8dde6",
          }}
        >
          <strong>{subject}</strong>
          <span style={{ color: "#5f6b7a" }}>From {sender}</span>
          <ct-button
            data-ui-action="ShareReviewedMessage"
            data-share-target={shareTarget}
            data-message-id={messageId}
            onClick={toggleShared}
          >
            {computed(() =>
              shared.get()
                ? `Shared with ${shareTarget}`
                : `Share with ${shareTarget}`
            )}
          </ct-button>
          <ct-button
            data-ui-action="ShareReviewedMessageUntrusted"
            data-share-target={shareTarget}
            data-message-id={messageId}
            onClick={toggleShared}
          >
            Attempt untrusted share
          </ct-button>
        </ct-card>
      ),
      shared,
      toggleShared,
    };
  },
  MESSAGE_SHARE_ROW_INPUT_SCHEMA,
  MESSAGE_SHARE_ROW_OUTPUT_SCHEMA,
);

export interface ShareListInput {
  shareTarget: Writable<Default<string, "did:key:reviewer">>;
  messages: Writable<
    Default<
      ReviewMessage[],
      [
        {
          id: "m-1";
          sender: "ops@example.com";
          subject: "Escalation summary";
          shared: false;
        },
        {
          id: "m-2";
          sender: "ceo@example.com";
          subject: "Board deck draft";
          shared: false;
        },
      ]
    >
  >;
}

export interface ShareListOutput {
  shareTarget: string;
  sharedCount: number;
  [UI]: VNode;
}

export const SHARE_LIST_INPUT_SCHEMA = {
  type: "object",
  properties: {
    shareTarget: { type: "string" },
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          sender: { type: "string" },
          subject: { type: "string" },
          shared: { type: "boolean" },
        },
        required: ["id", "sender", "subject", "shared"],
      },
    },
  },
  required: ["shareTarget", "messages"],
} as const satisfies JSONSchema;

export const SHARE_LIST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    shareTarget: { type: "string" },
    sharedCount: { type: "number" },
    [UI]: shareListUiSchema,
  },
  required: [NAME, "shareTarget", "sharedCount", UI],
} as const satisfies JSONSchema;

export default pattern<ShareListInput, ShareListOutput>(
  ({ shareTarget, messages }) => {
    const sharedCount = computed(() =>
      messages.get().filter((message) => message.shared).length
    );

    return {
      [NAME]: computed(() => `Mapped share list (${sharedCount} shared)`),
      [UI]: (
        <ct-vstack
          gap="3"
          style={{
            padding: "1.25rem",
            maxWidth: "46rem",
            margin: "0 auto",
          }}
        >
          <h2>Mapped child-slot delegation example</h2>
          <p style={{ color: "#5f6b7a" }}>
            The parent list delegates the message-row slot to each mapped child.
            Each row pattern still carries its own local action contract.
          </p>
          <ct-vstack gap="2">
            {messages.map((message) => (
              <MessageShareRow
                messageId={message.id}
                subject={message.subject}
                sender={message.sender}
                shareTarget={shareTarget}
                shared={message.shared}
              />
            ))}
          </ct-vstack>
          <p id="mapped-share-count">Shared messages: {sharedCount}</p>
        </ct-vstack>
      ),
      shareTarget,
      sharedCount,
    };
  },
  SHARE_LIST_INPUT_SCHEMA,
  SHARE_LIST_OUTPUT_SCHEMA,
);
