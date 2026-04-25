import {
  action,
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  SELF,
  Stream,
  UI,
  Writable,
} from "commonfabric";
import {
  createRandomImportedClaimedMessages,
  findParticipantBySlot,
  metaForSlot,
  type SlotId,
  sortDisplayMessages,
} from "./logic.ts";
import {
  commitTrustedMessageSend,
  messagesValue,
  participantsValue,
  type SharedChatMessage,
  type SharedMessagesCell,
  type SharedMessagesValue,
  type SharedParticipantsCell,
  type SharedParticipantsValue,
  TrustedChatSendSurface,
  TrustedProfileSaveSurface,
  VerifiedChatBubble0,
  VerifiedChatBubble1,
  VerifiedChatBubble2,
  VerifiedChatBubble3,
  VerifiedChatBubble4,
  VerifiedChatBubble5,
  VerifiedChatBubble6,
  VerifiedChatBubble7,
} from "./trusted.tsx";

type LobbyPiece = any;

const writeDraftText = handler<string, { value: Writable<string> }>(
  (nextValue, { value }) => {
    value.set(nextValue);
  },
);

const messageCountText = (count: number): string =>
  count === 0 ? "No messages yet" : `${count} message${count === 1 ? "" : "s"}`;

const sharedWritableOf = <Value,>(
  value: Value,
  name: string,
): Writable<Value> => Writable.of<Value>(value).for(name);

const transcriptRowStyle = (
  messageList: readonly SharedChatMessage[],
  viewerSlotId: SlotId,
  index: number,
) => {
  const message = messageList[index];
  const orderedIds = sortDisplayMessages(messageList).map((entry) => entry.id);
  const order = message ? orderedIds.indexOf(message.id) : index;
  return {
    display: message ? "block" : "none",
    order: order < 0 ? orderedIds.length : order,
    alignSelf: message?.author.id === viewerSlotId ? "flex-end" : "flex-start",
    width: "min(34rem, 100%)",
  };
};

interface ParticipantStatusChipInput {
  participants: SharedParticipantsCell;
  slotId: SlotId;
}

const ParticipantStatusChip = pattern<
  ParticipantStatusChipInput,
  { [NAME]: string; [UI]: any }
>((
  { participants, slotId }: ParticipantStatusChipInput,
): { [NAME]: string; [UI]: any } => {
  const statusLabel = computed(() => {
    const saved = findParticipantBySlot(
      participantsValue(participants),
      slotId,
    );
    return saved ? saved.name : "Profile pending";
  });

  return {
    [NAME]: computed(() => `${slotId} status chip`),
    [UI]: <cf-chip label={statusLabel} />,
  };
});

interface SharedTranscriptInput {
  messages: SharedMessagesCell;
  viewerSlotId: SlotId;
  id: string;
}

const SharedTranscript = pattern<
  SharedTranscriptInput,
  { [NAME]: string; [UI]: any }
>((
  { messages, viewerSlotId, id }: SharedTranscriptInput,
): { [NAME]: string; [UI]: any } => {
  const messageCountLabel = computed(() =>
    messageCountText(messagesValue(messages).length)
  );
  const rowStyle0 = computed(() =>
    transcriptRowStyle(messagesValue(messages), viewerSlotId, 0)
  );
  const rowStyle1 = computed(() =>
    transcriptRowStyle(messagesValue(messages), viewerSlotId, 1)
  );
  const rowStyle2 = computed(() =>
    transcriptRowStyle(messagesValue(messages), viewerSlotId, 2)
  );
  const rowStyle3 = computed(() =>
    transcriptRowStyle(messagesValue(messages), viewerSlotId, 3)
  );
  const rowStyle4 = computed(() =>
    transcriptRowStyle(messagesValue(messages), viewerSlotId, 4)
  );
  const rowStyle5 = computed(() =>
    transcriptRowStyle(messagesValue(messages), viewerSlotId, 5)
  );
  const rowStyle6 = computed(() =>
    transcriptRowStyle(messagesValue(messages), viewerSlotId, 6)
  );
  const rowStyle7 = computed(() =>
    transcriptRowStyle(messagesValue(messages), viewerSlotId, 7)
  );

  return {
    [NAME]: computed(() => `${id} transcript`),
    [UI]: (
      <cf-vstack id={id} gap="3">
        <cf-label>{messageCountLabel}</cf-label>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            maxHeight: "min(52vh, 32rem)",
            overflowY: "auto",
            overscrollBehavior: "contain",
            paddingRight: "0.25rem",
          }}
        >
          <div style={rowStyle0}>
            {VerifiedChatBubble0({ messages, viewerSlotId })}
          </div>
          <div style={rowStyle1}>
            {VerifiedChatBubble1({ messages, viewerSlotId })}
          </div>
          <div style={rowStyle2}>
            {VerifiedChatBubble2({ messages, viewerSlotId })}
          </div>
          <div style={rowStyle3}>
            {VerifiedChatBubble3({ messages, viewerSlotId })}
          </div>
          <div style={rowStyle4}>
            {VerifiedChatBubble4({ messages, viewerSlotId })}
          </div>
          <div style={rowStyle5}>
            {VerifiedChatBubble5({ messages, viewerSlotId })}
          </div>
          <div style={rowStyle6}>
            {VerifiedChatBubble6({ messages, viewerSlotId })}
          </div>
          <div style={rowStyle7}>
            {VerifiedChatBubble7({ messages, viewerSlotId })}
          </div>
        </div>
      </cf-vstack>
    ),
  };
});

