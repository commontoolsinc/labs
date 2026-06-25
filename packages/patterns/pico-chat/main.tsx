import {
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export type NameCell = Writable<string>;

export interface Reaction {
  emoji: string;
  byName: string;
}

export interface ChatMessage {
  from: string;
  body: string;
  reactions?: Reaction[] | Default<[]>;
}

const DEFAULT_MESSAGES: ChatMessage[] = [];
const REACTION_EMOJIS = ["👍", "❤️", "😂"] as const;

export type MessagesCell = Writable<ChatMessage[]>;

export interface SendEvent {
  detail?: {
    message?: string;
  };
}

export interface ReactEvent {
  message: ChatMessage;
  emoji: string;
}

export interface MessageGroup {
  from: string;
  messages: ChatMessage[];
}

export interface PicoChatInput {
  messages?: PerSpace<Default<ChatMessage[], typeof DEFAULT_MESSAGES>>;
  name?: PerUser<Default<string, "">>;
}

export interface PicoChatOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: PerSpace<Default<ChatMessage[], typeof DEFAULT_MESSAGES>>;
  name: PerUser<Default<string, "">>;
  groups: MessageGroup[];
  send: Stream<SendEvent>;
  react: Stream<ReactEvent>;
}

const sendMessage = handler<SendEvent, {
  messages: MessagesCell;
  name: NameCell;
}>(({ detail }, { messages, name }) => {
  const from = name.get().trim();
  const body = detail?.message?.trim() ?? "";

  if (!from || !body) return;

  messages.push({ from, body, reactions: [] });
});

const toggleReaction = handler<ReactEvent, {
  messages: MessagesCell;
  name: NameCell;
}>(({ message, emoji }, { messages, name }) => {
  const mark = emoji.trim();
  const byName = name.get().trim();
  if (!message || !mark || !byName) return;

  const currentMessages = messages.get();
  const index = currentMessages.findIndex((candidate) =>
    equals(candidate, message)
  );
  if (index < 0) return;

  const reactionsCell = messages.key(index).key("reactions");
  const reactions = asReactions(reactionsCell.get());
  const existingIndex = reactions.findIndex((reaction) =>
    reaction.emoji === mark && reaction.byName === byName
  );

  reactionsCell.set(
    existingIndex >= 0
      ? reactions.filter((_, index) => index !== existingIndex)
      : [...reactions, { emoji: mark, byName }],
  );
});

function asReactions(
  reactions: readonly Reaction[] | Default<[]> | undefined,
): Reaction[] {
  return Array.isArray(reactions) ? [...reactions] : [];
}

export function groupMessages(
  messages: readonly ChatMessage[],
): MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last && last.messages[last.messages.length - 1].from === message.from) {
      last.from = message.from;
      last.messages.push(message);
    } else {
      groups.push({
        from: message.from,
        messages: [message],
      });
    }
  }

  return groups;
}

function reactionCount(message: ChatMessage, emoji: string) {
  return asReactions(message.reactions).filter((reaction) =>
    reaction.emoji === emoji
  ).length;
}

function reactionLabel(message: ChatMessage, emoji: string) {
  const count = reactionCount(message, emoji);
  return count > 0 ? `${emoji} ${count}` : emoji;
}

export function reactionClick(
  react: Stream<ReactEvent>,
  message: ChatMessage,
  emoji: string,
) {
  return () => react.send({ message, emoji });
}

const textStyle = {
  unicodeBidi: "plaintext",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const messagePaneStyle = {
  height: "320px",
  overflowY: "auto",
};

const messageListStyle = {
  minHeight: "100%",
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
};

const groupStyle = {
  padding: "10px 0",
  borderBottom: "1px solid var(--cf-colors-border, #e2e8f0)",
};

const messageStackStyle = {
  display: "grid",
  gap: "0.5rem",
  marginTop: "0.25rem",
};

const reactionRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.25rem",
};

export default pattern<PicoChatInput, PicoChatOutput>(
  ({ messages, name }) => {
    const send = sendMessage({ messages, name });
    const react = toggleReaction({ messages, name });
    const groups = computed(() => groupMessages([...messages]));

    return {
      [NAME]: "Pico chat",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="4" padding="6" style="max-width: 720px;">
            <cf-heading level={2}>Pico chat</cf-heading>

            <cf-vstack gap="2">
              <cf-label>Your name</cf-label>
              <cf-input
                id="chat-name"
                $value={name}
                placeholder="Name"
                timing-strategy="immediate"
              />
            </cf-vstack>

            <cf-card>
              <div
                slot="content"
                id="chat-messages"
                style={messagePaneStyle}
              >
                <div style={messageListStyle}>
                  {groups.length === 0
                    ? (
                      <div style={{ color: "var(--cf-colors-muted, #64748b)" }}>
                        No messages yet
                      </div>
                    )
                    : groups.map((group) => (
                      <div style={groupStyle}>
                        <strong dir="ltr" style={textStyle}>
                          {group.from}
                        </strong>
                        <div style={messageStackStyle}>
                          {group.messages.map((message) => (
                            <div>
                              <div dir="ltr" style={textStyle}>
                                {message.body}
                              </div>
                              <div style={reactionRowStyle}>
                                {REACTION_EMOJIS.map((emoji) => (
                                  <cf-button
                                    size="sm"
                                    variant="ghost"
                                    onClick={reactionClick(
                                      react,
                                      message,
                                      emoji,
                                    )}
                                  >
                                    {reactionLabel(message, emoji)}
                                  </cf-button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </cf-card>

            <cf-message-input
              id="chat-message"
              placeholder="Message"
              button-text="Send"
              oncf-send={send}
            />
          </cf-vstack>
        </cf-screen>
      ),
      messages,
      name,
      groups,
      send,
      react,
    };
  },
);
