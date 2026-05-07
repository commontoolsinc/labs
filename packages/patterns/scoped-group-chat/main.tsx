import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface ChatMessage {
  author: string;
  body: string;
  sentAt: number;
}

export interface Room {
  name: string;
  messages: ChatMessage[] | Default<[]>;
}

type DefaultRooms = [
  { name: "Lobby"; messages: [] },
  { name: "Workshop"; messages: [] },
  { name: "Afterparty"; messages: [] },
];

export interface Conversation {
  rooms: Room[] | Default<DefaultRooms>;
}

export interface SelectedRoom {
  room?: Room;
}

interface ConversationSnapshot {
  rooms: readonly Room[];
}

export interface SendEvent {
  submit: true;
}

export interface SelectRoomEvent {
  roomIndex?: number;
  target?: { value?: string };
  detail?: { value?: string };
}

const DEFAULT_CONVERSATION = {
  rooms: [
    { name: "Lobby", messages: [] },
    { name: "Workshop", messages: [] },
    { name: "Afterparty", messages: [] },
  ],
} satisfies Conversation;

const DEFAULT_ROOMS = DEFAULT_CONVERSATION.rooms;

type NameCell = Writable<string | Default<"">>;
type SelectedRoomCell = Writable<SelectedRoom | Default<{}>>;
type ConversationCell = Writable<
  Conversation | Default<typeof DEFAULT_CONVERSATION>
>;
type DraftCell = Writable<string | Default<"">>;
type NewRoomNameCell = Writable<string | Default<"">>;

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

interface ScopedGroupChatInput {
  name?: PerUser<NameCell>;
  selectedRoom?: PerSession<SelectedRoomCell>;
  conversation?: PerSpace<ConversationCell>;
  draft?: PerUser<DraftCell>;
  newRoomName?: PerSession<NewRoomNameCell>;
}

interface ScopedGroupChatOutput {
  [NAME]: string;
  [UI]: VNode;
  name: PerUser<NameCell>;
  selectedRoom: PerSession<SelectedRoomCell>;
  conversation: PerSpace<ConversationCell>;
  draft: PerUser<DraftCell>;
  newRoomName: PerSession<NewRoomNameCell>;
  currentName: string;
  currentRoom: { room: Room };
  currentDraft: string;
  conversationSnapshot: ConversationSnapshot;
  messagesInSelectedRoom: readonly ChatMessage[];
  messageCount: number;
  roomCount: number;
  currentRoomMessageCount: number;
  lastRoomName: string;
  lastRoomMessageCount: number;
  lastCurrentRoomAuthor: string;
  lastCurrentRoomBody: string;
  roomItems: readonly { label: string; value: string }[];
  sendMessage: Stream<SendEvent>;
  addRoom: Stream<SendEvent>;
  setName: Stream<{ name: string }>;
  setDraft: Stream<{ draft: string }>;
  setNewRoomName: Stream<{ name: string }>;
  selectRoom: Stream<SelectRoomEvent>;
}

const sendMessage = handler<SendEvent, {
  name: NameCell;
  selectedRoom: SelectedRoomCell;
  conversation: ConversationCell;
  draft: DraftCell;
}>((_, { name, selectedRoom, conversation, draft }) => {
  const body = draft.get().trim();
  if (!body) return;

  const author = name.get().trim() || "Anonymous";
  const sentAt = safeDateNow();
  const message = {
    author,
    body,
    sentAt,
  };
  const selected = (selectedRoom.get() as SelectedRoom | undefined)?.room;
  const rooms = (conversation.get() as Conversation | undefined)?.rooms ?? [];
  const selectedIndex = selected
    ? rooms.findIndex((room) => room.name === selected.name)
    : 0;
  const targetRoom = conversation.key(
    "rooms",
    selectedIndex >= 0 ? selectedIndex : 0,
  );

  (targetRoom.key("messages") as Writable<ChatMessage[] | Default<[]>>).push(
    message,
  );
  draft.set("");
});

