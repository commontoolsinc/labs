import {
  computed,
  handler,
  type JSONSchema,
  NAME,
  nonPrivateRandom,
  pattern,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export type RoomId = "lobby" | "workshop" | "afterparty";

export interface ChatMessage {
  id: string;
  room: RoomId;
  author: string;
  body: string;
  sentAt: number;
}

export interface Conversation {
  rooms: {
    lobby: ChatMessage[];
    workshop: ChatMessage[];
    afterparty: ChatMessage[];
  };
}

export interface SendEvent {
  submit: true;
}

const DEFAULT_CONVERSATION = {
  rooms: {
    lobby: [],
    workshop: [],
    afterparty: [],
  },
} satisfies Conversation;

const ROOM_ITEMS = [
  { label: "Lobby", value: "lobby" },
  { label: "Workshop", value: "workshop" },
  { label: "Afterparty", value: "afterparty" },
];

const ROOM_LABELS: Record<RoomId, string> = {
  lobby: "Lobby",
  workshop: "Workshop",
  afterparty: "Afterparty",
};

const CHAT_THEME = {
  fontFamily:
    "'Avenir Next', 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  monoFontFamily: "'SF Mono', 'Roboto Mono', ui-monospace, monospace",
  borderRadius: "8px",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#1f6f5b",
    primaryForeground: "#ffffff",
    secondary: "#34435f",
    secondaryForeground: "#ffffff",
    background: "#eef4f1",
    surface: "#ffffff",
    surfaceHover: "#f3f7f5",
    text: "#14211f",
    textMuted: "#5d6f68",
    border: "#cbd9d3",
    borderMuted: "#e2ebe7",
    accent: "#c2573a",
    accentForeground: "#ffffff",
    success: "#2f8a64",
    successForeground: "#ffffff",
    error: "#a33b35",
    errorForeground: "#ffffff",
    warning: "#b27722",
    warningForeground: "#ffffff",
  },
};

const shellStyle = {
  height: "100%",
  minHeight: "620px",
  background: "linear-gradient(160deg, #eef4f1 0%, #ffffff 46%, #e8f0ec 100%)",
};

const headerStyle = {
  padding: "18px 20px 12px",
  borderBottom: "1px solid var(--cf-theme-color-border-muted)",
  background:
    "linear-gradient(90deg, rgba(31,111,91,0.12), rgba(194,87,58,0.10))",
};

const panelStyle = {
  border: "1px solid var(--cf-theme-color-border)",
  borderRadius: "8px",
  background: "rgba(255,255,255,0.9)",
  boxShadow: "0 12px 32px rgba(31, 55, 49, 0.10)",
};

const messageStyle = {
  borderLeft: "4px solid var(--cf-theme-color-primary)",
  background: "var(--cf-theme-color-surface)",
};

const composerStyle = {
  padding: "14px 16px",
  borderTop: "1px solid var(--cf-theme-color-border-muted)",
  background: "rgba(255,255,255,0.92)",
};

const metaTextStyle = {
  color: "var(--cf-theme-color-text-muted)",
  fontSize: "13px",
};

type ScopedGroupChatInput = Record<string, never>;

const STATE_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      default: "",
      asCell: [{ kind: "cell", scope: "user" }],
    },
    selectedRoom: {
      $ref: "#/$defs/RoomId",
      default: "lobby",
      asCell: [{ kind: "cell", scope: "session" }],
    },
    conversation: {
      $ref: "#/$defs/Conversation",
      default: DEFAULT_CONVERSATION,
      asCell: [{ kind: "cell", scope: "space" }],
    },
    draft: {
      type: "string",
      default: "",
      asCell: [{ kind: "cell", scope: "user" }],
    },
  },
  required: ["name", "selectedRoom", "conversation", "draft"],
  $defs: {
    RoomId: {
      enum: ["lobby", "workshop", "afterparty"],
    },
    Conversation: {
      type: "object",
      properties: {
        rooms: {
          type: "object",
          properties: {
            lobby: {
              type: "array",
              items: { $ref: "#/$defs/ChatMessage" },
            },
            workshop: {
              type: "array",
              items: { $ref: "#/$defs/ChatMessage" },
            },
            afterparty: {
              type: "array",
              items: { $ref: "#/$defs/ChatMessage" },
            },
          },
          required: ["lobby", "workshop", "afterparty"],
        },
      },
      required: ["rooms"],
    },
    ChatMessage: {
      type: "object",
      properties: {
        id: { type: "string" },
        room: { $ref: "#/$defs/RoomId" },
        author: { type: "string" },
        body: { type: "string" },
        sentAt: { type: "number" },
      },
      required: ["id", "room", "author", "body", "sentAt"],
    },
  },
} as const satisfies JSONSchema;

