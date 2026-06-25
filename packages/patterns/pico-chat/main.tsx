import {
  computed,
  Default,
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
const DEFAULT_NAME = "";

type MessagesValue =
  | ChatMessage[]
  | Default<
    ChatMessage[],
    typeof DEFAULT_MESSAGES
  >;
type NameValue = string | Default<typeof DEFAULT_NAME>;

export type MessagesCell = Writable<MessagesValue>;
export type NameCell = Writable<NameValue>;

export interface SendEvent {
  detail?: {
    message?: string;
  };
}

export interface ReactEvent {
  messageIndex: number;
  emoji: string;
}

export interface MessageGroup {
  from: string;
  messages: ChatMessage[];
}

interface DisplayMessage {
  index: number;
  from: string;
  body: string;
  showAuthor: boolean;
  className: string;
  canReact: boolean;
  thumbsCount: number;
  thumbsPicked: boolean;
  thumbsSummaryLabel: string;
  heartCount: number;
  heartPicked: boolean;
  heartSummaryLabel: string;
  laughCount: number;
  laughPicked: boolean;
  laughSummaryLabel: string;
  hasAnyReaction: boolean;
}

export interface PicoChatInput {
  messages?: PerSpace<MessagesValue>;
  name?: PerUser<NameValue>;
}

export interface PicoChatOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: PerSpace<MessagesValue>;
  name: PerUser<NameValue>;
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
}>(({ messageIndex, emoji }, { messages, name }) => {
  const mark = emoji.trim();
  const byName = name.get().trim();
  if (!mark || !byName || !Number.isInteger(messageIndex)) return;

  const currentMessages = messages.get();
  const message = currentMessages[messageIndex];
  if (!message || message.from === byName) return;

  const reactionsCell = messages.key(messageIndex).key("reactions");
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

function currentViewerName(value: unknown): string {
  const maybeWritable = value as { get?: () => unknown };
  const current = typeof maybeWritable?.get === "function"
    ? maybeWritable.get()
    : value;
  return typeof current === "string" ? current.trim() : "";
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

function displayMessages(
  messages: readonly ChatMessage[],
  viewerName: string,
): DisplayMessage[] {
  return messages.map((message, index) => {
    const showAuthor = index === 0 || messages[index - 1].from !== message.from;
    const endGroup = index === messages.length - 1 ||
      messages[index + 1].from !== message.from;
    const thumbsCount = reactionCount(message, "👍");
    const heartCount = reactionCount(message, "❤️");
    const laughCount = reactionCount(message, "😂");

    return {
      index,
      from: message.from,
      body: message.body,
      showAuthor,
      canReact: viewerName !== "" && message.from !== viewerName,
      thumbsCount,
      thumbsPicked: hasViewerReaction(message, "👍", viewerName),
      thumbsSummaryLabel: reactionSummaryLabel("👍", thumbsCount),
      heartCount,
      heartPicked: hasViewerReaction(message, "❤️", viewerName),
      heartSummaryLabel: reactionSummaryLabel("❤️", heartCount),
      laughCount,
      laughPicked: hasViewerReaction(message, "😂", viewerName),
      laughSummaryLabel: reactionSummaryLabel("😂", laughCount),
      hasAnyReaction: thumbsCount > 0 || heartCount > 0 || laughCount > 0,
      className: [
        "pico-message-row",
        showAuthor ? "pico-message-row-start" : "",
        endGroup ? "pico-message-row-end" : "",
      ].filter(Boolean).join(" "),
    };
  });
}

function reactionCount(message: ChatMessage, emoji: string) {
  return asReactions(message.reactions).filter((reaction) =>
    reaction.emoji === emoji
  ).length;
}

function reactionSummaryLabel(emoji: string, count: number) {
  return count > 0 ? `${emoji} ${count}` : emoji;
}

function hasViewerReaction(
  message: ChatMessage,
  emoji: string,
  viewerName: string,
) {
  return viewerName !== "" &&
    asReactions(message.reactions).some((reaction) =>
      reaction.emoji === emoji && reaction.byName === viewerName
    );
}

function reactionChoiceClass(picked: boolean) {
  return picked
    ? "pico-reaction-choice pico-reaction-choice-picked"
    : "pico-reaction-choice";
}

const textStyle = {
  unicodeBidi: "plaintext",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const messagePaneStyle = {
  height: "320px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column-reverse",
};

const messageListStyle = {
  minHeight: "100%",
  display: "flex",
  flexDirection: "column-reverse",
};

const reactionSummaryStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.25rem",
  minHeight: "1.5rem",
};

const reactionPickerStyle = {
  flexWrap: "wrap",
  gap: "0.25rem",
  minHeight: "1.75rem",
};

const reactionBadgeStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "1.75rem",
  padding: "0 0.35rem",
};

export default pattern<PicoChatInput, PicoChatOutput>(
  ({ messages, name }) => {
    const send = sendMessage({ messages, name });
    const react = toggleReaction({ messages, name });
    const groups = computed(() => groupMessages([...messages]));
    const rows = computed(() =>
      displayMessages([...messages], currentViewerName(name))
    );
    const visibleRows = computed(() => [...rows].reverse());

    return {
      [NAME]: "Emo chat",
      [UI]: (
        <cf-screen>
          <style>
            {`
              .pico-reaction-picker {
                display: none;
                opacity: 0;
                pointer-events: none;
                transition: opacity 120ms ease;
              }

              .pico-reaction-choice {
                appearance: none;
                align-items: center;
                background: transparent;
                border: 0;
                border-radius: 4px;
                color: inherit;
                cursor: pointer;
                display: inline-flex;
                font: inherit;
                height: 1.75rem;
                justify-content: center;
                line-height: 1;
                padding: 0;
                transition: filter 120ms ease, transform 120ms ease;
                width: 1.75rem;
              }

              .pico-reaction-choice:hover,
              .pico-reaction-choice:focus-visible {
                transform: translateY(-1px) scale(1.08);
              }

              .pico-reaction-choice:focus-visible {
                outline: 2px solid currentColor;
                outline-offset: 2px;
              }

              .pico-reaction-choice-picked {
                filter: drop-shadow(0 0 4px rgba(96, 165, 250, 0.75));
              }

              .pico-message-row {
                padding: 4px 0;
              }

              .pico-message-row-start {
                padding-top: 10px;
              }

              .pico-message-row-end {
                padding-bottom: 10px;
                border-bottom: 1px solid var(--cf-colors-border, #e2e8f0);
              }

              .pico-message-row:hover .pico-reaction-picker,
              .pico-message-row:has(.pico-reaction-choice:focus-visible) .pico-reaction-picker {
                display: flex;
                opacity: 1;
                pointer-events: auto;
              }
            `}
          </style>
          <cf-vstack gap="4" padding="6" style="max-width: 720px;">
            <cf-heading level={2}>Emo chat</cf-heading>

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
                  {visibleRows.length === 0
                    ? (
                      <div style={{ color: "var(--cf-colors-muted, #64748b)" }}>
                        No messages yet
                      </div>
                    )
                    : visibleRows.map((row) => (
                      <div className={row.className}>
                        {row.showAuthor
                          ? (
                            <strong dir="ltr" style={textStyle}>
                              {row.from}
                            </strong>
                          )
                          : null}
                        <div dir="ltr" style={textStyle}>
                          {row.body}
                        </div>
                        {row.hasAnyReaction
                          ? (
                            <div style={reactionSummaryStyle}>
                              {row.thumbsCount > 0
                                ? (
                                  <span style={reactionBadgeStyle}>
                                    {row.thumbsSummaryLabel}
                                  </span>
                                )
                                : null}
                              {row.heartCount > 0
                                ? (
                                  <span style={reactionBadgeStyle}>
                                    {row.heartSummaryLabel}
                                  </span>
                                )
                                : null}
                              {row.laughCount > 0
                                ? (
                                  <span style={reactionBadgeStyle}>
                                    {row.laughSummaryLabel}
                                  </span>
                                )
                                : null}
                            </div>
                          )
                          : null}
                        {row.canReact
                          ? (
                            <div
                              className="pico-reaction-picker"
                              style={reactionPickerStyle}
                            >
                              <button
                                type="button"
                                className={reactionChoiceClass(
                                  row.thumbsPicked,
                                )}
                                aria-label="React with thumbs up"
                                onClick={() =>
                                  react.send({
                                    messageIndex: row.index,
                                    emoji: "👍",
                                  })}
                              >
                                👍
                              </button>
                              <button
                                type="button"
                                className={reactionChoiceClass(
                                  row.heartPicked,
                                )}
                                aria-label="React with heart"
                                onClick={() =>
                                  react.send({
                                    messageIndex: row.index,
                                    emoji: "❤️",
                                  })}
                              >
                                ❤️
                              </button>
                              <button
                                type="button"
                                className={reactionChoiceClass(
                                  row.laughPicked,
                                )}
                                aria-label="React with laughing face"
                                onClick={() =>
                                  react.send({
                                    messageIndex: row.index,
                                    emoji: "😂",
                                  })}
                              >
                                😂
                              </button>
                            </div>
                          )
                          : null}
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