export interface ParticipantRoomInput {
  slotId: SlotId;
  participants: SharedParticipantsCell;
  messages: SharedMessagesCell;
  lobbyPiece: LobbyPiece | null | Default<null>;
}

export interface ParticipantRoomOutput {
  [NAME]: string;
  [UI]: any;
  slotId: SlotId;
  setProfileDraft: Stream<string>;
  saveProfile: Stream<void>;
  setMessageDraft: Stream<string>;
  sendTrustedMessage: Stream<void>;
}

export const ParticipantRoom = pattern<
  ParticipantRoomInput,
  ParticipantRoomOutput
>((
  {
    slotId,
    participants,
    messages,
    lobbyPiece,
  }: ParticipantRoomInput,
): ParticipantRoomOutput => {
  const meta = metaForSlot(slotId);
  const profileDraft = Writable.of("");
  const trustedMessageDraft = Writable.of("");
  const hostMessageDraft = Writable.of("");
  const setProfileDraft = writeDraftText({ value: profileDraft });
  const setMessageDraft = writeDraftText({ value: trustedMessageDraft });
  const trustedProfileSave = TrustedProfileSaveSurface({
    slotId,
    nameDraft: profileDraft,
    participants,
  });
  const trustedSend = TrustedChatSendSurface({
    slotId,
    messageDraft: trustedMessageDraft,
    participants,
    messages,
  });
  const currentProfileLabel = computed(() => {
    const saved = findParticipantBySlot(
      participantsValue(participants),
      slotId,
    );
    return saved ? saved.name : "Name not set";
  });
  const hostLookalikeSend = commitTrustedMessageSend({
    slotId,
    messageDraft: hostMessageDraft,
    participants,
    messages,
  });
  const hostSendDisabled = computed(() =>
    hostMessageDraft.get().trim().length === 0
  );
  const addRandomMessagesDisabled = computed(() =>
    participantsValue(participants).length === 0 ||
    messagesValue(messages).length === 0
  );
  const addRandomMessages = action(() => {
    const nextMessages = createRandomImportedClaimedMessages(
      sortDisplayMessages(messagesValue(messages)),
      participantsValue(participants),
    );
    nextMessages.forEach((message) =>
      messages.push(message as SharedChatMessage)
    );
  });
  const goBackToLobby = action(() => {
    if (lobbyPiece) {
      return navigateTo(lobbyPiece);
    }
  });
  const shouldShowBackButton = Boolean(lobbyPiece);

  return {
    [NAME]: computed(() => `${meta.label} room`),
    [UI]: (
      <cf-screen title={`${meta.label} room`}>
        <cf-vstack gap="4" style={{ padding: "1rem" }}>
          <cf-hstack justify="between" align="center" wrap>
            <cf-vstack gap="1">
              <cf-heading level={2}>{meta.label}</cf-heading>
              <cf-label>Current name: {currentProfileLabel}</cf-label>
            </cf-vstack>
            {shouldShowBackButton
              ? (
                <cf-button
                  id={`back-to-lobby-${slotId}`}
                  variant="ghost"
                  onClick={goBackToLobby}
                >
                  Back to lobby
                </cf-button>
              )
              : null}
          </cf-hstack>
          {trustedProfileSave}
          <cf-card id={`chat-panel-${slotId}`}>
            <cf-vstack slot="content" gap="3">
              {SharedTranscript({
                messages,
                viewerSlotId: slotId,
                id: `trusted-conversation-preview-${slotId}`,
              })}
              {trustedSend}
            </cf-vstack>
          </cf-card>
          <cf-card id={`host-send-panel-${slotId}`}>
            <cf-hstack slot="content" gap="2" align="center" wrap>
              <cf-vgroup
                gap="sm"
                style={{ minWidth: "16rem", flex: "1 1 16rem" }}
              >
                <cf-input
                  id={`host-message-draft-${slotId}`}
                  size="sm"
                  $value={hostMessageDraft}
                  placeholder="Write a message"
                />
              </cf-vgroup>
              <cf-button
                id={`host-send-button-${slotId}`}
                disabled={hostSendDisabled}
                onClick={hostLookalikeSend}
              >
                Send
              </cf-button>
            </cf-hstack>
          </cf-card>
          <cf-button
            id={`add-random-messages-${slotId}`}
            size="lg"
            style={{ width: "100%" }}
            disabled={addRandomMessagesDisabled}
            onClick={addRandomMessages}
          >
            Insert fake messages
          </cf-button>
        </cf-vstack>
      </cf-screen>
    ),
    slotId,
    setProfileDraft,
    saveProfile: trustedProfileSave.saveProfile,
    setMessageDraft,
    sendTrustedMessage: trustedSend.sendMessage,
  };
});