interface ScopedGroupChatOutput {
  [NAME]: string;
  [UI]: VNode;
  name: Writable<string>;
  selectedRoom: Writable<RoomId>;
  conversation: Writable<Conversation>;
  draft: Writable<string>;
  currentName: string;
  currentRoom: RoomId;
  currentDraft: string;
  conversationSnapshot: Conversation;
  messagesInSelectedRoom: ChatMessage[];
  messageCount: number;
  lobbyCount: number;
  workshopCount: number;
  afterpartyCount: number;
  lastLobbyAuthor: string;
  lastLobbyBody: string;
  lastWorkshopBody: string;
  sendMessage: Stream<SendEvent>;
  setName: Stream<{ name: string }>;
  setDraft: Stream<{ draft: string }>;
  selectRoom: Stream<{ room: RoomId }>;
}

const roomMessages = (
  conversation: Conversation | undefined,
  room: RoomId,
): ChatMessage[] => {
  const rooms = plainConversation(conversation).rooms;
  return rooms[room] ?? [];
};

const plainString = (value: unknown): string =>
  typeof value === "string" ? value : "";
const plainRoom = (value: unknown): RoomId =>
  value === "workshop" || value === "afterparty" ? value : "lobby";
const plainConversation = (value: unknown): Conversation =>
  value &&
    typeof value === "object" &&
    "rooms" in value &&
    (value as { rooms?: unknown }).rooms &&
    typeof (value as { rooms?: unknown }).rooms === "object"
    ? value as Conversation
    : DEFAULT_CONVERSATION;

const sendMessage = handler<SendEvent, {
  name: Writable<string>;
  selectedRoom: Writable<RoomId>;
  conversation: Writable<Conversation>;
  draft: Writable<string>;
}>((_, { name, selectedRoom, conversation, draft }) => {
  const body = plainString(draft.get()).trim();
  if (!body) return;

  const room = plainRoom(selectedRoom.get());
  const author = plainString(name.get()).trim() || "Anonymous";
  const current = plainConversation(conversation.get());
  const currentRooms = current.rooms ?? DEFAULT_CONVERSATION.rooms;
  const existingMessages = currentRooms[room] ?? [];
  const sentAt = safeDateNow();

  conversation.set({
    rooms: {
      lobby: currentRooms.lobby ?? [],
      workshop: currentRooms.workshop ?? [],
      afterparty: currentRooms.afterparty ?? [],
      [room]: [
        ...existingMessages,
        {
          id: `msg-${sentAt}-${nonPrivateRandom().toString(36).slice(2, 8)}`,
          room,
          author,
          body,
          sentAt,
        },
      ],
    },
  });
  draft.set("");
});

const setName = handler<{ name: string }, { name: Writable<string> }>(
  ({ name: nextName }, { name }) => {
    name.set(nextName);
  },
);

const setDraft = handler<{ draft: string }, { draft: Writable<string> }>(
  ({ draft: nextDraft }, { draft }) => {
    draft.set(nextDraft);
  },
);

const selectRoom = handler<
  { room: RoomId },
  { selectedRoom: Writable<RoomId> }
>(
  ({ room }, { selectedRoom }) => {
    selectedRoom.set(room);
  },
);