const addRoom = handler<SendEvent, {
  conversation: ConversationCell;
  selectedRoom: SelectedRoomCell;
  newRoomName: NewRoomNameCell;
}>((_, { conversation, selectedRoom, newRoomName }) => {
  const name = newRoomName.get().trim();
  if (!name) return;

  const rooms = (conversation.get() as Conversation | undefined)?.rooms ?? [];
  const nextIndex = rooms.length;
  conversation.key("rooms").push({ name, messages: [] });
  selectedRoom.set({ room: conversation.key("rooms", nextIndex) });
  newRoomName.set("");
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

const setNewRoomName = handler<
  { name: string },
  { newRoomName: Writable<string> }
>(
  ({ name }, { newRoomName }) => {
    newRoomName.set(name);
  },
);

const selectRoom = handler<
  SelectRoomEvent,
  { conversation: ConversationCell; selectedRoom: SelectedRoomCell }
>(
  (event, { conversation, selectedRoom }) => {
    const rawIndex = event.roomIndex ?? event.target?.value ??
      event.detail?.value;
    const index = typeof rawIndex === "number"
      ? rawIndex
      : parseInt(String(rawIndex ?? ""), 10);
    const rooms = (conversation.get() as Conversation | undefined)?.rooms ?? [];
    if (!Number.isFinite(index) || index < 0 || index >= rooms.length) return;

    selectedRoom.set({ room: conversation.key("rooms", index) });
  },
);

export default pattern<ScopedGroupChatInput, ScopedGroupChatOutput>(
  ({ name, selectedRoom, conversation, draft, newRoomName }) => {
    const send = sendMessage({
      name,
      selectedRoom,
      conversation,
      draft,
    });
    const boundAddRoom = addRoom({
      conversation,
      selectedRoom,
      newRoomName,
    });
    const boundSetName = setName({ name });
    const boundSetDraft = setDraft({ draft });
    const boundSetNewRoomName = setNewRoomName({ newRoomName });
    const boundSelectRoom = selectRoom({ conversation, selectedRoom });
    const currentName = computed(() => name.get());
    const currentDraft = computed(() => draft.get());
    const rooms: Room[] = computed(() =>
      (conversation.get() as Conversation | undefined)?.rooms ?? DEFAULT_ROOMS
    );
    const conversationSnapshot = computed(() => ({
      rooms,
    }));
    const currentRoom: { room: Room } = computed(() => ({
      room: (selectedRoom.get() as SelectedRoom | undefined)?.room ??
        rooms[0] ??
        DEFAULT_ROOMS[0],
    }));
    const messagesInSelectedRoom: ChatMessage[] = computed(() =>
      currentRoom.room.messages ?? []
    );
    const messageCount = computed(() => messagesInSelectedRoom.length);
    const currentRoomLabel = computed(() => currentRoom.room.name);
    const currentRoomIndex = computed(() => {
      const name = currentRoom.room.name;
      const index = rooms.findIndex((room) => room.name === name);
      return String(index < 0 ? 0 : index);
    });
    const roomItems = computed(() =>
      rooms.map((room, index) => ({
        label: room.name,
        value: String(index),
      }))
    );
    const messageCards = computed(() =>
      messagesInSelectedRoom.map((message) => (
        <cf-card style={messageStyle}>
          <cf-vstack slot="content" gap="2">
            <cf-hstack justify="between" align="center">
              <cf-label>{message.author}</cf-label>
              <span style={metaTextStyle}>{currentRoomLabel}</span>
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
      ))
    );
    const roomSummaryCards = computed(() =>
      rooms.map((room) => (
        <cf-card style="flex: 1; min-width: 120px;">
          <cf-vstack slot="content" gap="1">
            <cf-label>{room.name}</cf-label>
            <cf-heading level={3}>{room.messages?.length ?? 0}</cf-heading>
          </cf-vstack>
        </cf-card>
      ))
    );
    const roomCount = computed(() => rooms.length);
    const currentRoomMessageCount = computed(() =>
      messagesInSelectedRoom.length
    );
    const lastRoom = computed(() =>
      rooms[rooms.length - 1] ?? DEFAULT_ROOMS[0]
    );
    const lastRoomName = computed(() => lastRoom.name);
    const lastRoomMessageCount = computed(() => lastRoom.messages?.length ?? 0);
    const lastCurrentRoomAuthor = computed(() =>
      messagesInSelectedRoom[messagesInSelectedRoom.length - 1]?.author ?? ""
    );
    const lastCurrentRoomBody = computed(() =>
      messagesInSelectedRoom[messagesInSelectedRoom.length - 1]?.body ?? ""
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
                    $value={currentRoomIndex}
                    items={roomItems}
                    aria-label="Room"
                    onChange={boundSelectRoom}
                  />
                </cf-vstack>
                <cf-vstack gap="1" style="width: 280px;">
                  <cf-label>New room</cf-label>
                  <cf-hstack gap="2">
                    <cf-input
                      $value={newRoomName}
                      placeholder="Room name"
                      aria-label="New room name"
                    />
                    <cf-button
                      onClick={() => boundAddRoom.send({ submit: true })}
                    >
                      Add Room
                    </cf-button>
                  </cf-hstack>
                </cf-vstack>
              </cf-hstack>
            </cf-vstack>

            <cf-vscroll flex showScrollbar fadeEdges>
              <cf-vstack gap="3" padding="4">
                <cf-hstack gap="3">
                  {roomSummaryCards}
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
                          {messageCards}
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
      newRoomName,
      currentName,
      currentRoom,
      currentDraft,
      conversationSnapshot,
      messagesInSelectedRoom,
      messageCount,
      roomCount,
      currentRoomMessageCount,
      lastRoomName,
      lastRoomMessageCount,
      lastCurrentRoomAuthor,
      lastCurrentRoomBody,
      roomItems,
      sendMessage: send,
      addRoom: boundAddRoom,
      setName: boundSetName,
      setDraft: boundSetDraft,
      setNewRoomName: boundSetNewRoomName,
      selectRoom: boundSelectRoom,
    };
  },
);
