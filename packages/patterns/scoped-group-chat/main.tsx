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

export interface Conversation {
  rooms: Room[] | Default<[]>;
}

export interface SelectedRoom {
  room?: Room;
}

interface ConversationSnapshot {
  rooms: readonly Room[];
}

interface RoomSummary {
  name: string;
  messageCount: number;
}

export interface SendMessageEvent {
  message?: string;
  room?: Room;
}

export interface AddRoomEvent {
  name?: string;
}

export interface SelectRoomEvent {
  roomIndex?: number;
  target?: { value?: string };
  detail?: { value?: string };
}

const DEFAULT_CONVERSATION = {
  rooms: [],
} satisfies Conversation;

const EMPTY_ROOM = { name: "", messages: [] } satisfies Room;

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

const sendMessage = handler<SendMessageEvent, {
  name: NameCell;
  selectedRoom: SelectedRoomCell;
  conversation: ConversationCell;
  draft: DraftCell;
}>(({ message, room }, { name, selectedRoom, conversation, draft }) => {
  const body = (message ?? draft.get()).trim();
  if (!body) return;

  const author = name.get().trim() || "Anonymous";
  const sentAt = safeDateNow();
  const rooms = (conversation.get() as Conversation | undefined)?.rooms ?? [];
  if (rooms.length === 0) return;

  const roomRef = room ?? selectedRoom.key("room");
  const targetIndex = rooms.findIndex((_candidate, index) =>
    conversation.key("rooms", index).equals(roomRef)
  );
  if (targetIndex < 0) return;

  (conversation.key(
    "rooms",
    targetIndex,
    "messages",
  ) as Writable<ChatMessage[] | Default<[]>>).push({
    author,
    body,
    sentAt,
  });
  draft.set("");
});