const openGroupChatRoom = handler<
  unknown,
  {
    slotId: SlotId;
    participants: SharedParticipantsCell;
    messages: SharedMessagesCell;
    lobbyPiece: LobbyPiece;
  }
>((_, { slotId, participants, messages, lobbyPiece }) => {
  const room = ParticipantRoom({
    slotId,
    participants,
    messages,
    lobbyPiece,
  });
  return navigateTo(room);
});

export interface GroupChatDemoOutput {
  [NAME]: string;
  [UI]: any;
}

export default pattern<unknown, GroupChatDemoOutput>(({
  [SELF]: self,
}): GroupChatDemoOutput => {
  const participants = sharedWritableOf<SharedParticipantsValue>(
    [] as SharedParticipantsValue,
    "participants",
  ) as SharedParticipantsCell;
  const messages = sharedWritableOf<SharedMessagesValue>(
    [] as SharedMessagesValue,
    "messages",
  ) as SharedMessagesCell;
  const openParticipantOne = openGroupChatRoom({
    slotId: "participant-1",
    participants,
    messages,
    lobbyPiece: self,
  });
  const openParticipantTwo = openGroupChatRoom({
    slotId: "participant-2",
    participants,
    messages,
    lobbyPiece: self,
  });
  const openParticipantThree = openGroupChatRoom({
    slotId: "participant-3",
    participants,
    messages,
    lobbyPiece: self,
  });

  return {
    [NAME]: "CFC group chat demo",
    [UI]: (
      <cf-screen title="CFC group chat demo">
        <cf-vstack id="group-chat-lobby" gap="4" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>Group chat</cf-heading>
              <cf-label>
                The chat shell is ordinary pattern code. Small reviewed
                components save profiles, send messages, and render verified
                author bubbles.
              </cf-label>
              <cf-hstack gap="2" wrap>
                <cf-chip
                  label={computed(() =>
                    `${participantsValue(participants).length} profile${
                      participantsValue(participants).length === 1 ? "" : "s"
                    }`
                  )}
                />
                <cf-chip
                  label={computed(() =>
                    messageCountText(messagesValue(messages).length)
                  )}
                />
              </cf-hstack>
            </cf-vstack>
          </cf-card>
          <cf-grid columns="3" gap="4">
            <cf-card id="lobby-slot-participant-1">
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>Participant 1</cf-heading>
                {ParticipantStatusChip({
                  participants,
                  slotId: "participant-1",
                })}
                <cf-button
                  id="open-room-participant-1"
                  onClick={openParticipantOne}
                >
                  Open room
                </cf-button>
              </cf-vstack>
            </cf-card>
            <cf-card id="lobby-slot-participant-2">
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>Participant 2</cf-heading>
                {ParticipantStatusChip({
                  participants,
                  slotId: "participant-2",
                })}
                <cf-button
                  id="open-room-participant-2"
                  onClick={openParticipantTwo}
                >
                  Open room
                </cf-button>
              </cf-vstack>
            </cf-card>
            <cf-card id="lobby-slot-participant-3">
              <cf-vstack slot="content" gap="3">
                <cf-heading level={3}>Participant 3</cf-heading>
                {ParticipantStatusChip({
                  participants,
                  slotId: "participant-3",
                })}
                <cf-button
                  id="open-room-participant-3"
                  onClick={openParticipantThree}
                >
                  Open room
                </cf-button>
              </cf-vstack>
            </cf-card>
          </cf-grid>
        </cf-vstack>
      </cf-screen>
    ),
  };
});
