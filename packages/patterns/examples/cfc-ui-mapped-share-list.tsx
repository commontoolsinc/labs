/// <cts-enable />
import {
  action,
  computed,
  Default,
  JSONSchema,
  NAME,
  pattern,
  Stream,
  UI,
  VNode,
  Writable,
} from "commontools";

const messageRowPlacementAtom = {
  type: "https://commonfabric.org/cfc/atom/UiPlacement",
  surface: "InboxList",
  slot: "message-row",
} as const;

const shareActionContractAtom = {
  type: "https://commonfabric.org/cfc/atom/UiActionContract",
  action: "ShareReviewedMessage",
} as const;

export interface ReviewMessage {
  id: string;
  sender: string;
  subject: string;
  shared: Default<boolean, false>;
}

export interface MessageShareRowInput {
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
    subject: { type: "string" },
    sender: { type: "string" },
    shareTarget: { type: "string" },
    shared: { type: "boolean" },
  },
  required: ["subject", "sender", "shareTarget", "shared"],
} as const satisfies JSONSchema;

export const MESSAGE_SHARE_ROW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    shared: { type: "boolean" },
    [UI]: {
      type: "object",
      properties: {
        children: {
          type: "array",
          prefixItems: [
            { type: "object" },
            { type: "object" },
            {
              type: "object",
              ifc: {
                addIntegrity: [shareActionContractAtom],
              },
              properties: {
                props: {
                  type: "object",
                  properties: {
                    "data-ui-action": { type: "string" },
                    "data-share-target": { type: "string" },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  required: ["shared", UI],
} as const satisfies JSONSchema;

export const MessageShareRow = pattern<
  MessageShareRowInput,
  MessageShareRowOutput
>(
  ({ subject, sender, shareTarget, shared }) => {
    const toggleShared = action(() => {
      shared.set(!shared.get());
    });

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
            onClick={toggleShared}
          >
            {computed(() =>
              shared.get()
                ? `Shared with ${shareTarget}`
                : `Share with ${shareTarget}`
            )}
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
    shareTarget: { type: "string" },
    sharedCount: { type: "number" },
    [UI]: {
      type: "object",
      properties: {
        children: {
          type: "array",
          prefixItems: [
            { type: "object" },
            { type: "object" },
            {
              type: "object",
              properties: {
                children: {
                  type: "array",
                  items: {
                    type: "object",
                    ifc: {
                      addIntegrity: [messageRowPlacementAtom],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  required: ["shareTarget", "sharedCount", UI],
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
                subject={message.subject}
                sender={message.sender}
                shareTarget={shareTarget}
                shared={message.shared}
              />
            ))}
          </ct-vstack>
        </ct-vstack>
      ),
      shareTarget,
      sharedCount,
    };
  },
  SHARE_LIST_INPUT_SCHEMA,
  SHARE_LIST_OUTPUT_SCHEMA,
);