export default pattern<ScopedGroupChatInput, ScopedGroupChatOutput>(
  () => {
    const state = Writable.of<Partial<{
      name: string;
      selectedRoom: RoomId;
      conversation: Conversation;
      draft: string;
    }>>({}, STATE_SCHEMA).for("state");
    const name = state.key("name") as Writable<string>;
    const selectedRoom = state.key("selectedRoom") as Writable<RoomId>;
    const conversation = state.key("conversation") as Writable<Conversation>;
    const draft = state.key("draft") as Writable<string>;
    const send = sendMessage({ name, selectedRoom, conversation, draft });
    const boundSetName = setName({ name });
    const boundSetDraft = setDraft({ draft });
    const boundSelectRoom = selectRoom({ selectedRoom });
    const currentName = computed(() => plainString(name.get()));
    const currentRoom = computed(() => plainRoom(selectedRoom.get()));
    const currentDraft = computed(() => plainString(draft.get()));
    const conversationSnapshot = computed(() =>
      plainConversation(conversation.get())
    );
    const messagesInSelectedRoom = computed(() =>
      roomMessages(conversationSnapshot, currentRoom)
    );
    const messageCount = computed(() => messagesInSelectedRoom.length);
    const currentRoomLabel = computed(() => ROOM_LABELS[currentRoom]);
    const lobbyCount = computed(() =>
      plainConversation(conversationSnapshot).rooms.lobby.length
    );
    const workshopCount = computed(() =>
      plainConversation(conversationSnapshot).rooms.workshop.length
    );
    const afterpartyCount = computed(() =>
      plainConversation(conversationSnapshot).rooms.afterparty.length
    );
    const lastLobbyAuthor = computed(() =>
      plainConversation(conversationSnapshot).rooms.lobby[
        plainConversation(conversationSnapshot).rooms.lobby.length - 1
      ]?.author ?? ""
    );
    const lastLobbyBody = computed(() =>
      plainConversation(conversationSnapshot).rooms.lobby[
        plainConversation(conversationSnapshot).rooms.lobby.length - 1
      ]?.body ?? ""
    );
    const lastWorkshopBody = computed(() =>
      plainConversation(conversationSnapshot).rooms.workshop[
        plainConversation(conversationSnapshot).rooms.workshop.length - 1
      ]?.body ?? ""
    );

    return {
      [NAME]: "Scoped group chat",
      [UI]: (
        <cf-theme theme={CHAT_THEME}>
          <cf-screen style={shellStyle}>
            <cf-vstack slot="header" gap="3" style={headerStyle}>
              <cf-hstack justify="between" align="center" gap="4">
                <div>
                  <cf-heading level={2}>Group chat</cf-heading>
                  <div style={metaTextStyle}>
                    {messageCount} messages in {currentRoomLabel}
                  </div>
                </div>
                <cf-hstack gap="2" align="center">
                  <cf-badge color="neutral" variant="outline">
                    {currentRoomLabel}
                  </cf-badge>
                  <cf-badge color="primary" variant="solid">
                    {currentName || "Anonymous"}
                  </cf-badge>
                </cf-hstack>
              </cf-hstack>

              <cf-hstack gap="3" align="end">
                <cf-vstack gap="1" style="flex: 1; min-width: 180px;">
                  <cf-label>Your name</cf-label>
                  <cf-input
                    $value={name}
                    placeholder="Ada Lovelace"
                    aria-label="Your name"
                  />
                </cf-vstack>
                <cf-vstack gap="1" style="width: 220px;">
                  <cf-label>Room</cf-label>
                  <cf-select
                    $value={selectedRoom}
                    items={ROOM_ITEMS}
                    aria-label="Room"
                  />
                </cf-vstack>
              </cf-hstack>
            </cf-vstack>

            <cf-vscroll flex showScrollbar fadeEdges>
              <cf-vstack gap="3" padding="4">
                <cf-hstack gap="3">
                  <cf-card style="flex: 1; min-width: 120px;">
                    <cf-vstack slot="content" gap="1">
                      <cf-label>Lobby</cf-label>
                      <cf-heading level={3}>{lobbyCount}</cf-heading>
                    </cf-vstack>
                  </cf-card>
                  <cf-card style="flex: 1; min-width: 120px;">
                    <cf-vstack slot="content" gap="1">
                      <cf-label>Workshop</cf-label>
                      <cf-heading level={3}>{workshopCount}</cf-heading>
                    </cf-vstack>
                  </cf-card>
                  <cf-card style="flex: 1; min-width: 120px;">
                    <cf-vstack slot="content" gap="1">
                      <cf-label>Afterparty</cf-label>
                      <cf-heading level={3}>{afterpartyCount}</cf-heading>
                    </cf-vstack>
                  </cf-card>
                </cf-hstack>

                <section style={panelStyle}>
                  <cf-vstack gap="3" style="padding: 16px;">
                    <cf-hstack justify="between" align="center">
                      <cf-heading level={3}>{currentRoomLabel}</cf-heading>
                      <div style={metaTextStyle}>{messageCount} total</div>
                    </cf-hstack>

                    {messageCount === 0
                      ? (
                        <cf-card style="border-style: dashed;">
                          <cf-vstack slot="content" gap="1">
                            <cf-heading level={4}>No messages yet</cf-heading>
                            <div style={metaTextStyle}>
                              Start the room with a short note.
                            </div>
                          </cf-vstack>
                        </cf-card>
                      )
                      : (
                        <cf-vstack gap="2">
                          {messagesInSelectedRoom.map((message) => (
                            <cf-card style={messageStyle}>
                              <cf-vstack slot="content" gap="2">
                                <cf-hstack justify="between" align="center">
                                  <cf-label>{message.author}</cf-label>
                                  <span style={metaTextStyle}>
                                    {message.room}
                                  </span>
                                </cf-hstack>
                                <div
                                  style={{
                                    fontSize: "16px",
                                    lineHeight: "1.45",
                                    color: "var(--cf-theme-color-text)",
                                  }}
                                >
                                  {message.body}
                                </div>
                              </cf-vstack>
                            </cf-card>
                          ))}
                        </cf-vstack>
                      )}
                  </cf-vstack>
                </section>
              </cf-vstack>
            </cf-vscroll>

            <cf-hstack slot="footer" gap="3" align="end" style={composerStyle}>
              <cf-vstack gap="1" style="flex: 1;">
                <cf-label>Message</cf-label>
                <cf-textarea
                  $value={draft}
                  rows={2}
                  placeholder={`Message ${currentRoomLabel}`}
                  aria-label="Message draft"
                />
              </cf-vstack>
              <cf-button onClick={() => send.send({ submit: true })}>
                Send
              </cf-button>
            </cf-hstack>
          </cf-screen>
        </cf-theme>
      ),
      name,
      selectedRoom,
      conversation,
      draft,
      currentName,
      currentRoom,
      currentDraft,
      conversationSnapshot,
      messagesInSelectedRoom,
      messageCount,
      lobbyCount,
      workshopCount,
      afterpartyCount,
      lastLobbyAuthor,
      lastLobbyBody,
      lastWorkshopBody,
      sendMessage: send,
      setName: boundSetName,
      setDraft: boundSetDraft,
      selectRoom: boundSelectRoom,
    };
  },
);
