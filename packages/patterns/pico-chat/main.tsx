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
  thumbsChoiceClass: string;
  thumbsPickerTitle: string;
  thumbsRemoveTitle: string;
  thumbsSummaryLabel: string;
  thumbsTitle: string;
  heartCount: number;
  heartPicked: boolean;
  heartChoiceClass: string;
  heartPickerTitle: string;
  heartRemoveTitle: string;
  heartSummaryLabel: string;
  heartTitle: string;
  laughCount: number;
  laughPicked: boolean;
  laughChoiceClass: string;
  laughPickerTitle: string;
  laughRemoveTitle: string;
  laughSummaryLabel: string;
  laughTitle: string;
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
  if (!message) return;

  const reactionsCell = messages.key(messageIndex).key("reactions");
  const reactions = asReactions(reactionsCell.get());
  const existingIndex = reactions.findIndex((reaction) =>
    reaction.emoji === mark && reaction.byName === byName
  );
  if (message.from === byName && existingIndex < 0) return;

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
    const thumbsPicked = hasViewerReaction(message, "👍", viewerName);
    const heartPicked = hasViewerReaction(message, "❤️", viewerName);
    const laughPicked = hasViewerReaction(message, "😂", viewerName);
    const thumbsTitle = reactionTitle(message, "👍");
    const heartTitle = reactionTitle(message, "❤️");
    const laughTitle = reactionTitle(message, "😂");

    return {
      index,
      from: message.from,
      body: message.body,
      showAuthor,
      canReact: viewerName !== "" && message.from !== viewerName,
      thumbsCount,
      thumbsPicked,
      thumbsChoiceClass: reactionChoiceClass(thumbsPicked),
      thumbsPickerTitle: reactionPickerTitle(
        "React with thumbs up",
        thumbsPicked,
      ),
      thumbsRemoveTitle: reactionBadgeTitle(
        "Remove your thumbs up",
        thumbsTitle,
      ),
      thumbsSummaryLabel: reactionSummaryLabel("👍", thumbsCount),
      thumbsTitle,
      heartCount,
      heartPicked,
      heartChoiceClass: reactionChoiceClass(heartPicked),
      heartPickerTitle: reactionPickerTitle("React with heart", heartPicked),
      heartRemoveTitle: reactionBadgeTitle("Remove your heart", heartTitle),
      heartSummaryLabel: reactionSummaryLabel("❤️", heartCount),
      heartTitle,
      laughCount,
      laughPicked,
      laughChoiceClass: reactionChoiceClass(laughPicked),
      laughPickerTitle: reactionPickerTitle(
        "React with laughing face",
        laughPicked,
      ),
      laughRemoveTitle: reactionBadgeTitle(
        "Remove your laughing face",
        laughTitle,
      ),
      laughSummaryLabel: reactionSummaryLabel("😂", laughCount),
      laughTitle,
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

function reactionTitle(message: ChatMessage, emoji: string) {
  const names = asReactions(message.reactions)
    .filter((reaction) => reaction.emoji === emoji)
    .map((reaction) => reaction.byName.trim())
    .filter(Boolean);
  return names.length > 0
    ? `${emoji} by ${Array.from(new Set(names)).join(", ")}`
    : "";
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

function reactionPickerTitle(action: string, picked: boolean) {
  return picked ? action.replace("React with", "Remove your") : action;
}

function reactionBadgeTitle(action: string, title: string) {
  return title ? `${action}. ${title}` : action;
}

const textStyle = {
  unicodeBidi: "plaintext",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const messagePaneStyle = {
  height: "320px",
  overflowX: "hidden",
  overflowY: "auto",
};

const messageListStyle = {
  minHeight: "100%",
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
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

export default pattern<PicoChatInput, PicoChatOutput>(
  ({ messages, name }) => {
    const send = sendMessage({ messages, name });
    const react = toggleReaction({ messages, name });
    const groups = computed(() => groupMessages([...messages]));
    const rows = computed(() =>
      displayMessages([...messages], currentViewerName(name))
    );

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
                position: absolute;
                right: 0.5rem;
                top: 0.5rem;
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

              .pico-reaction-badge {
                align-items: center;
                display: inline-flex;
                min-height: 1.75rem;
                padding: 0 0.35rem;
              }

              .pico-reaction-badge-action {
                appearance: none;
                background: transparent;
                border: 0;
                border-radius: 4px;
                color: inherit;
                cursor: pointer;
                font: inherit;
                line-height: inherit;
              }

              .pico-reaction-badge-action:hover,
              .pico-reaction-badge-action:focus-visible {
                background: rgba(148, 163, 184, 0.18);
              }

              .pico-reaction-badge-action:focus-visible {
                outline: 2px solid currentColor;
                outline-offset: 2px;
              }

              .pico-message-row {
                border-radius: 6px;
                margin: 0 -0.5rem;
                overflow-anchor: none;
                padding: 0.375rem 2.5rem 0.375rem 0.5rem;
                position: relative;
                transition: background-color 120ms ease;
              }

              .pico-message-row-start {
                padding-top: 0.625rem;
              }

              .pico-message-row-end {
                padding-bottom: 0.625rem;
              }

              .pico-message-row-end::after {
                background: rgba(148, 163, 184, 0.28);
                bottom: 0;
                content: "";
                height: 1px;
                left: 0.5rem;
                position: absolute;
                right: 0.5rem;
                transform: scaleY(0.5);
                transform-origin: bottom;
              }

              .pico-message-row:hover,
              .pico-message-row:focus-within {
                background: rgba(148, 163, 184, 0.14);
              }

              .pico-message-row:hover .pico-reaction-picker,
              .pico-message-row:has(.pico-reaction-choice:focus-visible) .pico-reaction-picker {
                display: flex;
                opacity: 1;
                pointer-events: auto;
              }

              .pico-message-pane {
                -ms-overflow-style: none;
                scrollbar-width: none;
              }

              .pico-message-pane::-webkit-scrollbar {
                display: none;
              }

              .pico-scroll-anchor {
                appearance: none;
                align-self: flex-end;
                background: transparent;
                border: 0;
                height: 1px;
                opacity: 0;
                outline: 0;
                overflow-anchor: auto;
                overflow: hidden;
                padding: 0;
                pointer-events: none;
                width: 1px;
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
                className="pico-message-pane"
                style={messagePaneStyle}
              >
                <div style={messageListStyle}>
                  {rows.length === 0
                    ? (
                      <div style={{ color: "var(--cf-colors-muted, #64748b)" }}>
                        No messages yet
                      </div>
                    )
                    : rows.map((row) => (
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
                                ? row.thumbsPicked
                                  ? (
                                    <button
                                      type="button"
                                      className="pico-reaction-badge pico-reaction-badge-action"
                                      aria-label="Remove your thumbs up"
                                      title={row.thumbsRemoveTitle}
                                      onClick={() =>
                                        react.send({
                                          messageIndex: row.index,
                                          emoji: "👍",
                                        })}
                                    >
                                      {row.thumbsSummaryLabel}
                                    </button>
                                  )
                                  : (
                                    <span
                                      className="pico-reaction-badge"
                                      title={row.thumbsTitle}
                                    >
                                      {row.thumbsSummaryLabel}
                                    </span>
                                  )
                                : null}
                              {row.heartCount > 0
                                ? row.heartPicked
                                  ? (
                                    <button
                                      type="button"
                                      className="pico-reaction-badge pico-reaction-badge-action"
                                      aria-label="Remove your heart"
                                      title={row.heartRemoveTitle}
                                      onClick={() =>
                                        react.send({
                                          messageIndex: row.index,
                                          emoji: "❤️",
                                        })}
                                    >
                                      {row.heartSummaryLabel}
                                    </button>
                                  )
                                  : (
                                    <span
                                      className="pico-reaction-badge"
                                      title={row.heartTitle}
                                    >
                                      {row.heartSummaryLabel}
                                    </span>
                                  )
                                : null}
                              {row.laughCount > 0
                                ? row.laughPicked
                                  ? (
                                    <button
                                      type="button"
                                      className="pico-reaction-badge pico-reaction-badge-action"
                                      aria-label="Remove your laughing face"
                                      title={row.laughRemoveTitle}
                                      onClick={() =>
                                        react.send({
                                          messageIndex: row.index,
                                          emoji: "😂",
                                        })}
                                    >
                                      {row.laughSummaryLabel}
                                    </button>
                                  )
                                  : (
                                    <span
                                      className="pico-reaction-badge"
                                      title={row.laughTitle}
                                    >
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
                                className={row.thumbsChoiceClass}
                                aria-label="React with thumbs up"
                                title={row.thumbsPickerTitle}
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
                                className={row.heartChoiceClass}
                                aria-label="React with heart"
                                title={row.heartPickerTitle}
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
                                className={row.laughChoiceClass}
                                aria-label="React with laughing face"
                                title={row.laughPickerTitle}
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
                  <button
                    id="chat-latest"
                    type="button"
                    className="pico-scroll-anchor"
                    aria-hidden="true"
                    tabIndex={-1}
                    autoFocus
                  />
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