const addRoom = handler<AddRoomEvent, {
  conversation: ConversationCell;
  selectedRoom: SelectedRoomCell;
  newRoomName: NewRoomNameCell;
}>(({ name: eventName }, { conversation, selectedRoom, newRoomName }) => {
  const name = (eventName ?? newRoomName.get()).trim();
  if (!name) return;

  const rooms = (conversation.get() as Conversation | undefined)?.rooms ?? [];
  const nextIndex = rooms.length;
  conversation.key("rooms").push({ name, messages: [] });
  selectedRoom.set({ room: conversation.key("rooms", nextIndex) });
  newRoomName.set("");
});

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
  roomSummaries: readonly RoomSummary[];
  roomSummaryText: string;
  sendMessage: Stream<SendMessageEvent>;
  addRoom: Stream<AddRoomEvent>;
  setName: Stream<{ name: string }>;
  setDraft: Stream<{ draft: string }>;
  setNewRoomName: Stream<{ name: string }>;
  selectRoom: Stream<SelectRoomEvent>;
}

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
      (conversation.get() as Conversation | undefined)?.rooms ?? []
    );
    const conversationSnapshot = computed(() => ({
      rooms,
    }));
    const currentRoom: { room: Room } = computed(() => ({
      room: (selectedRoom.get() as SelectedRoom | undefined)?.room ??
        rooms[0] ??
        EMPTY_ROOM,
    }));
    const selectedRoomRef = selectedRoom.key("room");
    const selectedRoomIndex = computed(() => {
      const index = rooms.findIndex((_room, roomIndex) =>
        conversation.key("rooms", roomIndex).equals(selectedRoomRef)
      );
      return index < 0 ? 0 : index;
    });
    const messagesInSelectedRoom = computed<readonly ChatMessage[]>(() =>
      rooms[selectedRoomIndex]?.messages ?? []
    );
    const messageCount = computed(() =>
      rooms[selectedRoomIndex]?.messages?.length ?? 0
    );
    const currentRoomLabel = computed(() =>
      rooms[selectedRoomIndex]?.name ?? currentRoom.room.name ?? "No room"
    );
    const displayedRoomLabel = computed(() => currentRoomLabel || "No room");
    const currentRoomIndex = computed(() =>
      rooms.length === 0 ? "" : String(selectedRoomIndex)
    );
    const send = sendMessage({
      name,
      selectedRoom,
      conversation,
      draft,
    });
    const roomItems = computed(() =>
      rooms.map((room, index) => ({
        label: room.name,
        value: String(index),
      }))
    );
    const roomSummaries = computed<readonly RoomSummary[]>(() =>
      rooms.map((room) => ({
        name: room.name,
        messageCount: room.messages?.length ?? 0,
      }))
    );
    const roomSummaryText = computed(() =>
      rooms
        .map((room) => `${room.name}: ${room.messages?.length ?? 0}`)
        .join("\n")
    );
    const roomCount = computed(() => rooms.length);
    const currentRoomMessageCount = messageCount;
    const lastRoom = computed(() => rooms[rooms.length - 1] ?? EMPTY_ROOM);
    const lastRoomName = computed(() => lastRoom.name);
    const lastRoomMessageCount = computed(() => lastRoom.messages?.length ?? 0);
    const lastCurrentRoomAuthor = computed(() => {
      const messages = rooms[selectedRoomIndex]?.messages ?? [];
      return messages[messages.length - 1]?.author ?? "";
    });
    const lastCurrentRoomBody = computed(() => {
      const messages = rooms[selectedRoomIndex]?.messages ?? [];
      return messages[messages.length - 1]?.body ?? "";
    });
    const selectedRoomTranscript = computed(() => {
      const messages = rooms[selectedRoomIndex]?.messages ?? [];
      return messages
        .map((message) => `${message.author}: ${message.body}`)
        .join("\n");
    });

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
                    {messageCount} messages in {displayedRoomLabel}
                  </div>
                </div>
                <cf-hstack gap="2" align="center">
                  <cf-badge color="neutral" variant="outline">
                    {displayedRoomLabel}
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
                    timing-strategy="immediate"
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
                  <cf-message-input
                    placeholder="Room name"
                    button-text="Add Room"
                    oncf-send={(e: { detail?: { message?: string } }) => {
                      const roomName = e.detail?.message?.trim();
                      if (roomName) boundAddRoom.send({ name: roomName });
                    }}
                  />
                </cf-vstack>
              </cf-hstack>
            </cf-vstack>

            <cf-vscroll flex showScrollbar fadeEdges>
              <cf-vstack gap="3" padding="4">
                <cf-hstack gap="3">
                  {rooms.map((room, roomIndex) => (
                    <cf-card style="flex: 1; min-width: 120px;">
                      <cf-vstack slot="content" gap="1">
                        <cf-label>{room.name}</cf-label>
                        <cf-heading level={3}>
                          {roomIndex === selectedRoomIndex
                            ? messageCount
                            : room.messages?.length ?? 0}
                        </cf-heading>
                      </cf-vstack>
                    </cf-card>
                  ))}
                </cf-hstack>

                <section style={panelStyle}>
                  <cf-vstack gap="3" style="padding: 16px;">
                    <cf-hstack justify="between" align="center">
                      <cf-heading level={3}>{displayedRoomLabel}</cf-heading>
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
                          <cf-card style={messageStyle}>
                            <cf-vstack slot="content" gap="2">
                              <cf-hstack justify="between" align="center">
                                <cf-label>{currentRoomLabel}</cf-label>
                                <span style={metaTextStyle}>
                                  {messageCount} total
                                </span>
                              </cf-hstack>
                              <div
                                style={{
                                  fontSize: "16px",
                                  lineHeight: "1.5",
                                  color: "var(--cf-theme-color-text)",
                                  whiteSpace: "pre-wrap",
                                }}
                              >
                                {selectedRoomTranscript}
                              </div>
                            </cf-vstack>
                          </cf-card>
                        </cf-vstack>
                      )}
                  </cf-vstack>
                </section>
              </cf-vstack>
            </cf-vscroll>

            <cf-hstack slot="footer" gap="3" align="end" style={composerStyle}>
              <cf-vstack gap="1" style="flex: 1;">
                <cf-label>Message</cf-label>
                <cf-message-input
                  placeholder={`Message ${displayedRoomLabel}`}
                  button-text="Send"
                  oncf-send={(e: { detail?: { message?: string } }) => {
                    const message = e.detail?.message?.trim();
                    if (message) {
                      send.send({
                        message,
                        room: currentRoom.room,
                      });
                    }
                  }}
                />
              </cf-vstack>
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
      roomSummaries,
      roomSummaryText,
      sendMessage: send,
      addRoom: boundAddRoom,
      setName: boundSetName,
      setDraft: boundSetDraft,
      setNewRoomName: boundSetNewRoomName,
      selectRoom: boundSelectRoom,
    };
  },
);
